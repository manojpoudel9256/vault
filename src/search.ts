// On-device natural-language search. Nothing here touches the network.
import type { Entry, SecretType } from './vault';
import { cat } from './categories';

const STOP = new Set([
  'what', 'whats', 'what\'s', 'is', 'are', 'was', 'my', 'mine', 'the', 'a', 'an', 'of', 'for', 'to', 'me', 'give', 'show',
  'tell', 'please', 'pls', 'plz', 'i', 'need', 'find', 'get', 'account', 'acc', 'login', 'log', 'details', 'detail', 'and',
  'with', 'in', 'on', 'which', 'do', 'did', 'you', 'can', 'could', 'latest', 'new', 'correct', 'that', 'this', 'it',
  'one', 'number', 'no', 'id', 'info', 'credentials', 'credential', 'sign', 'signin', 'use', 'used', 'remember', 'forgot',
]);

const PIN_WORDS = new Set(['pin', 'pins', 'mpin', 'tpin', 'atm', 'digit', 'digits', '4digit', 'passcode', 'code', 'otp']);
const PASS_WORDS = new Set(['password', 'passwords', 'pass', 'pwd', 'passwd', 'pw', 'passw']);

const ALIASES: Record<string, string[]> = {
  google: ['gmail', 'youtube'], gmail: ['google', 'email', 'mail'], mail: ['gmail', 'email', 'outlook'], email: ['gmail', 'mail'],
  fb: ['facebook'], facebook: ['fb', 'meta', 'messenger'], messenger: ['facebook'], meta: ['facebook'],
  insta: ['instagram'], ig: ['instagram'], instagram: ['insta', 'ig'],
  yt: ['youtube'], youtube: ['yt', 'google'],
  x: ['twitter'], twitter: ['x'], wa: ['whatsapp'], whatsapp: ['wa'],
  apple: ['icloud', 'appleid'], icloud: ['apple', 'appleid'], appleid: ['apple', 'icloud'],
  ms: ['microsoft'], microsoft: ['outlook', 'hotmail', 'office'], outlook: ['microsoft', 'hotmail'], hotmail: ['outlook', 'microsoft'],
  wifi: ['wi-fi', 'wlan', 'router'], router: ['wifi'],
  bank: ['banking', 'ebanking', 'netbanking', 'mobilebanking'], ebanking: ['bank'], netbanking: ['bank'],
  mother: ['mom', 'mummy', 'aama'], mom: ['mother'], mummy: ['mother'], aama: ['mother'],
  esewa: ['wallet'], khalti: ['wallet'], wallet: ['esewa', 'khalti'],
  linkedin: ['li'], amazon: ['amzn'], netflix: ['nflx'],
  licence: ['license', 'driving'], license: ['licence', 'driving'], driving: ['licence', 'license'],
  citizenship: ['citizen', 'nagarikta'], citizen: ['citizenship'], nagarikta: ['citizenship'],
  nid: ['national'], national: ['nid'],
  phone: ['mobile', 'ncell', 'ntc', 'contact', 'iphone'], mobile: ['phone', 'iphone', 'android', 'ncell', 'ntc'], ncell: ['phone', 'mobile'], ntc: ['phone', 'mobile'],
  address: ['ghar', 'home', 'location'], ghar: ['address', 'home'], home: ['address', 'house'],
  pc: ['computer', 'laptop', 'desktop'], computer: ['pc', 'laptop', 'desktop'], laptop: ['pc', 'computer'], desktop: ['pc', 'computer'],
  iphone: ['mobile', 'phone'], android: ['mobile', 'phone'],
};

export interface Query {
  raw: string;
  terms: string[];
  emails: string[];
  typeHint: SecretType | null;
}

