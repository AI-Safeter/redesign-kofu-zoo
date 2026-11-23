// Checks that quoted words really appear in the interview transcript.
// Free models in particular tend to invent dialogue; the book must only quote what was said.

/** Hangul, Latin letters and digits only: ignores spacing, punctuation and line breaks. */
export const norm = (s) => String(s || "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");

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
 * True when `quote` is (nearly) verbatim from the transcript. Allows light clean-up
 * (dropped fillers like 음/어, small spelling fixes): at least 75% of the quote's
 * three-character sequences must occur in the transcript.
 */
export function isFromTranscript(quote, index) {
  const q = norm(quote);
  if (q.length < 4) return q.length > 0 && index.text.includes(q);
  if (index.text.includes(q)) return true;
  const g = grams(q);
  let hit = 0;
  for (const x of g) if (index.grams.has(x)) hit++;
  return hit / g.size >= 0.75;
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
