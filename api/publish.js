// Publishes a book as a read-only page (/read?id=…). Publishing again with the id and the
// edit token returned the first time replaces the same page; DELETE with them removes it.
import { createHash, randomBytes } from "node:crypto";
import { checkAccess } from "./_lib/access.js";
import { errorResponse, json } from "./_lib/http.js";
import { canPublish, deleteBook, isBookId, loadBook, saveBook } from "./_lib/books.js";

const MAX_BYTES = 3_000_000;
const hash = (token) => createHash("sha256").update(String(token)).digest("hex");

export async function POST(request) {
  const denied = await checkAccess(request);
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

  let id = isBookId(body.id || "") ? body.id : null;
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

export async function DELETE(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;
  if (!canPublish()) return errorResponse("발행 기능이 설정되지 않았어요.", 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("잘못된 요청입니다.");
  }
  if (!isBookId(body?.id || "")) return errorResponse("잘못된 요청입니다.");
  const existing = await loadBook(body.id);
  if (!existing) return json({ deleted: true }); // already gone
  if (existing.editHash !== hash(body.token)) return errorResponse("이 책을 지울 권한이 없어요.", 403);
  await deleteBook(body.id);
  return json({ deleted: true });
}

/** Only what the reader shows: no interview settings, model names or check lists. */
function readerCopy(b) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...pick(b, ["kind", "speakerRole", "speaksAs", "title", "subtitle", "subjectName", "birthYear", "birthplace", "epigraph", "people", "prologue", "lastWords", "timeline", "epilogue", "createdAt"]),
    chapters: b.chapters.map((c) => pick(c, ["title", "yearFrom", "yearTo", "place", "summary", "paragraphs", "pullQuote", "excerpt"])),
  };
}
