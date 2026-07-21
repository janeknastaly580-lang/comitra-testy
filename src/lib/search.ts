/**
 * Lightweight "smart" search — Google-ish ranking with typo tolerance.
 * Matches whole-query and per-token against the name (and, lightly, the bio),
 * scores each candidate, and returns the matches sorted by relevance.
 */

export interface Searchable {
  name: string;
  bio?: string;
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Damerau (optimal string alignment) edit distance: insertions, deletions,
 * substitutions AND adjacent transpositions each cost 1 — so "kia"→"kai" is 1.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[a.length][b.length];
}

/** Are all chars of `q` present in `text` in order (fuzzy subsequence)? */
function isSubsequence(q: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < q.length; j++) {
    if (text[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Score one query token against one word. Higher = better. */
function tokenWordScore(token: string, word: string): number {
  if (word === token) return 100;
  if (word.startsWith(token)) return 82;
  if (token.length >= 2 && word.includes(token)) return 55;
  const d = editDistance(token, word);
  // Allow ~1 typo per 3 chars (plus transpositions) so "kia"->"kai", "nva"->"nova" match.
  const tolerance = Math.max(1, Math.round(Math.max(token.length, word.length) / 3));
  if (d <= tolerance) return Math.max(20, 60 - d * 16);
  if (token.length >= 3 && isSubsequence(token, word)) return 18;
  return 0;
}

export function scoreMatch(item: Searchable, rawQuery: string): number {
  const q = norm(rawQuery);
  if (!q) return 0;
  const name = norm(item.name);
  const bio = norm(item.bio ?? '');

  // Strong signals on the full query vs the full name.
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800;
  const nameWords = name.split(/\s+/).filter(Boolean);
  if (nameWords.some((w) => w.startsWith(q))) return 650;
  if (name.includes(q)) return 520;

  // Token-by-token scoring (handles "kai vec", out-of-order, partials, typos).
  const bioWords = bio.split(/\s+/).filter(Boolean);
  const qTokens = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of qTokens) {
    let best = 0;
    for (const w of nameWords) best = Math.max(best, tokenWordScore(t, w));
    if (best < 30) {
      // Fall back to a (weaker) bio match so keyword search works too.
      if (bio.includes(t)) best = Math.max(best, 24);
      else for (const w of bioWords) best = Math.max(best, tokenWordScore(t, w) * 0.5);
    }
    score += best;
  }
  // Require the average token to actually match something.
  return score >= qTokens.length * 14 ? score : 0;
}

/** Returns items that match `query`, sorted by relevance (best first). */
export function smartSearch<T extends Searchable>(items: T[], query: string): T[] {
  if (!query.trim()) return items;
  return items
    .map((it) => ({ it, s: scoreMatch(it, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}
