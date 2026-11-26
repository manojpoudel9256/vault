// Turns text copied from Apple Notes into draft entries. Runs only on the device.
// It is heuristic: every draft is shown for review before anything is saved.
import { inferCategory, typeFor, type Category, type SecretType } from './categories';

export interface Draft {
  category?: Category;
  service: string;
  account: string;
  tags?: string[];
  type: SecretType;
  secret: string;
  notes: string;
}

const PASS_KEY = /^(password|passwords|pass|pwd|passwd|pw|p\/w|login password|log in password|passward)$/i;
const PIN_KEY = /^(pin|pin code|pincode|mpin|m-pin|m pin|tpin|t-pin|t pin|atm|atm pin|txn pin|transaction pin|login pin|4 digit|4-digit|4 digit pin|4-digit pin|6 digit|6-digit|digit|passcode|code|security code)$/i;
const ACCOUNT_KEY = /^(email|e-mail|mail|gmail|user|username|user name|user id|userid|id|login|login id|account|account no|account number|acc|a\/c|ac|phone|mobile|number|no|customer id|client id)$/i;
const EMAIL = /[\w.%+-]+@[\w.-]+\.[a-z]{2,}/i;
const PHONE = /^\+?\d[\d\s-]{7,}$/;

const SUFFIX = /^(.*?)[\s\-_:]*\b(login password|log in password|password|passward|passwd|pwd|pass|atm pin|pin code|pincode|login pin|transaction pin|txn pin|mpin|m-pin|tpin|t-pin|(?:4|four|6|six)[ -]?digit(?: pin| code)?|pin|passcode|email|e-mail|username|user name|user id|userid|login id)$/i;

