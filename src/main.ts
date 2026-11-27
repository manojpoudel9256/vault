import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';

import { append, fmtDate, h, reducedMotion, relDays, scramble, shake, toast, transition } from './dom';
import { extractFromImage, geminiMatch, prepareImage } from './gemini';
import { appLogo, icon, brandFor, logoSvg, setLogoSource, type IconName } from './icons';
import { parseLogoPack } from './logos';
import { interpret, parseQuery, search } from './search';
import { passphraseProblem, strength } from './strength';
import { sortEntries, timeGroup, type SortMode } from './sort';
import { CATEGORIES, cat, entryIconName, inferCategory, typeFor, type Category } from './categories';
import {
  createFacePasskey, disableFaceId, faceIdAvailable, faceIdEnabled, faceIdState, finishFaceId, notePassphraseUnlock, passphraseFromFaceId,
  type PendingPasskey,
} from './faceid';
import {
  changePassphrase, checkPassphrase, createVault, deleteEntry, destroyVault, findExisting, hasVault, isUnlocked, lock, makeBackup,
  openBackup, parseBackup, restoreAsNewVault, restoreInto, reusedBy, reusedEntries, save, unlock, upsertEntry, vault,
  type Entry, type EntryInput, type SecretType,
} from './vault';

/** An entry being reviewed before it is saved (screenshot import). */
interface Draft { category?: Category; service: string; account: string; tags?: string[]; type: SecretType; secret: string; notes: string }

// Private logos live in the unlocked vault; nothing is shown while it is locked.
setLogoSource(() => (isUnlocked() ? vault().settings.logos : []));

type View = 'boot' | 'setup' | 'lock' | 'main' | 'import' | 'settings';

const root = document.getElementById('app')!;
const ui = {
  view: 'boot' as View,
  query: '',
  category: 'all' as Category | 'all',
  expanded: new Set<string>(),
  ai: null as null | { status: 'loading' | 'done' | 'error'; ids: string[]; msg?: string },
  aiAbort: null as AbortController | null,
  setupMode: 'create' as 'create' | 'restore',
  drafts: null as null | (Draft & { include: boolean; confidence?: 'high' | 'low' })[],
  skipped: [] as string[],
  shot: null as null | string, // screenshot being imported (data URL, kept in memory only)
  reusedOnly: false, // list filtered to entries that share a password or PIN
  suspendLock: false,
  failures: 0,
  lockedUntil: 0,
};

// ---------------------------------------------------------------- navigation

function show(view: View): void {
  const changed = ui.view !== view;
  ui.view = view;
  transition(() => {
    render();
    if (changed) window.scrollTo(0, 0);
  });
}

function render(): void {
  const views: Record<View, () => HTMLElement> = {
    boot: () => h('div', { class: 'view boot' }),
    setup: setupView,
    lock: lockView,
    main: mainView,
    import: importView,
    settings: settingsView,
  };
  const view = views[ui.view]();
  root.replaceChildren(view);
  // Fixed bars must live outside the animated view (a transform would re-anchor them).
  root.append(...view.querySelectorAll('.dock'));
}

// ---------------------------------------------------------------- keyboard awareness (iOS)
// Tracks the on-screen keyboard so sheets sit above it and the floating dock hides while typing.

const vv = window.visualViewport;
const lastVars: Record<string, string> = {};
/** Sets a CSS variable only when it really changed: rewriting it on every scroll frame makes iPhone repaint and flicker. */
function setVar(name: string, value: string): void {
  if (lastVars[name] === value) return;
  lastVars[name] = value;
  document.documentElement.style.setProperty(name, value);
}
let vvFrame = 0;
function syncViewport(): void {
  if (vvFrame) return;
  vvFrame = requestAnimationFrame(() => {
    vvFrame = 0;
    const height = vv ? vv.height : window.innerHeight;
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    setVar('--vvh', `${Math.round(height)}px`);
    setVar('--kb', `${Math.round(kb)}px`);
    // Lock screen only: when the keyboard opens, iOS nudges the page up even if the field is
    // already visible, which pushed the logo under the notch. Move the content back down by the
    // same amount so it stays exactly where it was. (Not on scrolling screens: that flickered.)
    const nudge = ui.view === 'lock' && vv ? Math.max(0, Math.round(vv.offsetTop + window.scrollY)) : 0;
    setVar('--gate-shift', `${nudge}px`);
    syncTyping();
  });
}
const isTypingTarget = (a: Element | null): boolean => !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
  || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'button', 'submit'].includes((a as HTMLInputElement).type)));

// The compact "typing" layout turns on at once, but turns off only after a short pause: tapping
// "Unlock" while the keyboard is up moves focus off the field (some browsers focus the button),
// and an instant re-layout would move the button away before the tap lands.
let typingOff = 0;
function syncTyping(): void {
  clearTimeout(typingOff);
  if (isTypingTarget(document.activeElement)) { document.body.classList.add('is-typing'); return; }
  typingOff = window.setTimeout(() => {
    if (!isTypingTarget(document.activeElement)) document.body.classList.remove('is-typing');
  }, 350);
}
vv?.addEventListener('resize', syncViewport);
vv?.addEventListener('scroll', syncViewport);
addEventListener('scroll', () => { if (ui.view === 'lock') syncViewport(); }, { passive: true });
// Like iPhone's own apps: starting to scroll the results closes the search keyboard.
// With the keyboard open iOS shifts the whole page while scrolling, which made the top flicker.
document.addEventListener('touchmove', (e) => {
  const a = document.activeElement as HTMLElement | null;
  if (a?.classList.contains('ask-input') && !(e.target as Element | null)?.closest?.('.ask')) a.blur();
}, { passive: true });
document.addEventListener('focusin', syncTyping);
document.addEventListener('focusout', () => setTimeout(syncTyping, 0));
syncViewport();

// ---------------------------------------------------------------- auto-lock

let lastActive = Date.now();
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'input']) addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true });

setInterval(() => {
  if (isUnlocked() && !ui.suspendLock && Date.now() - lastActive > vault().settings.autoLockMinutes * 60_000) doLock();
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && isUnlocked() && !ui.suspendLock) doLock();
});

function doLock(): void {
  lock();
  ui.query = '';
  ui.expanded.clear();
  ui.ai = null;
  ui.aiAbort?.abort();
  ui.drafts = null;
  ui.skipped = [];
  ui.shot = null;
  document.querySelectorAll('.sheet, .sheet-backdrop').forEach((n) => n.remove());
  document.body.classList.remove('sheet-open');
  unlockPage();
  show('lock');
}

/**
 * iOS hides the page while its file picker is open, which would lock the vault mid-pick.
 * Auto-lock pauses only until you are back in Vault (a file was chosen, the picker was cancelled,
 * or the page has focus again), and never for more than 20 seconds.
 */
function pauseLockForPicker(input: HTMLInputElement): void {
  ui.suspendLock = true;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    ui.suspendLock = false;
    lastActive = Date.now();
    input.removeEventListener('cancel', end);
    input.removeEventListener('change', end);
    removeEventListener('focus', onFocus);
    // If the page is still hidden when the pause ends, lock now.
    if (document.hidden && isUnlocked()) doLock();
  };
  const onFocus = () => setTimeout(end, 500);
  input.addEventListener('cancel', end);
  input.addEventListener('change', end);
  addEventListener('focus', onFocus);
  setTimeout(end, 20_000);
}

/** iOS may hide the page while the share sheet or file picker is open; don't lock during that. */
async function withLockSuspended<T>(fn: () => Promise<T>): Promise<T> {
  ui.suspendLock = true;
  try { return await fn(); } finally { ui.suspendLock = false; lastActive = Date.now(); }
}

// ---------------------------------------------------------------- shared pieces

function iconBtn(name: IconName, label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: 'icon-btn ' + cls, type: 'button', 'aria-label': label, title: label, onclick }, icon(name));
}

function btn(label: string, onclick: (e: MouseEvent) => void, opts: { kind?: 'primary' | 'secondary' | 'ghost' | 'danger'; ic?: IconName; type?: string } = {}): HTMLButtonElement {
  return h('button', { class: `btn btn-${opts.kind ?? 'secondary'}`, type: opts.type ?? 'button', onclick }, opts.ic ? icon(opts.ic) : null, h('span', {}, label));
}

function field(label: string, input: HTMLElement, help?: string, id?: string): HTMLElement {
  const fid = id ?? 'f-' + Math.random().toString(36).slice(2, 8);
  input.id = fid;
  return h('div', { class: 'field' }, h('label', { for: fid, class: 'field-label' }, label), input, help ? h('p', { class: 'field-help' }, help) : null);
}

