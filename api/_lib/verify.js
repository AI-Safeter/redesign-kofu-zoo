// Checks that quoted words really appear in the interview transcript.
// Free models in particular tend to invent dialogue; the book must only quote what was said.

/** Hangul, Latin letters and digits only: ignores spacing, punctuation and line breaks. */
// Standalone hesitation sounds (음, 어, 으음, 아) are ignored on both sides of a comparison,
// so a quote with fillers removed still matches the transcript.
const FILLERS = /(^|[\s,.])(음+|어+|으음|아+)(?=[\s,.]|$)/g;
const norm = (s) => String(s || "").toLowerCase().replace(FILLERS, "$1").replace(/[^가-힣a-z0-9]/g, "");

function grams(s, n = 3) {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

export function indexTranscript(transcript) {
  const text = norm(transcript);
  return { text, grams: grams(text) };
}

/**
 * True when `quote` is the speaker's own words: its text must appear in the transcript in
 * order, in stretches of at least 4 characters. Small skips between stretches (dropped
 * fillers such as 음/어/그러니까, or a repeated word) are allowed; changed words are not.
 * Spacing and punctuation are ignored.
 */
export function isFromTranscript(quote, index) {
  const q = norm(quote);
  const t = index.text;
  if (!q) return false;
  if (t.includes(q)) return true;
  if (q.length < 8) return false;
  const MIN = 4; // shortest stretch that counts as matching
  const GAP = 25; // most transcript characters that may be skipped between stretches
  // Try every place the opening stretch occurs, since a phrase can appear more than once.
  for (let start = t.indexOf(q.slice(0, MIN)); start >= 0; start = t.indexOf(q.slice(0, MIN), start + 1)) {
    if (alignFrom(q, t, start, MIN, GAP)) return true;
  }
  return false;
}

function alignFrom(q, t, start, MIN, GAP) {
  let i = 0; // position in the quote
  let pos = start; // position in the transcript
  while (i < q.length) {
    // Extend the current stretch as far as it matches.
    let n = 0;
    while (i + n < q.length && pos + n < t.length && q[i + n] === t[pos + n]) n++;
    if (n < Math.min(MIN, q.length - i)) return false;
    i += n;
    pos += n;
    if (i >= q.length) return true;
    // Find the next stretch a little further on (skipped fillers or words).
    const piece = q.slice(i, i + MIN);
    if (piece.length < MIN) return t.slice(pos, pos + GAP + piece.length).includes(piece);
    const next = t.indexOf(piece, pos);
    if (next < 0 || next - pos > GAP) return false;
    // Skipping 안/못/않/없/아니 would reverse the meaning ("돈을 못 받았어요" → "돈을 받았어요").
    if (/안|못|않|없|아니/.test(t.slice(pos, next))) return false;
    pos = next;
  }
  return true;
}

/** Text inside “…”, "…", 「…」 or 『…』 that is long enough to be a quotation. */
export function quotedSpans(paragraph) {
  const spans = [];
  const re = /[“"「『]([^”"」』]{6,})[”"」』]/g;
  let m;
  while ((m = re.exec(paragraph))) spans.push(m[1].trim());
  return spans;
}

/** Share of shared three-character sequences (0–1); used to drop near-duplicate paragraphs. */
export function similarity(a, b) {
  const ga = grams(norm(a));
  const gb = grams(norm(b));
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const x of ga) if (gb.has(x)) shared++;
  return shared / Math.min(ga.size, gb.size);
}

/** Share (0–1) of a sentence's three-character sequences that occur in the transcript. */
export function support(sentence, index) {
  const g = grams(norm(sentence));
  if (!g.size) return 1;
  let hit = 0;
  for (const x of g) if (index.grams.has(x)) hit++;
  return hit / g.size;
}
