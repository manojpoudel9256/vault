// Minimal DOM builder. Everything is created with createElement/textContent, never innerHTML,
// so text from the vault can never be interpreted as markup (no XSS).

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') {
      for (const [p, val] of Object.entries(v as Record<string, string>)) el.style.setProperty(p, val);
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'type' || k === 'hidden') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Runs a DOM swap inside a View Transition when the browser supports it. */
export function transition(swap: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reducedMotion()) doc.startViewTransition(swap);
  else swap();
}

let toastTimer = 0;
export function toast(message: string, tone: 'ok' | 'warn' = 'ok'): void {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 2600);
}

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#%&*+=?';

/** Short "decoding" animation when a secret is revealed. Updates text only. */
export function scramble(el: HTMLElement, finalText: string, ms = 420): void {
  if (reducedMotion() || finalText.length > 64) { el.textContent = finalText; return; }
  const start = performance.now();
  const frame = (now: number) => {
    const p = Math.min(1, (now - start) / ms);
    const fixed = Math.floor(p * finalText.length);
    let out = finalText.slice(0, fixed);
    for (let i = fixed; i < finalText.length; i++) out += finalText[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    el.textContent = out;
    if (p < 1 && el.isConnected) requestAnimationFrame(frame);
    else el.textContent = finalText;
  };
  requestAnimationFrame(frame);
}

export function shake(el: Element): void {
  if (reducedMotion()) return;
  el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }],
    { duration: 380, easing: 'cubic-bezier(.36,.07,.19,.97)' },
  );
}

export function fmtDate(ts: number | null): string {
  if (!ts) return 'never';
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relDays(ts: number | null): number {
  return ts ? Math.floor((Date.now() - ts) / 86_400_000) : Infinity;
}
