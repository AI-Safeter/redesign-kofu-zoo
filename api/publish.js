// Publishes a book as a read-only page (/read?id=…). Publishing again with the id and the
// edit token returned the first time replaces the same page; DELETE with them removes it.
// Photos: POST answers with the ids of the book's photos the server doesn't have yet; the
// browser PUTs each one, then publishes again, and the page then shows them.
import { createHash, randomBytes } from "node:crypto";
import { checkAccess } from "./_lib/access.js";
import { errorResponse, json } from "./_lib/http.js";
import { canPublish, deleteBook, deletePhotos, isBookId, isPhotoId, listPhotos, loadBook, saveBook, savePhoto } from "./_lib/books.js";

const MAX_BYTES = 3_000_000;
const MAX_PHOTO_BYTES = 3_000_000; // one photo per request, well under Vercel's 4.5 MB
const MAX_PHOTOS = 200;
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

  const stored = await listPhotos(id);
  const copy = readerCopy(book, stored);
  await saveBook(id, { ...copy, editHash: hash(token || body.token), publishedAt: new Date().toISOString() });
  // Photos taken out of the book since it was last published leave the server too.
  const kept = new Set(copy.chapters.flatMap((c) => (c.photos || []).map((p) => p.id)));
  await deletePhotos(id, [...stored.keys()].filter((p) => !kept.has(p)));
  // token only the first time; the browser keeps it with the book
  return json({ id, token, missing: copy.pendingPhotos || [] });
}

/** One photo of a published book: PUT /api/publish?id=…&photo=… with the JPEG as the body. */
export async function PUT(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;
  if (!canPublish()) return errorResponse("발행 기능이 설정되지 않았어요.", 503);
  const query = new URL(request.url).searchParams;
  const id = query.get("id") || "";
  const photo = query.get("photo") || "";
  if (!isBookId(id) || !isPhotoId(photo) || request.headers.get("content-type") !== "image/jpeg") return errorResponse("잘못된 요청입니다.");
  if (Number(request.headers.get("content-length")) > MAX_PHOTO_BYTES) return errorResponse("사진이 너무 커요.", 413);
  const existing = await loadBook(id);
  if (!existing) return errorResponse("책을 찾을 수 없어요.", 404);
  if (existing.editHash !== hash(request.headers.get("x-edit-token"))) return errorResponse("이 책을 다시 발행할 권한이 없어요.", 403);
  if (!(existing.pendingPhotos || []).includes(photo)) return errorResponse("잘못된 요청입니다.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) return errorResponse("사진이 너무 커요.", 413);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return errorResponse("잘못된 요청입니다."); // not a JPEG
  await savePhoto(id, photo, bytes);
  return json({ saved: true });
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

/**
 * Only what the reader shows: no interview settings, model names or check lists. A photo is kept
 * only when this book's own copy of it is stored, with its address set here (whatever src the
 * browser sent is dropped); the ids of the others go in pendingPhotos, which readers never get.
 */
function readerCopy(b, stored) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  const seen = new Set();
  const pending = [];
  const photosOf = (c) =>
    (Array.isArray(c.photos) ? c.photos : []).flatMap((p) => {
      if (!isPhotoId(p?.id) || seen.has(p.id) || seen.size >= MAX_PHOTOS || !Number.isInteger(p.after) || p.after < -1) return [];
      seen.add(p.id);
      if (!stored.has(p.id)) {
        pending.push(p.id);
        return [];
      }
      return [{ id: p.id, after: p.after, caption: typeof p.caption === "string" ? p.caption.slice(0, 1000) : "", src: stored.get(p.id) }];
    });
  const copy = {
    ...pick(b, ["kind", "speakerRole", "speaksAs", "title", "subtitle", "subjectName", "birthYear", "birthplace", "epigraph", "people", "prologue", "lastWords", "timeline", "epilogue", "createdAt"]),
    chapters: b.chapters.map((c) => {
      const out = pick(c, ["title", "yearFrom", "yearTo", "place", "summary", "paragraphs", "pullQuote", "excerpt"]);
      const photos = photosOf(c || {});
      if (photos.length) out.photos = photos;
      return out;
    }),
  };
  // 구술 정리 books hide pull quotes, so the reader needs to know the voice (and nothing else of the settings).
  if (["first", "third", "oral"].includes(b.settings?.voice)) copy.settings = { voice: b.settings.voice };
  if (pending.length) copy.pendingPhotos = pending;
  return copy;
}
