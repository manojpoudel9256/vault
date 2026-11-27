// Categories decide the icon, the form labels, how a value is shown, and extra search words.
import type { IconName } from './icons';

export type SecretType = 'password' | 'pin' | 'number' | 'text';
export type Category = 'login' | 'bank' | 'card' | 'id' | 'phone' | 'address' | 'wifi' | 'note';

export interface CategoryDef {
  id: Category;
  label: string;
  plural: string;
  icon: IconName;
  hint: string;
  nameLabel: string;
  namePlaceholder: string;
  picks: string[];
  accountLabel: string;
  accountPlaceholder: string;
  valueLabel: Partial<Record<SecretType, string>>;
  types: SecretType[];
  masked: boolean;
  multiline: boolean;
  notesPlaceholder: string;
  keywords: string[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    id: 'login', label: 'Password', plural: 'Passwords', icon: 'key', hint: 'Email, social media and apps',
    nameLabel: 'Service', namePlaceholder: 'Gmail, Facebook, Daraz', picks: ['Gmail', 'Facebook', 'Instagram', 'TikTok', 'Apple ID'],
    accountLabel: 'Email or username', accountPlaceholder: 'you@gmail.com',
    valueLabel: { password: 'Password' }, types: ['password'], masked: true, multiline: false,
    notesPlaceholder: 'Recovery email, security question', keywords: ['password', 'login', 'email', 'social', 'app', 'account'],
  },
  {
    id: 'bank', label: 'Bank & PIN', plural: 'Bank & PINs', icon: 'bank', hint: 'ATM PIN, mobile banking, cards, wallets',
    nameLabel: 'Bank, card or wallet', namePlaceholder: 'Your bank, eSewa, PayPal', picks: ['Mobile banking', 'ATM card', 'eSewa', 'Khalti', 'PayPal'],
    accountLabel: 'Login ID or account (optional)', accountPlaceholder: 'Login ID, account or card',
    valueLabel: { pin: 'PIN', password: 'Password', number: 'Account no.' }, types: ['pin', 'password', 'number'], masked: true, multiline: false,
    notesPlaceholder: 'Branch, SWIFT code, whose account', keywords: ['bank', 'pin', 'atm', 'card', 'wallet', 'banking', 'mpin', 'tpin', 'account'],
  },
  {
    id: 'card', label: 'Card', plural: 'Cards', icon: 'credit-card', hint: 'Credit and debit cards: number, security code',
    nameLabel: 'Card', namePlaceholder: 'Rakuten Card, Visa debit', picks: ['Rakuten Card', 'Visa debit', 'Mastercard'],
    accountLabel: 'Name on card (optional)', accountPlaceholder: 'Name as printed',
    valueLabel: { number: 'Card number', pin: 'Security code (CVV)' }, types: ['number', 'pin'], masked: true, multiline: false,
    notesPlaceholder: 'Expiry date (MM/YY), card brand', keywords: ['card', 'credit', 'debit', 'visa', 'mastercard', 'jcb', 'amex', 'cvv', 'cvc', 'security code', 'expiry'],
  },
  {
    id: 'id', label: 'ID document', plural: 'ID documents', icon: 'identification-card', hint: 'Citizenship, passport, driving licence',
    nameLabel: 'Document', namePlaceholder: 'Citizenship, Passport', picks: ['Citizenship', 'Passport', 'Driving licence', 'National ID (NID)', 'PAN', 'Voter ID'],
    accountLabel: 'Name on document (optional)', accountPlaceholder: 'Full name',
    valueLabel: { text: 'Document number' }, types: ['text'], masked: true, multiline: false,
    notesPlaceholder: 'Issue date, expiry date, issuing office', keywords: ['id', 'document', 'number', 'card', 'citizenship', 'passport', 'licence', 'license'],
  },
  {
    id: 'phone', label: 'Phone number', plural: 'Phone numbers', icon: 'phone', hint: 'Your numbers and important contacts',
    nameLabel: 'Label', namePlaceholder: 'My Ncell, My NTC, Home', picks: ['My Ncell', 'My NTC', 'Home', 'Office'],
    accountLabel: 'Owner (optional)', accountPlaceholder: 'Me, Father, Office',
    valueLabel: { number: 'Phone number' }, types: ['number'], masked: false, multiline: false,
    notesPlaceholder: 'Optional', keywords: ['phone', 'mobile', 'number', 'contact', 'sim', 'ncell', 'ntc'],
  },
  {
    id: 'address', label: 'Address', plural: 'Addresses', icon: 'map-pin', hint: 'Current, permanent and other addresses',
    nameLabel: 'Label', namePlaceholder: 'Current address', picks: ['Current address', 'Permanent address', 'Office address'],
    accountLabel: 'Person (optional)', accountPlaceholder: 'Me',
    valueLabel: { text: 'Address' }, types: ['text'], masked: false, multiline: true,
    notesPlaceholder: 'Landmark, ward number, postal code', keywords: ['address', 'home', 'house', 'location', 'ward', 'tole'],
  },
  {
    id: 'wifi', label: 'Wi-Fi', plural: 'Wi-Fi', icon: 'wifi-high', hint: 'Network names and passwords',
    nameLabel: 'Network name', namePlaceholder: 'Home WiFi', picks: [],
    accountLabel: 'Location (optional)', accountPlaceholder: 'Home, office',
    valueLabel: { password: 'Wi-Fi password' }, types: ['password'], masked: true, multiline: false,
    notesPlaceholder: 'Router login, provider', keywords: ['wifi', 'wi-fi', 'internet', 'router', 'network'],
  },
  {
    id: 'note', label: 'Other', plural: 'Other', icon: 'note', hint: 'Anything else you want to keep private',
    nameLabel: 'Title', namePlaceholder: 'Locker code, insurance number', picks: [],
    accountLabel: 'Detail (optional)', accountPlaceholder: 'Optional',
    valueLabel: { text: 'Secret' }, types: ['text'], masked: true, multiline: true,
    notesPlaceholder: 'Optional', keywords: ['other', 'note', 'secret'],
  },
];