function input(props: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { class: 'input', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', ...props });
}

function topbar(left: Node, actions: Node[] = []): HTMLElement {
  return h('header', { class: 'topbar' }, left, h('div', { class: 'topbar-actions' }, actions));
}

// Text size setting: scales every font size in style.css through --fs.
type TextSize = 'xs' | 's' | 'm' | 'l' | 'xl';
const TEXT_SCALE: Record<TextSize, number> = { xs: 0.74, s: 0.82, m: 0.9, l: 1, xl: 1.1 };
const TEXT_KEY = 'memo-vault:text-size';
function textSize(): TextSize {
  try { const t = localStorage.getItem(TEXT_KEY); if (t && t in TEXT_SCALE) return t as TextSize; } catch { /* storage blocked */ }
  return 'm';
}
function setTextSize(t: TextSize, store = true): void {
  document.documentElement.style.setProperty('--fs', String(TEXT_SCALE[t]));
  if (store) try { localStorage.setItem(TEXT_KEY, t); } catch { /* storage blocked */ }
}
setTextSize(textSize(), false);

// List order: newest first unless changed (remembered on this device; not a secret).
const SORT_KEY = 'memo-vault:sort';
function sortMode(): SortMode {
  try { const m = localStorage.getItem(SORT_KEY); if (m === 'newest' || m === 'az' || m === 'type') return m; } catch { /* storage blocked */ }
  return 'newest';
}
function setSortMode(m: SortMode): void {
  try { localStorage.setItem(SORT_KEY, m); } catch { /* storage blocked */ }
}

// Light / dark theme. Follows the iPhone setting until the sun/moon switch in Settings is used.
type Theme = 'light' | 'dark';
const THEME_KEY = 'memo-vault:theme';
const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function savedTheme(): Theme | null {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; } catch { return null; }
}
const currentTheme = (): Theme => savedTheme() ?? systemTheme();
function applyTheme(t: Theme | null): void {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  // Status bar / browser chrome colour follows the theme too.
  const color = (t ?? systemTheme()) === 'light' ? '#f3f4f6' : '#0c0e11';
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => { m.content = color; });
}
function setTheme(t: Theme): void {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage blocked */ }
  applyTheme(t);
}
applyTheme(savedTheme());
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (!savedTheme()) applyTheme(null); });

/** Sun in dark mode (tap for light), moon in light mode (tap for dark). */
function themeButton(): HTMLButtonElement {
  const label = () => (currentTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  const b: HTMLButtonElement = iconBtn(currentTheme() === 'dark' ? 'sun' : 'moon', label(), () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    transition(() => setTheme(next));
    b.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon'));
    b.setAttribute('aria-label', label());
    b.title = label();
    toast(next === 'dark' ? 'Dark mode' : 'Light mode');
  }, 'theme-btn');
  return b;
}

function backButton(): HTMLElement {
  return h('button', { class: 'back', type: 'button', onclick: () => show('main') }, icon('caret-left'), h('span', {}, 'Vault'));
}

/** Brand logo for known services, otherwise the category's icon. */
function tile(service: string, category: Category = 'login', size: 'sm' | 'lg' = 'sm', account = ''): HTMLElement {
  const brand = brandFor(service);
  if (brand) {
    const g = brand.glyph;
    const glyph = typeof g === 'string' ? icon(g)
      : 'path' in g ? logoSvg(g.path)
        : 'img' in g ? h('img', { src: g.img, alt: '', class: 'tile-img' + (g.full ? ' is-full' : ''), decoding: 'async', draggable: 'false' })
          : h('span', { class: 'tile-letter' }, g.letter);
    return h('span', { class: `tile tile-${size} tile-brand`, 'data-cat': category, 'aria-hidden': 'true', style: { background: brand.bg, color: brand.ink } }, glyph);
  }
  return h('span', { class: `tile tile-${size}`, 'data-cat': category, 'aria-hidden': 'true' }, icon(entryIconName(category, service, account)));
}

/** Small label on the right of a row. Only shown where it helps tell entries apart. */
const typeLabel = (e: Pick<Entry, 'type' | 'category'>): string | null =>
  e.category === 'card' ? (e.type === 'pin' ? 'CVV' : 'Card no.')
    : e.type === 'pin' ? 'PIN' : e.category === 'bank' ? (e.type === 'number' ? 'Account no.' : 'Password') : null;

function segmented<T extends string>(options: [T, string][], value: T, onchange: (v: T) => void, label: string): HTMLElement {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const buttons = options.map(([v, text]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: 'seg' }, text));
  group.style.setProperty('--seg-count', String(options.length));
  group.style.setProperty('--seg-index', String(Math.max(0, options.findIndex(([o]) => o === value))));
  append(group, [h('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...buttons]);
  buttons.forEach((el, i) => {
    el.onclick = () => {
      buttons.forEach((o) => o.setAttribute('aria-checked', 'false'));
      el.setAttribute('aria-checked', 'true');
      group.style.setProperty('--seg-index', String(i));
      onchange(options[i][0]);
    };
  });
  return group;
}

function toggle(checked: boolean, onchange: (v: boolean) => void, label: string): HTMLElement {
  const inp = h('input', { type: 'checkbox', class: 'switch-input', checked, 'aria-label': label, onchange: () => onchange(inp.checked) });
  return h('label', { class: 'switch' }, inp, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })));
}

function strengthMeter(): { el: HTMLElement; update: (p: string) => void } {
  const label = h('span', { class: 'meter-label' }, '');
  const el = h('div', { class: 'meter', 'data-level': '0' }, h('div', { class: 'meter-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')), label);
  const names = ['', 'Too short', 'Okay', 'Strong', 'Very strong'];
  return {
    el,
    update: (p) => { const s = strength(p); el.dataset.level = String(s); label.textContent = names[s]; },
  };
}

function busy(button: HTMLButtonElement, text: string): () => void {
  const prev = Array.from(button.childNodes);
  button.disabled = true;
  button.classList.add('is-busy');
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, text));
  return () => { button.disabled = false; button.classList.remove('is-busy'); button.replaceChildren(...prev); };
}

async function requestPersistence(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
}

// ---------------------------------------------------------------- setup

function setupView(): HTMLElement {
  const wrap = h('main', { class: 'view gate' });
  const hero = h('div', { class: 'gate-hero' },
    h('div', { class: 'gate-lock' }, appLogo()),
    h('h1', { class: 'gate-title' }, ui.setupMode === 'create' ? 'Create your vault' : 'Restore your vault'),
    h('p', { class: 'gate-sub' }, ui.setupMode === 'create'
      ? 'Your passwords are encrypted on this iPhone with a passphrase only you know.'
      : 'Open a backup file and enter the passphrase it was made with.'),
  );

  if (ui.setupMode === 'create') {
    const p1 = input({ type: 'password', autocomplete: 'new-password', enterkeyhint: 'next' });
    const p2 = input({ type: 'password', autocomplete: 'new-password', enterkeyhint: 'done' });
    const meter = strengthMeter();
    const err = h('p', { class: 'field-error', id: 'setup-err', role: 'alert' });
    p1.addEventListener('input', () => meter.update(p1.value));
    const submit = btn('Create vault', () => {}, { kind: 'primary', type: 'submit' });
    const form = h('form', {
      class: 'gate-form', onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = '';
        const weak1 = passphraseProblem(p1.value);
        if (weak1) { err.textContent = weak1; shake(p1); return; }
        if (p1.value !== p2.value) { err.textContent = 'The two passphrases do not match.'; shake(p2); return; }
        const done = busy(submit, 'Encrypting');
        try {
          await createVault(p1.value);
          await requestPersistence();
          show('main');
        } catch (x) {
          done();
          err.textContent = 'Could not create the vault: ' + (x as Error).message;
        }
      },
    },
      field('Master passphrase', p1),
      meter.el,
      field('Type it again', p2),
      h('div', { class: 'notice notice-warn' }, icon('warning'), h('p', {}, h('strong', {}, 'There is no reset. '), 'If you forget this passphrase, nobody can recover your data. Write it down and keep it somewhere safe.')),
      err,
      submit,
    );
    append(wrap, [hero, form, h('button', { class: 'link', type: 'button', onclick: () => { ui.setupMode = 'restore'; show('setup'); } }, 'I have a backup file')]);
  } else {
    let file: string | null = null;
    const fileName = h('span', { class: 'file-name' }, 'No file chosen');
    const fileInput = h('input', {
      type: 'file', class: 'visually-hidden', accept: '.json,application/json', onchange: async () => {
        const f = fileInput.files?.[0];
        ui.suspendLock = false;
        if (!f) return;
        file = await f.text();
        fileName.textContent = f.name;
      },
    });
    const pick = h('label', { class: 'file-pick' }, fileInput, icon('file-arrow-up'), h('span', {}, 'Choose backup file'), fileName);
    const pass = input({ type: 'password', autocomplete: 'off', enterkeyhint: 'next' });
    const np1 = input({ type: 'password', autocomplete: 'new-password', enterkeyhint: 'next' });
    const np2 = input({ type: 'password', autocomplete: 'new-password', enterkeyhint: 'go' });
    const meter = strengthMeter();
    np1.addEventListener('input', () => meter.update(np1.value));
    const err = h('p', { class: 'field-error', role: 'alert' });
    const submit = btn('Restore vault', () => {}, { kind: 'primary', type: 'submit' });
    const form = h('form', {
      class: 'gate-form', onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = '';
        if (!file) { err.textContent = 'Choose your backup file first.'; return; }
        const weak2 = passphraseProblem(np1.value);
        if (weak2) { err.textContent = weak2; shake(np1); return; }
        if (np1.value !== np2.value) { err.textContent = 'The two new passphrases do not match.'; shake(np2); return; }
        let backup;
        try { backup = parseBackup(file); } catch (x) { err.textContent = (x as Error).message; return; }
        const done = busy(submit, 'Decrypting');
        const ok = await restoreAsNewVault(backup, pass.value, np1.value);
        if (!ok) { done(); err.textContent = 'That passphrase does not open this backup.'; shake(pass); return; }
        pass.value = np1.value = np2.value = '';
        await requestPersistence();
        toast(`Restored ${vault().entries.length} entries`);
        show('main');
      },
    }, pick, field('Passphrase used for this backup', pass),
      field('New master passphrase for this iPhone', np1, 'The backup passphrase is only used to open the file. From now on you unlock with this one.'),
      meter.el, field('Type the new passphrase again', np2), err, submit);
    append(wrap, [hero, form, h('button', { class: 'link', type: 'button', onclick: () => { ui.setupMode = 'create'; show('setup'); } }, 'Create a new vault instead')]);
  }
  return wrap;
}

