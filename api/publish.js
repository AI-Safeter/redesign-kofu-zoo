// Publishes a book as a read-only page (/read?id=…). Publishing again with the id and the
// edit token returned the first time replaces the same page.
import { createHash, randomBytes } from "node:crypto";
import { checkAccess, errorResponse, json } from "./_lib/http.js";
import { canPublish, loadBook, saveBook } from "./_lib/books.js";

const MAX_BYTES = 3_000_000;
const ID = /^[A-Za-z0-9_-]{12}$/;
const hash = (token) => createHash("sha256").update(String(token)).digest("hex");

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;
  if (!canPublish()) return errorResponse("발행 기능이 설정되지 않았어요.", 503);

  const raw = await request.text();
  if (raw.length > MAX_BYTES) return errorResponse("책이 너무 커서 발행할 수 없어요.", 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse("잘못된 요청입니다.");
  }
  const book = body?.book;
  if (!book || typeof book !== "object" || typeof book.title !== "string" || !Array.isArray(book.chapters)) {
    return errorResponse("잘못된 책 데이터입니다.");
  }

  let id = ID.test(body.id || "") ? body.id : null;
  let token = null;
  if (id) {
    const existing = await loadBook(id);
    if (!existing) id = null; // gone: publish as a new page
    else if (existing.editHash !== hash(body.token)) return errorResponse("이 책을 다시 발행할 권한이 없어요.", 403);
  }
  if (!id) {
    id = randomBytes(9).toString("base64url"); // 12 characters
    token = randomBytes(24).toString("base64url");
  }

  await saveBook(id, { ...readerCopy(book), editHash: hash(token || body.token), publishedAt: new Date().toISOString() });
  return json({ id, token }); // token only the first time; the browser keeps it with the book
}

/** Only what the reader shows: no interview settings, model names or check lists. */
function readerCopy(b) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...pick(b, ["kind", "speakerRole", "speaksAs", "title", "subtitle", "subjectName", "birthYear", "birthplace", "epigraph", "people", "prologue", "lastWords", "timeline", "epilogue", "createdAt"]),
    chapters: b.chapters.map((c) => pick(c, ["title", "yearFrom", "yearTo", "place", "summary", "paragraphs", "pullQuote", "excerpt"])),
  };
}