export const cat = (id: Category | undefined): CategoryDef => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0];

const DOC = /passport|citizen|nagarikta|licen[cs]e|driving|national id|\bnid\b|\bpan\b|voter/i;

/** Guesses a category from the name and value. Used for old entries and for imports. */
export function inferCategory(service: string, type: SecretType | 'other', value = ''): Category {
  const s = service.toLowerCase();
  if (/wi-?fi|router|wlan/.test(s)) return 'wifi';
  if (DOC.test(s)) return 'id';
  if (/address|\bghar\b/.test(s)) return 'address';
  if (/phone|mobile|ncell|\bntc\b|\bsim\b|contact/.test(s) && /^[+\d][\d\s-]{6,}$/.test(value.trim())) return 'phone';
  if (type === 'pin' || /bank|atm|card|esewa|khalti|wallet|ime pay|fonepay/.test(s)) return 'bank';
  return 'login';
}

/** The value type a category uses (bank keeps whatever it already is). */
export function typeFor(category: Category, current: SecretType | 'other'): SecretType {
  const def = cat(category);
  if (def.types.includes(current as SecretType)) return current as SecretType;
  return def.types[0];
}

/** Specific icon for an entry: document kind first, then the category icon. */
export function entryIconName(category: Category, service: string, account = ''): IconName {
  const s = service;
  if (category === 'id') {
    if (/passport/i.test(s)) return 'airplane-tilt';
    if (/licen[cs]e|driving/i.test(s)) return 'steering-wheel';
    if (/citizen|nagarikta/i.test(s)) return 'certificate';
    if (/pension/i.test(s)) return 'piggy-bank';
    return 'identification-card';
  }
  if (category === 'card') return 'credit-card';
  if (category === 'bank') {
    if (/card|vpass|e-?navi/i.test(s)) return 'credit-card';
    if (/bit|crypto|coin|bybit|binance/i.test(s)) return 'currency-btc';
    if (/securit|share|trading|stock|invest|\bxm\b/i.test(s)) return 'chart-line-up';
    if (/express|remit|transfer|ime pay/i.test(s)) return 'paper-plane-tilt';
    if (/pay|wallet|esewa|khalti/i.test(s)) return 'wallet';
    return 'bank';
  }
  if (category === 'address') {
    if (/friend|father|mother|brother|sister/i.test(account)) return 'user';
    if (/home|current|room|ghar/i.test(s)) return 'house';
    return 'map-pin';
  }
  if (category === 'note') {
    if (/birthday|bday/i.test(s)) return 'cake';
    if (/ring|size/i.test(s)) return 'diamond';
    if (/api|key|token/i.test(s)) return 'code';
    if (/salary|pay ?slip/i.test(s)) return 'money';
    if (/cigarette|smok/i.test(s)) return 'cigarette-slash';
    if (/pubg|game/i.test(s)) return 'game-controller';
    return 'note';
  }
  if (category === 'login') {
    if (/laptop|\bpc\b|computer/i.test(s)) return 'laptop';
    if (/phone|mobile lock|poco|iphone/i.test(s)) return 'device-mobile';
    if (/keepsafe|vault|locker/i.test(s)) return 'lock-key';
    if (/mysql|database|\bdb\b/i.test(s)) return 'database';
    if (/file share|share folder|file server|\bnas\b/i.test(s)) return 'folder-simple';
    if (/website|site|domain|server/i.test(s)) return 'globe';
    if (/room|agent|house|apartment/i.test(s)) return 'house-line';
    if (/school|career|jlpt|toeic|exam(?!ple)|gakuen|university/i.test(s)) return 'graduation-cap';
    if (/buyma|shop|store|point/i.test(s)) return 'shopping-bag';
    if (/company|work|office/i.test(s)) return 'briefcase';
    if (/mail/i.test(s)) return 'envelope-simple';
  }
  return cat(category).icon;
}