// ---------------------------------------------------------------- lock

/** Puts the cursor in the field on computers only. On a phone the keyboard would not open by
 *  itself, so focusing would only switch the screen to its compact "typing" layout too early. */
function autoFocus(el: HTMLElement): void {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  setTimeout(() => el.focus(), 300);
}

function lockView(): HTMLElement {
  const lockIcon = h('div', { class: 'gate-lock' }, appLogo());
  const pass = input({ type: 'password', autocomplete: 'current-password', enterkeyhint: 'go', 'aria-describedby': 'lock-err' });
  const err = h('p', { class: 'field-error', id: 'lock-err', role: 'alert' });
  const submit = btn('Unlock', () => {}, { kind: 'primary', type: 'submit', ic: 'arrow-right' });

  const form = h('form', {
    class: 'gate-form', onsubmit: async (e: Event) => {
      e.preventDefault();
      err.textContent = '';
      const wait = Math.ceil((ui.lockedUntil - Date.now()) / 1000);
      if (wait > 0) { err.textContent = `Too many tries. Wait ${wait} seconds.`; return; }
      if (!pass.value) { shake(pass); return; }
      const done = busy(submit, 'Unlocking');
      const ok = await unlock(pass.value).catch(() => false);
      if (!ok) {
        done();
        ui.failures++;
        if (ui.failures >= 5) ui.lockedUntil = Date.now() + Math.min(300, 5 * 2 ** (ui.failures - 5)) * 1000;
        err.textContent = 'That passphrase is not correct.';
        pass.select();
        shake(form);
        return;
      }
      await notePassphraseUnlock().catch(() => {});
      opened();
    },
  }, field('Master passphrase', pass), err, submit);

  const opened = () => {
    ui.failures = 0;
    pass.value = '';
    // The keyhole logo gives a little "turn" as the vault opens (see .gate-lock.is-open).
    lockIcon.classList.add('is-open');
    setTimeout(() => show('main'), 360);
  };

  // Face ID: shown only when it was turned on in Settings on this phone.
  const sub = h('p', { class: 'gate-sub' }, 'Enter your master passphrase to open it.');
  const faceBtn: HTMLButtonElement = btn('Unlock with Face ID', async () => {
    err.textContent = '';
    const done = busy(faceBtn, 'Waiting for Face ID');
    try {
      const phrase = await passphraseFromFaceId();
      const ok = await unlock(phrase).catch(() => false);
      done();
      if (ok) { opened(); return; }
      err.textContent = 'Face ID needs to be set up again. Unlock with your passphrase, then turn it on in Settings.';
    } catch (e) {
      done();
      const why = (e as Error).message;
      if (why === 'expired') { faceBtn.hidden = true; orLine.hidden = true; sub.textContent = 'Face ID needs your master passphrase once a week. Enter it to keep using Face ID.'; pass.focus(); return; }
      if (why !== 'cancelled') err.textContent = why === 'unsupported'
        ? 'Face ID unlock is not supported here. Use your passphrase.'
        : 'Face ID did not work. Use your passphrase.';
    }
  }, { kind: 'primary', ic: 'scan-smiley' });
  faceBtn.classList.add('face-btn');
  faceBtn.hidden = true;
  const orLine = h('p', { class: 'gate-or', hidden: true }, 'or');

  faceIdState().then((state) => {
    if (state === 'ok') {
      faceBtn.hidden = false;
      orLine.hidden = false;
      sub.textContent = 'Use Face ID or your master passphrase.';
      submit.classList.replace('btn-primary', 'btn-secondary');
      return;
    }
    if (state === 'expired') sub.textContent = 'Face ID needs your master passphrase once a week. Enter it to keep using Face ID.';
    autoFocus(pass);
  }).catch(() => autoFocus(pass));

  return h('main', { class: 'view gate lock-gate' },
    h('div', { class: 'gate-hero' }, lockIcon, h('h1', { class: 'gate-title' }, 'Vault is locked'), sub),
    form,
    // Face ID at the bottom: the passphrase field stays high, above the keyboard, so nothing moves.
    h('div', { class: 'gate-face' }, orLine, faceBtn),
  );
}

// ---------------------------------------------------------------- main

let resultsEl: HTMLElement | null = null;

function mainView(): HTMLElement {
  const v = vault();
  const wrap = h('main', { class: 'view main' });
  const brand = h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, appLogo()), h('span', {}, 'Vault'));
  // Title bar and search stay pinned together at the top while the list scrolls.
  const head = h('header', { class: 'sticky-head' }, topbar(brand, [iconBtn('gear-six', 'Settings', () => show('settings')), iconBtn('lock-simple', 'Lock now', doLock)]));
  wrap.append(head);

  if (!v.entries.length) {
    wrap.append(
      h('section', { class: 'empty' },
        h('div', { class: 'empty-art' }, icon('key')),
        h('h2', {}, 'Your vault is empty'),
        h('p', {}, 'Save passwords, bank PINs, ID numbers, phone numbers and addresses. Or import a screenshot and let Gemini fill in the details.'),
        h('div', { class: 'empty-actions' },
          btn('Import from screenshot', () => show('import'), { kind: 'primary', ic: 'file-arrow-up' }),
          btn('Add manually', () => openEditor(), { kind: 'secondary', ic: 'plus' }),
        ),
      ),
    );
    return wrap;
  }

  // Ask field
  const aiOn = v.settings.geminiEnabled && !!v.settings.geminiKey;
  const q = h('input', {
    class: 'ask-input', type: 'search', value: ui.query, placeholder: 'Ask: Gmail password, passport no.', 'aria-label': 'Search your vault',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search',
    oninput: () => { ui.query = q.value; ui.ai = null; ui.aiAbort?.abort(); updateResults(); },
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { q.blur(); if (aiOn && q.value.trim()) runAI(); } },
  });
  const ask = h('div', { class: 'ask' + (aiOn ? ' has-ai' : '') }, icon('magnifying-glass'), q,
    aiOn ? iconBtn('sparkle', 'Ask Gemini', () => { if (q.value.trim()) runAI(); }, 'ask-ai') : null);
  head.append(h('section', { class: 'ask-wrap' }, ask));

  // Category filter: only categories that have entries, with counts
  const counts = new Map<Category, number>();
  for (const e of v.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  if (ui.category !== 'all' && !counts.has(ui.category)) ui.category = 'all';
  const chip = (id: Category | 'all', label: string, ic: IconName, n: number) => {
    const b = h('button', {
      class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(ui.category === id), 'data-cat': id,
      onclick: () => {
        ui.category = id;
        bar.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === b)));
        b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        ui.ai = null;
        updateResults();
      },
    }, h('span', { class: 'chip-ic' }, icon(ic)), h('span', { class: 'chip-label' }, label), h('span', { class: 'chip-count' }, String(n)));
    return b;
  };
  const bar = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Categories' },
    chip('all', 'All', 'squares-four', v.entries.length),
    CATEGORIES.filter((c) => counts.has(c.id)).map((c) => chip(c.id, c.plural, c.icon, counts.get(c.id)!)));
  if (counts.size > 1) wrap.append(bar);

  // Password reuse check: one leaked site would open every account that shares the password.
  const reused = reusedEntries(v.entries);
  if (!reused.length) ui.reusedOnly = false;
  if (reused.length && !ui.query) {
    wrap.append(h('div', { class: 'notice notice-warn reuse-notice' }, icon('warning'),
      h('p', {}, ui.reusedOnly
        ? `Showing the ${reused.length} entries that share a password or PIN. Change each one to a unique value.`
        : `${reused.length} entries share a password or PIN with another entry.`),
      h('button', { class: 'link', type: 'button', onclick: () => { ui.reusedOnly = !ui.reusedOnly; render(); } }, ui.reusedOnly ? 'Show all' : 'Show them')));
  }

  // Backup reminder
  const days = relDays(v.settings.lastBackupAt);
  if (days >= 30) {
    wrap.append(h('div', { class: 'notice notice-info' }, icon('download-simple'),
      h('p', {}, v.settings.lastBackupAt ? `Your last backup was ${days} days ago.` : 'You have not made a backup yet.'),
      h('button', { class: 'link', type: 'button', onclick: () => exportBackup() }, 'Back up now')));
  }

  resultsEl = h('section', { class: 'results', 'aria-live': 'polite' });
  wrap.append(resultsEl);
  updateResults();

  wrap.append(h('nav', { class: 'dock', 'aria-label': 'Actions' },
    btn('Add', () => openEditor(undefined, ui.category === 'all' ? {} : { category: ui.category }), { kind: 'primary', ic: 'plus' }),
    btn('Import', () => show('import'), { kind: 'ghost', ic: 'file-arrow-up' }),
  ));
  return wrap;
}

