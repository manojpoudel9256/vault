// Master passphrase strength. Pure functions (no DOM) so they can be tested.

/** 0 = empty, 1 = too short, 2 = okay, 3 = strong, 4 = very strong. */
export function strength(pass: string): number {
  if (!pass) return 0;
  let classes = 0;
  for (const re of [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/]) if (re.test(pass)) classes++;
  const len = [...pass].length;
  if (len < 10) return 1;
  // "aaaaaaaaaaaa" or "121212121212" is long but has almost no variety.
  if (new Set(pass.toLowerCase()).size < 6) return 2;
  if (len >= 20 || (len >= 14 && classes >= 3)) return 4;
  if (len >= 12 && classes >= 2) return 3;
  return 2;
}

/** Why a new master passphrase is too weak, or null when it is acceptable (level 3+). */
export function passphraseProblem(p: string): string | null {
  return strength(p) >= 3 ? null
    : 'Make it stronger: at least 12 characters mixing letters with numbers or symbols, or a sentence of 20+ characters.';
}