export function parseQuery(raw: string): Query {
  // Japanese 'My Number' card is one word for search, not 'my' + 'number'.
  const lower = raw.toLowerCase().replace(/\bmy\s*number\b/g, 'mynumber');
  const emails = lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  let typeHint: SecretType | null = null;
  if (/\b(4|four|6|six)[\s-]?digit|\bpin\b|\bmpin\b|\btpin\b|\batm\b|passcode/.test(lower)) typeHint = 'pin';
  else if (/\bpass(word|wd|w)?s?\b|\bpwd\b/.test(lower)) typeHint = 'password';

  const terms: string[] = [];
  for (const w of lower.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, ' ').split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w) || PIN_WORDS.has(w) || PASS_WORDS.has(w)) continue;
    if (/^\d$/.test(w) || w === 'four' || w === 'six') continue;
    terms.push(w);
  }
  const META = new Set(['email', 'mail', 'username', 'user', 'gmail']);
  const named = terms.filter((t) => !META.has(t));
  const finalTerms = named.length && terms.some((t) => t === 'email' || t === 'username' || t === 'user') ? terms.filter((t) => t !== 'email' && t !== 'username' && t !== 'user' && t !== 'mail') : terms;
  return { raw, terms: finalTerms, emails, typeHint };
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function termMatch(term: string, field: string, fieldTokens: string[]): number {
  let best = 0;
  for (const t of fieldTokens) {
    if (t === term) return 1;
    // "spoti" -> "spotify", or "passwords" -> "password"; but never "computer" -> "com"
    const prefix = (term.length >= 3 && t.startsWith(term)) || (t.length >= 4 && t.length >= term.length * 0.7 && term.startsWith(t));
    if (prefix) best = Math.max(best, 0.85);
    else if (term.length >= 4 && t.length >= 4) {
      const sim = 1 - lev(term, t) / Math.max(term.length, t.length);
      if (sim >= 0.72) best = Math.max(best, sim * 0.75);
    }
  }
  const joined = field.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (best < 0.7 && term.length >= 3 && joined.includes(term)) best = 0.7;
  return best;
}

export interface Hit { entry: Entry; score: number }

export function search(entries: Entry[], q: Query): Hit[] {
  if (!q.terms.length && !q.emails.length) {
    if (!q.typeHint) return [];
    return entries.filter((e) => e.type === q.typeHint).map((entry) => ({ entry, score: 1 }));
  }
  const hits: Hit[] = [];
  const wantPhone = /(phone|mobile|contact|cell)\s*(number|no\b|num)/i.test(q.raw) && !q.typeHint;
  for (const e of entries) {
    const def = cat(e.category);
    const fields: [string, number][] = [
      [e.service, 3], [e.tags.join(' '), 2.6], [e.account, 2], [`${def.plural} ${def.keywords.join(' ')}`, 1.4], [e.notes, 0.6],
    ];
    const ft = fields.map(([f, w]) => [f, tokens(f), w] as const);
    let score = 0;
    let matched = 0;
    for (const term of q.terms) {
      const variants: [string, number][] = [[term, 1], ...(ALIASES[term] ?? []).map((a) => [a, 0.8] as [string, number])];
      let best = 0;
      for (const [v, vw] of variants) for (const [f, t, w] of ft) best = Math.max(best, termMatch(v, f, t) * w * vw);
      if (best > 0) matched++;
      score += best;
    }
    for (const em of q.emails) {
      if (e.account.toLowerCase() === em) { score += 8; matched++; }
      else if (e.account.toLowerCase().includes(em.split('@')[0])) { score += 3; matched++; }
    }
    if (!matched) continue;
    const total = q.terms.length + q.emails.length;
    score *= 0.4 + 0.6 * (matched / total);
    const pinLike = e.type === 'pin' || /\bpin\b|digit|passcode|mpin/i.test(`${e.service} ${e.tags.join(' ')}`);
    if (q.typeHint === 'pin') score *= pinLike ? 1.3 : 0.55;
    else if (q.typeHint === 'password') score *= e.type === 'password' ? 1.2 : e.type === 'pin' ? 0.6 : 0.85;
    // "my phone number" asks for a number, not a phone's lock code
    if (wantPhone) score *= e.category === 'phone' ? 2 : 0.7;
    hits.push({ entry: e, score });
  }
  return hits.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
}

/** "single" = confident answer, "choose" = ask the user which one, "none" = no match. */
export function interpret(hits: Hit[]): 'single' | 'choose' | 'none' {
  if (!hits.length) return 'none';
  if (hits.length === 1) return 'single';
  // Ask "which one?" only when another entry scores close to the best one.
  return hits[1].score < hits[0].score * 0.72 ? 'single' : 'choose';
}