function updateResults(): void {
  if (!resultsEl) return;
  const v = vault();
  const out: Node[] = [];
  const query = ui.query.trim();

  if (ui.ai) {
    if (ui.ai.status === 'loading') {
      out.push(h('h2', { class: 'section-title' }, icon('sparkle'), 'Asking Gemini'),
        h('p', { class: 'section-note' }, 'Only entry names are sent. Passwords and PINs stay on this phone.'),
        h('div', { class: 'skeleton' }, h('i'), h('i')));
    } else if (ui.ai.status === 'error') {
      out.push(h('div', { class: 'notice notice-warn' }, icon('warning'), h('p', {}, ui.ai.msg ?? 'Gemini could not answer. The local results below still work.')));
    } else {
      const list = ui.ai.ids.map((id) => v.entries.find((e) => e.id === id)).filter((e): e is Entry => !!e);
      out.push(h('h2', { class: 'section-title' }, icon('sparkle'), list.length > 1 ? 'Gemini found these' : 'Gemini suggests'));
      if (!list.length) out.push(h('p', { class: 'section-note' }, 'Gemini did not find a match.'));
      list.forEach((e, i) => out.push(entryRow(e, i, i === 0 && list.length === 1)));
    }
  }

  const base = ui.reusedOnly ? reusedEntries(v.entries) : v.entries;
  const pool = ui.category === 'all' ? base : base.filter((e) => e.category === ui.category);

  if (query) {
    const hits = search(pool, parseQuery(query));
    const mode = interpret(hits);
    if (mode === 'none') {
      const where = ui.category === 'all' ? '' : ` in ${cat(ui.category).plural}`;
      out.push(h('div', { class: 'empty empty-inline' },
        h('h2', {}, 'Nothing matches'),
        h('p', {}, `No entry fits "${query}"${where}. Try another word, or add it now.`),
        btn('Add entry', () => {
          const service = titleCase(parseQuery(query).terms.join(' '));
          openEditor(undefined, ui.category === 'all' ? { service } : { service, category: ui.category });
        }, { kind: 'secondary', ic: 'plus' })));
    } else if (mode === 'single') {
      out.push(h('h2', { class: 'section-title' }, 'Best match'));
      out.push(entryRow(hits[0].entry, 0, true));
      const rest = hits.slice(1, 6);
      if (rest.length) {
        out.push(h('h3', { class: 'section-sub' }, 'Other matches'));
        rest.forEach((hit, i) => out.push(entryRow(hit.entry, i + 1)));
      }
    } else {
      const close = hits.filter((hit) => hit.score >= hits[0].score * 0.7).slice(0, 8);
      const others = hits.slice(close.length, close.length + 4);
      const sameService = close.length <= 3 && close.every((hit) => hit.entry.service.toLowerCase() === close[0].entry.service.toLowerCase());
      const allLogins = close.every((hit) => hit.entry.category === 'login');
      out.push(h('h2', { class: 'section-title' }, sameService ? `${close[0].entry.service} has ${close.length} ${allLogins ? 'logins' : 'entries'}` : 'Which one did you mean?'));
      out.push(h('p', { class: 'section-note' }, sameService ? (allLogins ? 'Use the one for the device or purpose you need.' : 'All of them are shown below.') : `${close.length} entries match. Tap the one you want.`));
      close.forEach((hit, i) => out.push(entryRow(hit.entry, i, sameService)));
      if (others.length) {
        out.push(h('h3', { class: 'section-sub' }, 'Also related'));
        others.forEach((hit, i) => out.push(entryRow(hit.entry, close.length + i)));
      }
    }
  } else {
    let i = 0;
    out.push(h('div', { class: 'sort-bar' }, h('span', { class: 'sort-label' }, 'Sort'),
      segmented<SortMode>([['newest', 'Newest'], ['az', 'A–Z'], ['type', 'By type']], sortMode(), (m) => { setSortMode(m); updateResults(); }, 'Sort the list')));
    const mode = sortMode();
    if (mode === 'type') {
      // Grouped by category, in a fixed order, each with its icon and count.
      for (const c of CATEGORIES) {
        const list = sortEntries(pool.filter((e) => e.category === c.id), 'az');
        if (!list.length) continue;
        out.push(h('h2', { class: 'section-title group-head', 'data-cat': c.id }, h('span', { class: 'section-ic' }, icon(c.icon)), c.plural, h('span', { class: 'count' }, String(list.length))));
        list.forEach((e) => out.push(entryRow(e, i++)));
      }
    } else if (mode === 'az') {
      sortEntries(pool, 'az').forEach((e) => out.push(entryRow(e, i++)));
    } else {
      // Newest first, under Today / Yesterday / This week / ... headings.
      let heading = '';
      for (const e of sortEntries(pool, 'newest')) {
        const g = timeGroup(e.updatedAt);
        if (g !== heading) { heading = g; out.push(h('h2', { class: 'section-title time-head' }, g)); }
        out.push(entryRow(e, i++));
      }
    }
  }
  resultsEl.replaceChildren(...out);
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

async function runAI(): Promise<void> {
  const v = vault();
  ui.aiAbort?.abort();
  const ctrl = new AbortController();
  ui.aiAbort = ctrl;
  ui.ai = { status: 'loading', ids: [] };
  updateResults();
  try {
    const found = await geminiMatch(ui.query, v.entries, { apiKey: v.settings.geminiKey, model: v.settings.geminiModel, shareAccounts: v.settings.geminiShareAccounts }, ctrl.signal);
    if (ctrl.signal.aborted || !isUnlocked()) return;
    ui.ai = { status: 'done', ids: found.map((e) => e.id) };
  } catch (x) {
    if (ctrl.signal.aborted || !isUnlocked()) return;
    ui.ai = { status: 'error', ids: [], msg: `Gemini could not answer (${(x as Error).message}). The local results below still work.` };
  }
  updateResults();
}

// ---------------------------------------------------------------- entry row

// Clipboard clearing. iPhone only lets a page change the clipboard during a tap, so a plain
// 30-second timer often cannot clear it (and the vault has usually locked by then). The timer
// still tries; if it could not, the clipboard is cleared on the first tap in Vault after 30 s.
const CLIP_MS = 30_000;
let clipTimer = 0;
let clipDueAt = 0; // 0 = nothing of ours waiting to be cleared

function clearClipboardNow(): void {
  navigator.clipboard.writeText('').then(() => { clipDueAt = 0; }, () => {});
}
addEventListener('pointerdown', () => { if (clipDueAt && Date.now() >= clipDueAt) clearClipboardNow(); }, { capture: true, passive: true });
addEventListener('keydown', () => { if (clipDueAt && Date.now() >= clipDueAt) clearClipboardNow(); }, { capture: true });

async function copySecret(value: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toast('Copy did not work. Reveal it and copy by hand.', 'warn');
    return;
  }
  button.replaceChildren(icon('check'));
  button.classList.add('is-done');
  setTimeout(() => { button.replaceChildren(icon('copy')); button.classList.remove('is-done'); }, 1400);
  toast('Copied. Vault clears it after 30 seconds, or on your next tap in Vault after that.');
  clipDueAt = Date.now() + CLIP_MS;
  clearTimeout(clipTimer);
  clipTimer = window.setTimeout(clearClipboardNow, CLIP_MS);
}

function maskFor(type: SecretType): string {
  return type === 'pin' ? '••••' : type === 'number' ? '•••• •••• •••• ••••' : '••••••••••';
}

/** A stored value with Copy, plus Show/Hide when its category keeps it hidden. */
function secretLine(value: string, type: SecretType, opts: { small?: boolean; masked?: boolean; multiline?: boolean } = {}): HTMLElement {
  const masked = opts.masked ?? true;
  const cls = 'secret' + (opts.small ? ' secret-sm' : '') + (opts.multiline ? ' secret-text' : '');
  const copy: HTMLButtonElement = iconBtn('copy', 'Copy', () => copySecret(value, copy));
  if (!masked) return h('div', { class: 'secret-line' }, h('code', { class: cls }, value), h('div', { class: 'secret-actions' }, copy));

  const code = h('code', { class: cls + ' is-masked' }, maskFor(type));
  let timer = 0;
  const reveal: HTMLButtonElement = iconBtn('eye', 'Show', () => {
    clearTimeout(timer);
    if (code.classList.contains('is-masked')) {
      code.classList.remove('is-masked');
      scramble(code, value);
      reveal.replaceChildren(icon('eye-slash'));
      reveal.setAttribute('aria-label', 'Hide');
      timer = window.setTimeout(hide, 20_000);
    } else hide();
  });
  const hide = () => {
    code.classList.add('is-masked');
    code.textContent = maskFor(type);
    reveal.replaceChildren(icon('eye'));
    reveal.setAttribute('aria-label', 'Show');
  };
  return h('div', { class: 'secret-line' }, code, h('div', { class: 'secret-actions' }, reveal, copy));
}

