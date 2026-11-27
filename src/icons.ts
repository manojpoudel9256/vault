// Phosphor icons (MIT) and Simple Icons brand logos (CC0), bundled at build time.
// No icon CDN, nothing fetched at runtime.
import {
  siAmericanexpress, siApple, siAtlassian, siConfluence, siEpicgames, siFacebook, siFormspree, siGithub, siGmail, siGoogle,
  siGooglegemini, siInstagram, siJcb, siLine, siMastercard, siNetlify, siPaypal, siPubg, siRakuten, siSpotify, siTelegram,
  siTiktok, siUniqlo, siVisa, siWhatsapp, siX, siYoutube, siZara, siZoom,
} from 'simple-icons';
import { logoPattern, type PrivateLogo } from './logos';
const files = import.meta.glob(
  [
    '../node_modules/@phosphor-icons/core/assets/regular/{lock-simple,lock-simple-open,magnifying-glass,plus,eye,eye-slash,copy,check,pencil-simple,clock-counter-clockwise,gear-six,download-simple,upload-simple,sparkle,clipboard-text,trash,x,caret-left,caret-down,warning,shield-check,arrow-right,envelope-simple,bank,wifi-high,google-logo,facebook-logo,instagram-logo,apple-logo,whatsapp-logo,x-logo,linkedin-logo,youtube-logo,microsoft-outlook-logo,github-logo,amazon-logo,spotify-logo,tiktok-logo,telegram-logo,arrows-clockwise,key,file-arrow-up,dice-five,identification-card,phone,map-pin,note,squares-four,airplane-tilt,certificate,steering-wheel,credit-card,password,caret-right,wallet,chart-line-up,currency-btc,laptop,device-mobile,game-controller,slack-logo,paypal-logo,open-ai-logo,train,flame,video-camera,graduation-cap,shopping-bag,database,globe,house-line,house,briefcase,folder-simple,lock-key,cake,user,cigarette-slash,code,money,diamond,piggy-bank,windows-logo,paper-plane-tilt,scan-smiley,sun,moon}.svg',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const cache = new Map<string, SVGElement>();
const parser = new DOMParser();

for (const [path, src] of Object.entries(files)) {
  const name = path.split('/').pop()!.replace('.svg', '');
  const svg = parser.parseFromString(src, 'image/svg+xml').documentElement as unknown as SVGElement;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ic');
  cache.set(name, svg);
}

export type IconName =
  | 'lock-simple' | 'lock-simple-open' | 'magnifying-glass' | 'plus' | 'eye' | 'eye-slash' | 'copy' | 'check'
  | 'pencil-simple' | 'clock-counter-clockwise' | 'gear-six' | 'download-simple' | 'upload-simple' | 'sparkle'
  | 'clipboard-text' | 'trash' | 'x' | 'caret-left' | 'caret-down' | 'warning' | 'shield-check' | 'arrow-right'
  | 'envelope-simple' | 'bank' | 'wifi-high' | 'google-logo' | 'facebook-logo' | 'instagram-logo' | 'apple-logo'
  | 'whatsapp-logo' | 'x-logo' | 'linkedin-logo' | 'youtube-logo' | 'microsoft-outlook-logo' | 'github-logo'
  | 'amazon-logo' | 'spotify-logo' | 'tiktok-logo' | 'telegram-logo' | 'arrows-clockwise' | 'key' | 'file-arrow-up'
  | 'dice-five' | 'identification-card' | 'phone' | 'map-pin' | 'note' | 'squares-four' | 'airplane-tilt'
  | 'certificate' | 'steering-wheel' | 'credit-card' | 'password' | 'caret-right' | 'wallet' | 'chart-line-up'
  | 'currency-btc' | 'laptop' | 'device-mobile' | 'game-controller' | 'slack-logo' | 'paypal-logo' | 'open-ai-logo' | 'train'
  | 'flame' | 'video-camera' | 'graduation-cap' | 'shopping-bag' | 'database' | 'globe' | 'house-line' | 'house' | 'briefcase'
  | 'folder-simple' | 'lock-key' | 'cake' | 'user' | 'cigarette-slash' | 'code' | 'money' | 'diamond' | 'piggy-bank'
  | 'windows-logo' | 'paper-plane-tilt' | 'scan-smiley' | 'sun' | 'moon';

export function icon(name: IconName): SVGElement {
  const tpl = cache.get(name);
  if (!tpl) throw new Error('Missing icon ' + name);
  return document.importNode(tpl, true);
}

/**
 * Well-known services get their official logo (from Simple Icons, bundled into the app) in the
 * brand colour on a white tile, like the app icon. Dark brands get a white logo on black.
 * Private logos (your own services, e.g. local banks) come from the encrypted vault, never from
 * this code, and are checked first. Nothing is fetched at runtime.
 */
export interface Brand { bg: string; ink: string; glyph: IconName | { letter: string } | { path: string } | { img: string; full?: boolean } }
const W = '#fff';

let logoSource: () => PrivateLogo[] = () => [];
let compiledFrom: PrivateLogo[] | null = null;
let compiled: [RegExp, Brand][] = [];
/** Where private logos come from (the unlocked vault's settings). */
export function setLogoSource(fn: () => PrivateLogo[]): void { logoSource = fn; compiledFrom = null; }
function privateBrands(): [RegExp, Brand][] {
  const list = logoSource();
  if (list !== compiledFrom) {
    compiledFrom = list;
    compiled = list.flatMap((l): [RegExp, Brand][] => {
      const re = logoPattern(l.match);
      return re ? [[re, { bg: l.bg, ink: W, glyph: { img: l.img, full: l.full } }]] : [];
    });
  }
  return compiled;
}
/** Official logo in brand colour on white. */
const onWhite = (icon: { path: string; hex: string }, hex = icon.hex): Brand => ({ bg: W, ink: '#' + hex.replace('#', ''), glyph: { path: icon.path } });
/** Official logo in white on the (dark) brand colour. */
const onDark = (icon: { path: string; hex: string }, bg = '#' + icon.hex): Brand => ({ bg, ink: W, glyph: { path: icon.path } });

const BRANDS: [RegExp, Brand][] = [
  [/rakuten/i, onWhite(siRakuten)],
  [/gmail/i, onWhite(siGmail)],
  [/gemini/i, onWhite(siGooglegemini)],
  [/google/i, onWhite(siGoogle)],
  [/facebook|\bfb\b|messenger/i, onWhite(siFacebook)],
  [/instagram|\binsta\b/i, onWhite(siInstagram)],
  [/apple|icloud/i, onDark(siApple, '#000')],
  [/whatsapp/i, onWhite(siWhatsapp)],
  [/twitter|^x\b/i, onDark(siX, '#000')],
  [/linkedin/i, { bg: W, ink: '#0a66c2', glyph: 'linkedin-logo' }],
  [/youtube/i, onWhite(siYoutube)],
  [/microsoft|office 365|outlook|hotmail/i, { bg: W, ink: '#0078d4', glyph: 'windows-logo' }],
  [/github/i, onDark(siGithub)],
  [/amazon/i, { bg: '#232f3e', ink: '#ff9900', glyph: 'amazon-logo' }],
  [/spotify/i, { bg: '#000', ink: '#1ed760', glyph: { path: siSpotify.path } }],
  [/tiktok/i, onDark(siTiktok, '#000')],
  [/telegram/i, onWhite(siTelegram)],
  [/slack/i, { bg: W, ink: '#4a154b', glyph: 'slack-logo' }],
  [/paypal/i, onWhite(siPaypal)],
  [/chatgpt|openai/i, { bg: '#000', ink: W, glyph: 'open-ai-logo' }],
  [/zoom/i, onWhite(siZoom)],
  [/\bline\b/i, onWhite(siLine)],
  [/netlify/i, onWhite(siNetlify, '#00ad9f')],
  [/zara/i, onDark(siZara, '#000')],
  [/confluence/i, onWhite(siConfluence, '#1868db')],
  [/atlassian|jira/i, onWhite(siAtlassian)],
  [/epic games/i, onDark(siEpicgames, '#2a2a2a')],
  [/formspree/i, onWhite(siFormspree)],
  [/pubg/i, { bg: '#000', ink: '#f4b942', glyph: { path: siPubg.path } }],
  [/uniqlo/i, onWhite(siUniqlo)],
  [/\bvisa\b/i, onWhite(siVisa)],
  [/master ?card/i, onWhite(siMastercard)],
  [/\bjcb\b/i, onWhite(siJcb)],
  [/amex|american express/i, onWhite(siAmericanexpress)],
];

export function brandFor(service: string): Brand | null {
  for (const [re, b] of privateBrands()) if (re.test(service)) return b;
  for (const [re, b] of BRANDS) if (re.test(service)) return b;
  return null;
}

/** Vault's own logo: a speech bubble with a keyhole cut out ("ask your vault"). Same shape as public/icons/logo.svg. */
export function appLogo(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '16 18 68 70');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('app-logo');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('fill-rule', 'evenodd');
  p.setAttribute('d', 'M34 22H66A14 14 0 0 1 80 36V56A14 14 0 0 1 66 70H50L31 84L36 70H34A14 14 0 0 1 20 56V36A14 14 0 0 1 34 22Z'
    + 'M45.8 48.8A8 8 0 1 1 54.2 48.8L55.5 61H44.5Z');
  svg.append(p);
  return svg;
}

/** Builds a Simple Icons logo (24x24 path) as an SVG element. No innerHTML. */
export function logoSvg(path: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ic', 'ic-logo');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}
