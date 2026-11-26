// How the vault list is ordered. Pure functions (no DOM) so they can be tested.
import type { Entry } from './vault';

export type SortMode = 'newest' | 'az' | 'type';

/** Newest first = the entry saved or changed most recently is at the top. */
export function sortEntries(list: Entry[], mode: Exclude<SortMode, 'type'>): Entry[] {
  const byName = (a: Entry, b: Entry) => a.service.localeCompare(b.service) || a.account.localeCompare(b.account);
  return [...list].sort(mode === 'newest' ? (a, b) => b.updatedAt - a.updatedAt || byName(a, b) : byName);
}

/** Heading for the "Newest" list: Today, Yesterday, This week, This month, or the month and year. */
export function timeGroup(ts: number, now = Date.now()): string {
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  const a = new Date(ts), b = new Date(now);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return 'Earlier this month';
  return a.toLocaleDateString('en', { month: 'long', year: 'numeric' });
}