/** Email or username, shown in full with its own Copy button. */
function accountLine(value: string): HTMLElement {
  const copy: HTMLButtonElement = iconBtn('copy', 'Copy', async () => {
    try { await navigator.clipboard.writeText(value); } catch { toast('Copy did not work.', 'warn'); return; }
    copy.replaceChildren(icon('check'));
    copy.classList.add('is-done');
    setTimeout(() => { copy.replaceChildren(icon('copy')); copy.classList.remove('is-done'); }, 1400);
    toast('Copied');
  });
  return h('div', { class: 'secret-line account-line' }, h('span', { class: 'account-value' }, value), h('div', { class: 'secret-actions' }, copy));
}

/** "Same password as Gmail, Tokyo Gas and 3 more": shown inside an entry whose secret is reused. */
function reuseWarning(e: Entry): HTMLElement | null {
  const others = reusedBy(e);
  if (!others.length) return null;
  const names = [...new Set(others.map((o) => o.service))];
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  const what = e.type === 'pin' ? 'PIN' : 'password';
  return h('p', { class: 'reuse-warn' }, icon('warning'),
    h('span', {}, `Same ${what} as ${list}. If one leaks, the others are open too. Edit and tap the dice to make a unique one.`));
}

function entryRow(e: Entry, i: number, forceOpen = false): HTMLElement {
  const def = cat(e.category);
  const open = forceOpen || ui.expanded.has(e.id);
  const twin = e.tags.length > 0 && vault().entries.some((o) => o.id !== e.id && o.service.trim().toLowerCase() === e.service.trim().toLowerCase());
  const tagBadge = twin ? e.tags[0] : '';
  const label = tagBadge || typeLabel(e);
  const head = h('button', { class: 'row-head', type: 'button', 'aria-expanded': String(open) },
    tile(e.service, e.category, 'sm', e.account),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, e.service), h('span', { class: 'row-sub' }, e.account || def.label)),
    label ? h('span', { class: 'badge' + (tagBadge ? ' badge-use' : ''), 'data-type': e.type }, label) : h('span'),
    h('span', { class: 'chev' }, icon('caret-down')),
  );
  const show = { masked: def.masked, multiline: def.multiline };

  const history = e.history.length
    ? h('details', { class: 'history' },
      h('summary', {}, icon('clock-counter-clockwise'), `Previous values (${e.history.length})`),
      h('ul', {}, e.history.map((hi) => h('li', {}, h('span', { class: 'history-date' }, fmtDate(hi.changedAt)), secretLine(hi.value, e.type, { ...show, small: true })))))
    : null;

  const body = h('div', { class: 'row-body' }, h('div', { class: 'row-inner' },
    e.account ? h('div', { class: 'kv-line' }, h('span', { class: 'cap' }, def.accountLabel.replace(' (optional)', '')), accountLine(e.account)) : null,
    h('div', { class: 'kv-line' }, h('span', { class: 'cap' }, def.valueLabel[e.type] ?? 'Value'), secretLine(e.secret, e.type, show)),
    reuseWarning(e),
    e.notes ? h('p', { class: 'row-notes' }, e.notes) : null,
    e.tags.length ? h('div', { class: 'tags' }, e.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
    h('div', { class: 'row-foot' },
      h('span', { class: 'row-date' }, `Updated ${fmtDate(e.updatedAt)}`),
      btn('Edit', () => openEditor(e), { kind: 'ghost', ic: 'pencil-simple' })),
    history,
  ));

  const row = h('article', { class: 'row' + (open ? ' is-open' : ''), 'data-cat': e.category, style: { '--i': String(Math.min(i, 12)) } }, head, body);
  head.addEventListener('click', () => {
    const now = !row.classList.contains('is-open');
    row.classList.toggle('is-open', now);
    head.setAttribute('aria-expanded', String(now));
    if (now) ui.expanded.add(e.id); else ui.expanded.delete(e.id);
  });
  return row;
}

// ---------------------------------------------------------------- editor sheet

function generatePassword(len = 18): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?-_+=';
  const out: string[] = [];
  const buf = new Uint32Array(len * 2);
  crypto.getRandomValues(buf);
  for (const n of buf) {
    if (n >= Math.floor(0xffffffff / chars.length) * chars.length) continue; // avoid modulo bias
    out.push(chars[n % chars.length]);
    if (out.length === len) break;
  }
  return out.join('');
}

interface Sheet { close: () => void; set: (title: string, nodes: Node[]) => void }

// iPhone ignores overflow:hidden on the page, so while a sheet is open every drag that would
// reach the page behind it is stopped. Inside the sheet you can still scroll its own content,
// but a drag past its top or bottom (or on a sheet too short to scroll) no longer moves the page.
let pageLocked = false;
let touchY = 0;
function lockPage(): void { pageLocked = true; }
function unlockPage(): void { pageLocked = false; }
document.addEventListener('touchstart', (e) => { touchY = e.touches[0]?.clientY ?? 0; }, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!pageLocked) return;
  const sheet = (e.target as Element | null)?.closest?.('.sheet') as HTMLElement | null;
  if (!sheet) { e.preventDefault(); return; }
  // Let text fields and other inner scrollers that can still scroll keep the gesture.
  for (let el = e.target as HTMLElement | null; el && el !== sheet; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return;
  }
  const y = e.touches[0]?.clientY ?? touchY;
  const down = y > touchY; // finger moving down = trying to scroll up
  touchY = y;
  const atTop = sheet.scrollTop <= 0;
  const atBottom = sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 1;
  if (sheet.scrollHeight <= sheet.clientHeight + 1 || (down && atTop) || (!down && atBottom)) e.preventDefault();
}, { passive: false });