const DOC_KEY = /^(?:my\s+)?(passport|citizenship certificate|citizenship|citizen ship|nagarikta|driving licen[cs]e|licen[cs]e|national id|nid|pan card|pan|voter id)(?:\s*(?:no\.?|number|num|card no\.?|card number|#))?$/i;
const ADDRESS_KEY = /^(?:my\s+)?((?:current|permanent|temporary|home|office)\s+)?address$/i;
const PHONE_KEY = /^(?:my\s+)?(phone|mobile|cell|ncell|ntc|sim|contact)(?:\s*(?:no\.?|number|num))?$/i;

function docName(word: string): string {
  const w = word.toLowerCase();
  if (w.startsWith('passport')) return 'Passport';
  if (/citizen|nagarikta/.test(w)) return 'Citizenship';
  if (/licen/.test(w)) return 'Driving licence';
  if (/national|nid/.test(w)) return 'National ID (NID)';
  if (w.startsWith('pan')) return 'PAN';
  if (w.startsWith('voter')) return 'Voter ID';
  return word;
}

const DEVICE_KEY = /^(mobile|phone|iphone|android|pc|computer|laptop|desktop|tablet|ipad|work|personal|office)(?:\s+(?:login|log in|app|id))?$/i;

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** ID documents, addresses and phone numbers written as "Key: value". */
function specialEntry(key: string, value: string, inService: boolean): Draft | null {
  let m = key.match(DOC_KEY);
  if (m) return { category: 'id', service: docName(m[1]), account: '', type: 'text', secret: value, notes: '' };
  m = key.match(ADDRESS_KEY);
  if (m) return { category: 'address', service: sentence(m[1] ? `${m[1].trim()} address` : 'Address'), account: '', type: 'text', secret: value, notes: '' };
  m = key.match(PHONE_KEY);
  if (m && !inService && PHONE.test(value.trim())) {
    const w = m[1].toLowerCase();
    return { category: 'phone', service: w === 'ncell' ? 'My Ncell' : w === 'ntc' ? 'My NTC' : 'My phone', account: '', type: 'number', secret: value.trim(), notes: '' };
  }
  return null;
}

type KeyKind ={ kind: 'password' | 'pin' | 'account' | null; prefix: string };

/** "nabil bank pin" -> { kind: 'pin', prefix: 'nabil bank' } */
function keyKind(key: string): KeyKind {
  if (PASS_KEY.test(key)) return { kind: 'password', prefix: '' };
  if (PIN_KEY.test(key)) return { kind: 'pin', prefix: '' };
  if (ACCOUNT_KEY.test(key)) return { kind: 'account', prefix: '' };
  const m = key.match(SUFFIX);
  if (!m || !m[1].trim()) return { kind: null, prefix: '' };
  const word = m[2].toLowerCase();
  const kind = /pass|pwd/.test(word) && !/passcode/.test(word) ? 'password' : /mail|user|id/.test(word) ? 'account' : 'pin';
  return { kind, prefix: clean(m[1]) };
}

const clean = (s: string) => s.replace(/^[\s\-–—•*·▪◦>]+/, '').replace(/[\s:]+$/, '').trim();

function splitKV(line: string): [string, string] | null {
  const m = line.match(/^\s*([^:=]{1,48}?)\s*[:=]\s*(.+)$/);
  if (m) return [clean(m[1]).toLowerCase(), m[2].trim()];
  const d = line.match(/^\s*([a-z][a-z0-9 /-]{0,24}?)\s+[-–—]\s+(.+)$/i);
  if (d && [PASS_KEY, PIN_KEY, ACCOUNT_KEY, DOC_KEY, ADDRESS_KEY, PHONE_KEY].some((re) => re.test(clean(d[1])))) return [clean(d[1]).toLowerCase(), d[2].trim()];
  return null;
}

function inline(line: string, defaultService: string): Draft[] {
  let parts = line.split(/\s+[-–—|]\s+|\t|,\s+|\s{2,}/).map(clean).filter(Boolean);
  if (parts.length < 2) {
    // Plain spaces only: accept it only when it clearly looks like "Name secret" or has a keyword/email.
    parts = line.split(/\s+/).map(clean).filter(Boolean);
    const hasHint = parts.some((p) => PASS_KEY.test(p) || PIN_KEY.test(p) || EMAIL.test(p));
    const looksSecret = /[\d\W_]/.test(parts[parts.length - 1] ?? '');
    if (!hasHint && !(parts.length <= 3 && looksSecret)) return [];
  }
  if (parts.length < 2) return [];
  let service = defaultService;
  let account = '';
  let nextType: SecretType | null = null;
  const rest: { value: string; type: SecretType | null }[] = [];
  for (const p of parts) {
    if (PASS_KEY.test(p)) { nextType = 'password'; continue; }
    if (PIN_KEY.test(p)) { nextType = 'pin'; continue; }
    if (!account && (EMAIL.test(p) || PHONE.test(p))) { account = p; continue; }
    rest.push({ value: p, type: nextType });
    nextType = null;
  }
  if (rest.length > 1 && (!service || (/^\p{Lu}/u.test(rest[0].value) && rest[0].value.toLowerCase() !== service.toLowerCase()))) {
    service = rest.shift()!.value;
  }
  // "Ncell 9841234567": a name and a phone number
  if (account && PHONE.test(account) && rest.length <= 1 && (rest[0]?.value || service)) {
    return [{ category: 'phone', service: rest[0]?.value || service, account: '', type: 'number', secret: account, notes: '' }];
  }
  if (!rest.length || !service) return [];
  const last = rest.pop()!;
  const type: SecretType = last.type ?? (/^\d{4,6}$/.test(last.value) ? 'pin' : 'password');
  const notes = rest.map((r) => r.value).join(' ');
  return [{ service, account, type, secret: last.value, notes }];
}

const titleIfLower = (s: string) => (s === s.toLowerCase() ? s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s);

export function parseNotes(text: string): { drafts: Draft[]; skipped: string[] } {
  const drafts: Draft[] = [];
  const skipped: string[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // "Current address:" on its own line, followed by the address lines
    const heading = lines[0].replace(/[:\s]+$/, '').toLowerCase();
    if (lines.length > 1 && ADDRESS_KEY.test(heading) && !lines[0].match(/:\s*\S/)) {
      drafts.push({ category: 'address', service: sentence(heading.replace(/^my\s+/, '')), account: '', type: 'text', secret: lines.slice(1).join('\n'), notes: '' });
      continue;
    }
    let service = '';
    let account = '';
    let pending: Draft[] = [];
    let notes: string[] = [];
    const flush = () => {
      for (const d of pending) drafts.push({ ...d, service: d.service || service, account: d.account || account, notes: [d.notes, ...notes].filter(Boolean).join(' · ') });
      pending = [];
      notes = [];
    };

    lines.forEach((line, i) => {
      const kv = splitKV(line);
      if (kv) {
        const [k, v] = kv;
        // "Mobile: you@gmail.com / secret" under a service heading -> a login used on that device
        const dev = k.match(DEVICE_KEY);
        if (dev && service && !PHONE.test(v.trim())) {
          const got = inline(v.replace(/\s+\/\s+/g, ' - '), service);
          const label = /^pc$/i.test(dev[1]) ? 'PC' : sentence(dev[1]);
          if (got.length) { if (pending.length) flush(); for (const d of got) drafts.push({ ...d, service, tags: [label] }); return; }
        }
        const special = specialEntry(k, v, !!service);
        if (special) { drafts.push(special); return; }
        const { kind, prefix } = keyKind(k);
        // Work out which service this line belongs to, e.g. "Nabil Bank mobile banking password".
        let svc = service;
        let note = '';
        if (prefix) {
          if (!service) { service = titleIfLower(prefix); svc = service; }
          else if (prefix.toLowerCase().startsWith(service.toLowerCase())) { note = prefix.slice(service.length).trim(); }
          else svc = titleIfLower(prefix);
        }
        if (kind === 'password') pending.push({ service: svc, account: '', type: 'password', secret: v, notes: note });
        else if (kind === 'pin') pending.push({ service: svc, account: '', type: /^\d{3,8}$/.test(v) ? 'pin' : 'password', secret: v, notes: note });
        else if (kind === 'account' || (EMAIL.test(v) && !v.includes(' '))) {
          if (pending.length) { flush(); account = v; }
          else if (account) notes.push(line); // e.g. a phone number after the email: keep it as a note
          else account = v;
          if (kind !== 'account' && !service) service = clean(k);
        } else if (i === 0 || !service) {
          // "Gmail: abc@gmail.com / secret123" style
          const got = inline(v, clean(kv[0].replace(/^./, (c) => c.toUpperCase())) || clean(line.split(/[:=]/)[0]));
          if (got.length) { if (!service) service = got[0].service; pending.push(...got); }
          else if (!service) service = clean(line.split(/[:=]/)[0]);
          else notes.push(line);
        } else notes.push(line);
        return;
      }
      if (i === 0 && lines.length > 1 && !EMAIL.test(line) && line.split(/\s+/).length <= 5) { service = clean(line); return; }
      if (EMAIL.test(line) && line.trim().split(/\s+/).length === 1) { if (pending.length) flush(); account = line.trim(); return; }
      const got = inline(line, service);
      if (got.length) pending.push(...got);
      else skipped.push(line);
    });
    flush();
  }

  // Keep the service name in its original letters but tidy the case of all-lowercase names.
  for (const d of drafts) {
    if (d.service === d.service.toLowerCase()) d.service = d.service.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    d.category ??= inferCategory(d.service, d.type, d.secret);
    d.type = typeFor(d.category, d.type);
  }
  return { drafts: drafts.filter((d) => d.secret), skipped };
}
