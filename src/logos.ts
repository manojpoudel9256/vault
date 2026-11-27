// Private logos: icons for your own services (for example your banks). They are imported once from
// a "logo pack" file and kept inside the encrypted vault (and its backups), never in the website's
// code, so the public site does not reveal which services you use.

export interface PrivateLogo {
  /** Shown in Settings only. */
  name: string;
  /** Case-insensitive pattern matched against the entry's service name. */
  match: string;
  /** data:image/png or data:image/webp. */
  img: string;
  /** true = the icon is already a filled square (shown edge to edge). */
  full: boolean;
  /** Tile background behind a non-full icon. */
  bg: string;
}

export interface LogoPackFile { format: 'memo-vault-logos'; version: 1; logos: PrivateLogo[] }

export const LOGO_LIMITS = { maxLogos: 100, maxImgChars: 60_000, maxMatch: 200, maxName: 40 } as const;

const IMG = /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;

/** Compiles a pattern safely; null when it is not a valid, reasonably short pattern. */
export function logoPattern(match: string): RegExp | null {
  if (typeof match !== 'string' || !match || match.length > LOGO_LIMITS.maxMatch) return null;
  try { return new RegExp(match, 'i'); } catch { return null; }
}

export function validLogo(l: unknown): l is PrivateLogo {
  const x = l as Partial<PrivateLogo> | null;
  return !!x && typeof x === 'object'
    && typeof x.name === 'string' && x.name.length > 0 && x.name.length <= LOGO_LIMITS.maxName
    && typeof x.img === 'string' && x.img.length <= LOGO_LIMITS.maxImgChars && IMG.test(x.img)
    && typeof x.full === 'boolean'
    && typeof x.bg === 'string' && COLOR.test(x.bg)
    && logoPattern(x.match as string) !== null;
}

/** Keeps only well-formed logos, copied field by field (nothing else from the file is kept). */
export function cleanLogos(list: unknown): PrivateLogo[] {
  if (!Array.isArray(list)) return [];
  return list.filter(validLogo).slice(0, LOGO_LIMITS.maxLogos)
    .map(({ name, match, img, full, bg }) => ({ name, match, img, full, bg }));
}

/** Reads a logo pack file. Throws a readable message when it is not one. */
export function parseLogoPack(text: string): PrivateLogo[] {
  let f: Partial<LogoPackFile>;
  try { f = JSON.parse(text); } catch { throw new Error('This is not a logo pack file.'); }
  if (!f || f.format !== 'memo-vault-logos' || f.version !== 1 || !Array.isArray(f.logos)) throw new Error('This is not a logo pack file.');
  const logos = cleanLogos(f.logos);
  if (!logos.length) throw new Error('This logo pack has no usable logos.');
  return logos;
}