function openSheet(): Sheet {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' });
  const titleEl = h('h2', { id: 'sheet-title' });
  const body = h('div', { class: 'sheet-body' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('is-in');
    sheet.classList.remove('is-in');
    document.body.classList.remove('sheet-open');
    (document.activeElement as HTMLElement | null)?.blur?.();
    unlockPage();
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 420);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  append(sheet, [
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' }, titleEl, iconBtn('x', 'Close', close)),
    body,
  ]);
  lockPage();
  document.body.append(backdrop, sheet);
  document.body.classList.add('sheet-open');
  // Keep a focused field visible above the keyboard.
  sheet.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('input, textarea, select')) setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
  });
  requestAnimationFrame(() => requestAnimationFrame(() => { backdrop.classList.add('is-in'); sheet.classList.add('is-in'); }));
  let first = true;
  return {
    close,
    set: (title, nodes) => {
      titleEl.textContent = title;
      body.replaceChildren(...nodes);
      sheet.scrollTop = 0;
      if (!first && !reducedMotion()) body.animate([{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' });
      first = false;
    },
  };
}

function openEditor(entry?: Entry, preset: Partial<EntryInput> = {}): void {
  const sheet = openSheet();
  const category = entry?.category ?? preset.category;
  if (category) editorForm(sheet, category, entry, preset, false);
  else categoryPicker(sheet, preset);
}

function categoryPicker(sheet: Sheet, preset: Partial<EntryInput>): void {
  const list = h('div', { class: 'cat-list' }, CATEGORIES.map((c, i) =>
    h('button', { class: 'cat-card', type: 'button', 'data-cat': c.id, style: { '--i': String(i) }, onclick: () => editorForm(sheet, c.id, undefined, preset, true) },
      h('span', { class: 'cat-ic' }, icon(c.icon)),
      h('span', { class: 'cat-text' }, h('strong', {}, c.label), h('span', {}, c.hint)),
      h('span', { class: 'cat-go' }, icon('caret-right')))));
  sheet.set('What do you want to save?', [list]);
}

function editorForm(sheet: Sheet, category: Category, entry: Entry | undefined, preset: Partial<EntryInput>, fromPicker: boolean): void {
  const v = vault();
  const def = cat(category);
  const val = <K extends keyof EntryInput>(k: K): EntryInput[K] | undefined => (preset[k] ?? entry?.[k]) as EntryInput[K] | undefined;
  let type: SecretType = typeFor(category, val('type') ?? def.types[0]);

  const listId = 'svc-list';
  const service = input({ value: val('service') ?? '', list: listId, autocapitalize: 'words', enterkeyhint: 'next', placeholder: def.namePlaceholder });
  const datalist = h('datalist', { id: listId }, [...new Set(v.entries.filter((e) => e.category === category).map((e) => e.service))].sort().map((s) => h('option', { value: s })));
  const account = input({ value: val('account') ?? '', enterkeyhint: 'next', placeholder: def.accountPlaceholder, list: 'acc-list', type: category === 'login' ? 'email' : 'text' });
  const accList = h('datalist', { id: 'acc-list' }, [...new Set(v.entries.map((e) => e.account).filter(Boolean))].sort().map((a) => h('option', { value: a })));
  const picks = def.picks.length && !entry
    ? h('div', { class: 'picks', role: 'list' }, def.picks.map((p) => h('button', { type: 'button', class: 'pick', role: 'listitem', onclick: () => { service.value = p; } }, p)))
    : null;

  // The value field changes shape with the category.
  let secret: HTMLInputElement | HTMLTextAreaElement;
  let valueBox: HTMLElement;
  let genBtn: HTMLButtonElement | null = null;
  if (def.multiline) {
    secret = h('textarea', { class: 'input textarea', rows: '3', autocapitalize: category === 'address' ? 'words' : 'sentences', placeholder: category === 'address' ? 'Tole, ward no., city, district' : '' }, val('secret') ?? '');
    valueBox = secret;
  } else {
    const s = input({ value: val('secret') ?? '', class: 'input' + (category === 'phone' ? '' : ' input-mono'), autocomplete: 'off', enterkeyhint: 'next' });
    secret = s;
    if (category === 'phone') { s.type = 'tel'; s.inputMode = 'tel'; s.placeholder = '98XXXXXXXX'; }
    if (category === 'id') s.setAttribute('autocapitalize', 'characters');
    const actions: HTMLElement[] = [];
    if (def.masked) {
      s.type = 'password';
      const showBtn: HTMLButtonElement = iconBtn('eye', 'Show', () => {
        const hidden = s.type === 'password';
        s.type = hidden ? 'text' : 'password';
        showBtn.replaceChildren(icon(hidden ? 'eye-slash' : 'eye'));
      }, 'in-field');
      genBtn = iconBtn('dice-five', 'Generate a strong password', () => { s.value = generatePassword(); s.type = 'text'; showBtn.replaceChildren(icon('eye-slash')); }, 'in-field');
      actions.push(genBtn, showBtn);
    }
    valueBox = actions.length ? h('div', { class: 'input-wrap' }, s, h('div', { class: 'in-field-actions' }, actions)) : s;
  }
  const valueField = field(def.valueLabel[type] ?? 'Value', valueBox);
  const valueLabel = valueField.querySelector('.field-label') as HTMLElement;
  if (valueBox !== secret) { secret.id = valueBox.id; valueBox.removeAttribute('id'); }

  const applyType = () => {
    if (secret instanceof HTMLInputElement && category !== 'phone') secret.inputMode = type === 'pin' ? 'numeric' : 'text';
    if (genBtn) genBtn.hidden = type !== 'password';
    valueLabel.textContent = def.valueLabel[type] ?? 'Value';
  };
  applyType();

  const notes = h('textarea', { class: 'input textarea', rows: '2', placeholder: def.notesPlaceholder }, val('notes') ?? '');
  const tags = input({ value: (val('tags') ?? []).join(', '), placeholder: 'family, work (optional)' });
  const err = h('p', { class: 'field-error', role: 'alert' });

  // Lets the user move an entry to another category (keeps what was typed).
  const current = (): Partial<EntryInput> => ({
    service: service.value, account: account.value, secret: secret.value, notes: notes.value, type,
    tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
  });
  const catSelect = entry
    ? h('select', {
      class: 'input select', onchange: () => editorForm(sheet, catSelect!.value as Category, entry, current(), false),
    }, CATEGORIES.map((c) => h('option', { value: c.id, selected: c.id === category ? true : null }, c.label)))
    : null;

  const saveBtn = btn(entry ? 'Save changes' : 'Save', () => {}, { kind: 'primary', type: 'submit' });
  let confirmDelete = false;
  const delBtn = entry ? btn('Delete', async () => {
    if (!confirmDelete) { confirmDelete = true; delBtn!.querySelector('span')!.textContent = 'Tap again to delete'; delBtn!.classList.add('is-armed'); return; }
    deleteEntry(entry.id);
    await save();
    sheet.close();
    toast('Entry deleted');
    render();
  }, { kind: 'danger', ic: 'trash' }) : null;

  const form = h('form', {
    class: 'form', 'data-cat': category, onsubmit: async (e: Event) => {
      e.preventDefault();
      err.textContent = '';
      const data: EntryInput = {
        category,
        service: service.value.trim(),
        account: account.value.trim(),
        type,
        secret: def.multiline ? secret.value.trim() : secret.value,
        notes: notes.value.trim(),
        tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      };
      const what = (def.valueLabel[type] ?? 'value').toLowerCase();
      if (!data.service) { err.textContent = `Give it a name, like ${def.picks[0] ?? def.namePlaceholder.split(',')[0]}.`; shake(service); return; }
      if (!data.secret) { err.textContent = `Enter the ${what}.`; shake(secret); return; }
      if (type === 'pin' && !/^\d{3,12}$/.test(data.secret)) { err.textContent = 'A PIN should be digits only.'; shake(secret); return; }
      if (category === 'phone' && !/^\+?[\d\s()-]{6,20}$/.test(data.secret)) { err.textContent = 'That does not look like a phone number.'; shake(secret); return; }
      const target = entry?.id ?? findExisting(data.service, data.account, data.type)?.id;
      const res = upsertEntry(data, target);
      await save();
      sheet.close();
      toast(res.created ? 'Saved' : res.changed ? 'Updated. The old value is kept in history.' : 'Saved');
      ui.expanded.add(res.entry.id);
      render();
    },
  },
    fromPicker ? h('button', { class: 'link back-link', type: 'button', onclick: () => categoryPicker(sheet, current()) }, icon('caret-left'), h('span', {}, 'Choose another type')) : null,
    catSelect ? field('Category', catSelect) : null,
    h('div', { class: 'field' }, field(def.nameLabel, service), picks), datalist,
    field(def.accountLabel, account), accList,
    def.types.length > 1
      ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Type'),
        segmented<SecretType>(def.types.map((t) => [t, def.valueLabel[t] ?? t] as [SecretType, string]), type, (t) => { type = t; applyType(); }, 'Type'))
      : null,
    valueField,
    field('Notes', notes),
    field('Tags', tags, 'Extra words to find it by, like Mobile or PC. Separate them with commas.'),
    err,
    h('div', { class: 'form-actions' }, saveBtn, delBtn),
  );
  sheet.set(`${entry ? 'Edit' : 'New'} ${def.label}`, [form]);
}

// ---------------------------------------------------------------- import

function importView(): HTMLElement {
  const wrap = h('main', { class: 'view page' });
  wrap.append(topbar(backButton()));
  wrap.append(h('div', { class: 'page-head' }, h('h1', {}, 'Import from screenshot'),
    h('p', {}, 'Pick a screenshot of a login, PIN, card or ID. Gemini reads it, then you check every detail before saving.')));

  if (!ui.drafts) {
    const s = vault().settings;
    if (!s.geminiKey) {
      wrap.append(h('div', { class: 'notice' },
        h('p', {}, 'Reading screenshots needs your Gemini API key. Add it in Settings under Gemini, then come back.'),
        btn('Open Settings', () => show('settings'), { kind: 'primary', ic: 'gear-six' })));
      return wrap;
    }
    const err = h('p', { class: 'field-error', role: 'alert' });
    const preview = h('div', { class: 'shot-preview', hidden: true });
    let picked: { base64: string; dataUrl: string } | null = null;
    const readBtn: HTMLButtonElement = btn('Read details with Gemini', async () => {
      if (!picked) return;
      err.textContent = '';
      const done = busy(readBtn, 'Reading the screenshot');
      try {
        const found = await extractFromImage(picked.base64, { apiKey: s.geminiKey, model: s.geminiModel || 'gemini-2.5-flash' });
        done();
        if (!found.length) { err.textContent = 'No logins, PINs, cards or ID numbers were found in this picture. Try a clearer screenshot.'; return; }
        ui.drafts = found.map((d) => ({ ...d, include: true }));
        ui.skipped = [];
        ui.shot = picked.dataUrl;
        picked = null;
        render();
      } catch (e) {
        done();
        err.textContent = (e as Error).message === 'key'
          ? 'Gemini did not accept the request. Check the API key and model in Settings.'
          : 'Could not reach Gemini. Check your internet connection and try again.';
      }
    }, { kind: 'primary', ic: 'sparkle' });
    readBtn.hidden = true;

    const fileInput = h('input', {
      type: 'file', class: 'visually-hidden', accept: 'image/*', onchange: async () => {
        ui.suspendLock = false;
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (!f) return;
        err.textContent = '';
        try { picked = await prepareImage(f); } catch { err.textContent = 'This picture could not be opened. Try a PNG or JPEG screenshot.'; return; }
        preview.replaceChildren(h('img', { src: picked.dataUrl, alt: 'Chosen screenshot' }));
        preview.hidden = false;
        readBtn.hidden = false;
      },
    });
    wrap.append(
      h('div', { class: 'privacy' },
        h('div', {}, h('strong', {}, 'Sent to Google'), h('p', {}, 'Only the picture you choose, after you tap Read. It contains the secrets, so use screenshots you are comfortable sending.')),
        h('div', {}, h('strong', {}, 'Good to know'), h('p', {}, 'With a free Gemini API key, Google may use what you send to improve its products. A paid key (billing on) keeps it out of that.'))),
      h('label', { class: 'file-pick', onclick: () => pauseLockForPicker(fileInput) },
        fileInput, icon('file-arrow-up'), h('span', {}, 'Choose screenshot')),
      preview, err, readBtn,
    );
    return wrap;
  }

  const drafts = ui.drafts;
  const summary = h('p', { class: 'section-note' });
  const saveBtn = btn('', async () => {
    let added = 0;
    let updated = 0;
    for (const d of drafts) {
      if (!d.include || !d.service.trim() || !d.secret) continue;
      const existing = findExisting(d.service, d.account, d.type);
      const category = d.category ?? inferCategory(d.service, d.type, d.secret);
      const res = upsertEntry({ category, service: d.service.trim(), account: d.account.trim(), type: typeFor(category, d.type), secret: d.secret, notes: d.notes, tags: d.tags ?? [] }, existing?.id);
      if (res.created) added++; else if (res.changed) updated++;
    }
    await save();
    ui.drafts = null;
    ui.skipped = [];
    ui.shot = null;
    toast(`Imported ${added} new${updated ? `, updated ${updated}` : ''}`);
    show('main');
  }, { kind: 'primary', ic: 'check' });
  const refresh = () => {
    const n = drafts.filter((d) => d.include).length;
    saveBtn.querySelector('span')!.textContent = `Save ${n} ${n === 1 ? 'entry' : 'entries'}`;
    saveBtn.disabled = n === 0;
    summary.textContent = `Found ${drafts.length}. Compare each one with the screenshot, fix anything that looks wrong, and switch off what you do not want.`;
  };

  const cards = drafts.map((d, i) => {
    const exists = !!findExisting(d.service, d.account, d.type);
    const svc = input({ value: d.service, 'aria-label': 'Name', autocapitalize: 'words', oninput: () => { d.service = svc.value; } });
    const acc = input({ value: d.account, 'aria-label': 'Account', placeholder: 'Account', oninput: () => { d.account = acc.value; } });
    // Addresses and notes can have several lines, so they get a text box that keeps line breaks.
    const multi = d.category ? cat(d.category).multiline : d.secret.includes('\n');
    const sec: HTMLInputElement | HTMLTextAreaElement = multi
      ? h('textarea', { class: 'input textarea input-mono', rows: String(Math.min(4, d.secret.split('\n').length + 1)), 'aria-label': 'Value', oninput: () => { d.secret = sec.value; } }, d.secret)
      : input({ value: d.secret, 'aria-label': 'Value', class: 'input input-mono', oninput: () => { d.secret = sec.value; } });
    d.category ??= inferCategory(d.service, d.type, d.secret);
    let icn = tile(d.service, d.category);
    const catSel = h('select', {
      class: 'input select', 'aria-label': 'Category', onchange: () => {
        d.category = catSel.value as Category;
        d.type = d.category === 'bank' && /^\d{3,6}$/.test(d.secret) ? 'pin'
          : d.category === 'bank' && /^[\d -]{7,}$/.test(d.secret.trim()) ? 'number'
            : typeFor(d.category, d.type);
        const next = tile(d.service, d.category);
        icn.replaceWith(next);
        icn = next;
      },
    }, CATEGORIES.map((c) => h('option', { value: c.id, selected: c.id === d.category ? true : null }, c.label)));
    const notesIn = input({ class: 'input draft-full', value: d.notes, 'aria-label': 'Notes', placeholder: 'Notes (optional)', oninput: () => { d.notes = notesIn.value; } });
    const tagsIn = input({ class: 'input draft-full', value: (d.tags ?? []).join(', '), 'aria-label': 'Tags', placeholder: 'Tags, like PC or Mobile (optional)',
      oninput: () => { d.tags = tagsIn.value.split(',').map((t) => t.trim()).filter(Boolean); } });
    const typeLbl = h('span', { class: 'draft-type' }, cat(d.category).valueLabel[d.type] ?? 'Value');
    catSel.addEventListener('change', () => { typeLbl.textContent = cat(d.category).valueLabel[d.type] ?? 'Value'; });
    const card = h('article', { class: 'draft' + (d.include ? '' : ' is-off'), style: { '--i': String(Math.min(i, 12)) } },
      h('div', { class: 'draft-head' },
        icn,
        h('span', { class: 'draft-title' }, exists ? 'Updates an existing entry' : 'New entry'),
        toggle(d.include, (val) => { d.include = val; card.classList.toggle('is-off', !val); refresh(); }, 'Include this entry')),
      d.confidence === 'low' ? h('p', { class: 'draft-warn' }, icon('warning'), 'Hard to read. Check this one carefully.') : null,
      h('div', { class: 'draft-grid' }, svc, acc, catSel, typeLbl, sec, notesIn, tagsIn),
    );
    return card;
  });

  if (ui.shot) {
    wrap.append(h('details', { class: 'shot-compare', open: true },
      h('summary', {}, 'Screenshot'), h('div', { class: 'shot-preview' }, h('img', { src: ui.shot, alt: 'Imported screenshot' }))));
  }
  wrap.append(summary, h('div', { class: 'drafts' }, cards));
  if (ui.skipped.length) {
    wrap.append(h('details', { class: 'history skipped' },
      h('summary', {}, icon('warning'), `${ui.skipped.length} ${ui.skipped.length === 1 ? 'line was' : 'lines were'} not understood`),
      h('p', { class: 'section-note' }, 'Add these by hand if they matter.'),
      h('ul', {}, ui.skipped.map((s) => h('li', { class: 'mono' }, s)))));
  }
  wrap.append(h('nav', { class: 'dock' }, saveBtn, btn('Start over', () => { ui.drafts = null; ui.skipped = []; ui.shot = null; render(); }, { kind: 'ghost' })));
  refresh();
  return wrap;
}

// ---------------------------------------------------------------- settings

async function exportBackup(): Promise<void> {
  const text = await makeBackup();
  const name = `vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([text], name, { type: 'application/json' });
  await withLockSuspended(async () => {
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Vault backup' });
        toast('Backup ready. Save it to Files or iCloud Drive.');
        return;
      }
    } catch (x) {
      if ((x as Error).name === 'AbortError') { toast('Backup cancelled', 'warn'); return; }
    }
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Backup downloaded');
  });
  if (ui.view === 'settings' || ui.view === 'main') render();
}

function group(title: string, ...children: Node[]): HTMLElement {
  return h('section', { class: 'group' }, h('h2', { class: 'group-title' }, title), h('div', { class: 'group-body' }, children));
}

function settingsView(): HTMLElement {
  const v = vault();
  const s = v.settings;
  const wrap = h('main', { class: 'view page' });
  wrap.append(topbar(backButton(), [themeButton()]), h('div', { class: 'page-head' }, h('h1', {}, 'Settings')));

  // Text size (kept on this device only; it is not a secret)
  wrap.append(group('Text size',
    segmented<TextSize>([['xs', 'XS'], ['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], textSize(), (t) => setTextSize(t), 'Text size'),
    h('p', { class: 'group-note' }, 'Extra small to extra large. Text, rows and buttons all change together. Typing fields stay at least 16 px so iPhone does not zoom in.'),
  ));

  // Backup
  let backupText: string | null = null;
  let mode: 'merge' | 'replace' = 'merge';
  const fileName = h('span', { class: 'file-name' }, 'No file chosen');
  const fileInput = h('input', {
    type: 'file', class: 'visually-hidden', accept: '.json,application/json', onchange: async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      backupText = await f.text();
      fileName.textContent = f.name;
    },
  });
  const restorePass = input({ type: 'password', autocomplete: 'off' });
  const restoreErr = h('p', { class: 'field-error', role: 'alert' });
  const restoreBtn = btn('Restore', async () => {
    restoreErr.textContent = '';
    if (!backupText) { restoreErr.textContent = 'Choose a backup file first.'; return; }
    let file;
    try { file = parseBackup(backupText); } catch (x) { restoreErr.textContent = (x as Error).message; return; }
    const done = busy(restoreBtn, 'Decrypting');
    const opened = await openBackup(file, restorePass.value);
    if (!opened) { done(); restoreErr.textContent = 'That passphrase does not open this backup.'; shake(restorePass); return; }
    const res = await restoreInto(opened.data, mode);
    toast(mode === 'replace' ? `Replaced with ${res.added} entries` : `Added ${res.added}, updated ${res.updated}`);
    show('main');
  }, { kind: 'secondary', ic: 'upload-simple' });

  wrap.append(group('Backup',
    h('div', { class: 'kv' }, h('span', {}, 'Last backup'), h('strong', {}, fmtDate(s.lastBackupAt))),
    h('p', { class: 'group-note' }, 'The backup file is encrypted with your passphrase. Keep it in iCloud Drive or Files so you can restore on a new phone.'),
    btn('Export encrypted backup', () => exportBackup(), { kind: 'primary', ic: 'download-simple' }),
    h('hr'),
    h('label', { class: 'file-pick', onclick: () => pauseLockForPicker(fileInput) }, fileInput, icon('file-arrow-up'), h('span', {}, 'Choose backup file'), fileName),
    field('Passphrase used for that backup', restorePass),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'How to restore'),
      segmented<'merge' | 'replace'>([['merge', 'Merge'], ['replace', 'Replace all']], mode, (m) => { mode = m; }, 'Restore mode'),
      h('p', { class: 'field-help' }, 'Merge keeps the newest version of each entry. Replace all deletes what is here first.')),
    restoreErr, restoreBtn,
  ));

  // Private logos: kept inside the encrypted vault, so the public website never lists your services.
  const logoErr = h('p', { class: 'field-error', role: 'alert' });
  const logoInput = h('input', {
    type: 'file', class: 'visually-hidden', accept: '.json,application/json', onchange: async () => {
      logoErr.textContent = '';
      const f = logoInput.files?.[0];
      logoInput.value = '';
      if (!f) return;
      if (f.size > 8_000_000) { logoErr.textContent = 'This file is too big to be a logo pack.'; return; }
      try { s.logos = parseLogoPack(await f.text()); } catch (x) { logoErr.textContent = (x as Error).message; return; }
      await save();
      toast(`${s.logos.length} private logos added`);
      render();
    },
  });
  wrap.append(group('Private logos',
    h('div', { class: 'kv' }, h('span', {}, 'Logos in your vault'), h('strong', {}, String(s.logos.length))),
    h('p', { class: 'group-note' }, 'Logos for your own services, such as your banks. They are stored encrypted inside your vault and its backups, not on the website, so nobody can see which services you use.'),
    h('label', { class: 'file-pick', onclick: () => pauseLockForPicker(logoInput) }, logoInput, icon('file-arrow-up'), h('span', {}, s.logos.length ? 'Replace logo pack' : 'Import logo pack')),
    logoErr,
    ...(s.logos.length ? [btn('Remove private logos', async () => { s.logos = []; await save(); toast('Private logos removed'); render(); }, { kind: 'ghost' })] : []),
  ));

  // Security
  const lockSel = h('select', {
    class: 'input select', onchange: async () => { s.autoLockMinutes = Number(lockSel.value); await save(); toast('Saved'); },
  }, [1, 2, 5, 10].map((m) => h('option', { value: String(m), selected: m === s.autoLockMinutes ? true : null }, `${m} ${m === 1 ? 'minute' : 'minutes'}`)));
  const cur = input({ type: 'password', autocomplete: 'current-password' });
  const nw = input({ type: 'password', autocomplete: 'new-password' });
  const nw2 = input({ type: 'password', autocomplete: 'new-password' });
  const meter = strengthMeter();
  nw.addEventListener('input', () => meter.update(nw.value));
  const passErr = h('p', { class: 'field-error', role: 'alert' });
  const passBtn = btn('Change passphrase', async () => {
    passErr.textContent = '';
    const weak3 = passphraseProblem(nw.value);
    if (weak3) { passErr.textContent = weak3; shake(nw); return; }
    if (nw.value !== nw2.value) { passErr.textContent = 'The new passphrases do not match.'; return; }
    const done = busy(passBtn, 'Re-encrypting');
    const ok = await changePassphrase(cur.value, nw.value);
    done();
    if (!ok) { passErr.textContent = 'The current passphrase is not correct.'; shake(cur); return; }
    cur.value = nw.value = nw2.value = '';
    meter.update('');
    toast('Passphrase changed. Make a new backup now.');
  }, { kind: 'secondary', ic: 'key' });

  // Face ID unlock: passphrase check first, then a fresh tap creates the passkey (Safari needs the tap).
  const faceBox = h('div', { class: 'face-box' });
  const faceErr = (e: unknown) => {
    const why = (e as Error).message;
    return why === 'cancelled' ? 'Face ID was cancelled. Try again.'
      : why === 'unsupported' ? 'This iPhone or browser cannot use Face ID for websites. It needs iOS 18 or later.'
        : 'Could not turn on Face ID. Try again.';
  };
  const renderFace = async (): Promise<void> => {
    if (!(await faceIdAvailable())) {
      faceBox.replaceChildren(h('p', { class: 'group-note' }, 'Face ID is not available here. Open the app from your iPhone Home Screen (iOS 18 or later).'));
      return;
    }
    if (await faceIdEnabled()) {
      faceBox.replaceChildren(
        h('div', { class: 'kv' }, h('span', {}, 'Face ID unlock'), h('strong', { class: 'face-on' }, icon('check'), 'On')),
        h('p', { class: 'group-note' }, 'Good to know: if Face ID fails, iPhone lets you use your iPhone passcode instead, so anyone who knows that passcode could open Vault. Keep your iPhone passcode private. For safety Vault asks for your master passphrase once a week. If you change the passphrase, turn Face ID on again.'),
        btn('Turn off Face ID', async () => { await disableFaceId(); toast('Face ID unlock is off'); void renderFace(); }, { kind: 'ghost' }),
      );
      return;
    }
    const fp = input({ type: 'password', autocomplete: 'current-password' });
    const ferr = h('p', { class: 'field-error', role: 'alert' });
    const step1: HTMLButtonElement = btn('Continue', async () => {
      ferr.textContent = '';
      if (!fp.value) { shake(fp); return; }
      const done = busy(step1, 'Checking');
      const ok = await checkPassphrase(fp.value);
      done();
      if (!ok) { ferr.textContent = 'That passphrase is not correct.'; shake(fp); return; }
      const phrase = fp.value;
      fp.value = '';
      const finish = async (p: PendingPasskey, b: HTMLButtonElement) => {
        const end = busy(b, 'Saving');
        try {
          await finishFaceId(phrase, p);
          end();
          toast('Face ID unlock is on');
          void renderFace();
        } catch (e) {
          end();
          ferr.textContent = faceErr(e);
          if (!p.prf) faceBox.replaceChildren(h('p', { class: 'group-note' }, 'One more step: confirm with Face ID.'), ferr, confirm(p));
        }
      };
      const confirm = (p: PendingPasskey): HTMLButtonElement => {
        const b: HTMLButtonElement = btn('Confirm with Face ID', () => void finish(p, b), { kind: 'primary', ic: 'scan-smiley' });
        return b;
      };
      const setup: HTMLButtonElement = btn('Set up Face ID', async () => {
        ferr.textContent = '';
        let p: PendingPasskey;
        try { p = await createFacePasskey(); } catch (e) { ferr.textContent = faceErr(e); return; }
        if (p.prf) void finish(p, setup);
        else faceBox.replaceChildren(h('p', { class: 'group-note' }, 'One more step: confirm with Face ID.'), ferr, confirm(p));
      }, { kind: 'primary', ic: 'scan-smiley' });
      faceBox.replaceChildren(h('p', { class: 'group-note' }, 'Passphrase checked. Tap below and look at your iPhone.'), ferr, setup);
    }, { kind: 'secondary', ic: 'scan-smiley' });
    faceBox.replaceChildren(
      h('p', { class: 'group-note' }, 'Open the vault with Face ID instead of typing. Enter your master passphrase once to turn it on.'),
      field('Master passphrase', fp), ferr, step1,
    );
  };
  void renderFace();
  wrap.append(group('Face ID', faceBox));

  wrap.append(group('Security',
    field('Lock after inactivity', lockSel, 'The vault also locks as soon as you leave the app.'),
    h('hr'),
    field('Current passphrase', cur), field('New passphrase', nw), meter.el, field('New passphrase again', nw2),
    h('p', { class: 'group-note' }, 'Old backups still open with the passphrase they were made with.'),
    passErr, passBtn,
  ));

  // Gemini
  let enabled = s.geminiEnabled;
  let share = s.geminiShareAccounts;
  const keyIn = input({ type: 'password', value: s.geminiKey, autocomplete: 'off', placeholder: 'Paste your API key' });
  const modelIn = input({ value: s.geminiModel });
  wrap.append(group('Gemini search (optional)',
    h('div', { class: 'kv' }, h('span', {}, 'Use Gemini to understand questions'), toggle(enabled, (val) => { enabled = val; }, 'Use Gemini')),
    h('div', { class: 'privacy' },
      h('div', {}, h('strong', {}, 'Sent to Google'), h('p', {}, 'Your question, entry names, types, tags and account names with the middle hidden.')),
      h('div', {}, h('strong', {}, 'Never sent'), h('p', {}, 'Passwords, PINs, notes and history.'))),
    field('API key', keyIn, 'Stored encrypted inside your vault. It is not included in backups.'),
    field('Model', modelIn),
    h('div', { class: 'kv' }, h('span', {}, 'Send full account names'), toggle(share, (val) => { share = val; }, 'Send full account names')),
    btn('Save Gemini settings', async () => {
      s.geminiEnabled = enabled && !!keyIn.value.trim();
      s.geminiKey = keyIn.value.trim();
      s.geminiModel = modelIn.value.trim() || 'gemini-2.5-flash';
      s.geminiShareAccounts = share;
      await save();
      toast(s.geminiEnabled ? 'Gemini search is on' : 'Gemini search is off');
    }, { kind: 'secondary', ic: 'sparkle' }),
  ));

  // Danger
  const confirmIn = input({ placeholder: 'Type ERASE' });
  wrap.append(group('Erase',
    h('p', { class: 'group-note' }, 'Deletes the vault from this iPhone. Your backup files are not touched.'),
    field('Type ERASE to confirm', confirmIn),
    btn('Erase vault on this iPhone', async () => {
      if (confirmIn.value.trim() !== 'ERASE') { shake(confirmIn); return; }
      await destroyVault();
      ui.setupMode = 'create';
      show('setup');
    }, { kind: 'danger', ic: 'trash' }),
  ));

  const persisted = h('strong', {}, 'checking');
  navigator.storage?.persisted?.().then((p) => { persisted.textContent = p ? 'Protected' : 'Not guaranteed'; }).catch(() => { persisted.textContent = 'Unknown'; });
  wrap.append(group('About',
    h('div', { class: 'kv' }, h('span', {}, 'Entries'), h('strong', {}, String(v.entries.length))),
    h('div', { class: 'kv' }, h('span', {}, 'Storage'), persisted),
    h('p', { class: 'group-note' }, 'Everything is encrypted on this device with AES-256 and a key made from your passphrase. The app has no server and no account. Open it from the Home Screen so iOS keeps its storage.'),
  ));
  return wrap;
}

// ---------------------------------------------------------------- boot

(async () => {
  ui.view = (await hasVault()) ? 'lock' : 'setup';
  render();
})();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
