// Published books: one JSON file per book in Vercel Blob (BLOB_READ_WRITE_TOKEN, set when a
// Blob store is connected to the project), or in this server's memory with MOCK_AI=1.
// A book's photos are JPEG files next to it, under books/<id>/.
import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import { isMock } from "./http.js";

const memory = new Map(); // MOCK_AI only: lost when the dev server restarts
const photoMemory = new Map(); // MOCK_AI only: path → bytes

export const canPublish = () => isMock() || Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const pathOf = (id) => `books/${id}.json`;
export const isBookId = (id) => /^[A-Za-z0-9_-]{12}$/.test(id);
export const isPhotoId = (id) => typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);
const photoPath = (id, photoId) => `books/${id}/${photoId}.jpg`;

export async function saveBook(id, data) {
  const text = JSON.stringify(data);
  if (isMock()) return void memory.set(id, text);
  // Public: the id in the link is unguessable, and the file holds only what readers see
  // (plus a hash of the edit token, which cannot be turned back into the token).
  await put(pathOf(id), text, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60, // a re-published book shows within about a minute
  });
}

export async function deleteBook(id) {
  await deletePhotos(id, [...(await listPhotos(id)).keys()]);
  if (isMock()) return void memory.delete(id);
  await del(pathOf(id));
}

export async function savePhoto(id, photoId, bytes) {
  if (isMock()) return void photoMemory.set(photoPath(id, photoId), Buffer.from(bytes));
  await put(photoPath(id, photoId), bytes, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "image/jpeg",
    cacheControlMaxAge: 60, // gone within about a minute of 발행 취소, like the book
  });
}

/** The book's stored photos: photo id → the address readers load it from. */
export async function listPhotos(id) {
  const prefix = `books/${id}/`;
  const found = new Map();
  const add = (pathname, url) => {
    const m = pathname.slice(prefix.length).match(/^([a-z0-9]{6,32})\.jpg$/);
    if (pathname.startsWith(prefix) && m) found.set(m[1], url);
  };
  if (isMock()) {
    for (const [path, bytes] of photoMemory) add(path, `data:image/jpeg;base64,${bytes.toString("base64")}`);
    return found;
  }
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const b of page.blobs) add(b.pathname, b.url);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return found;
}

export async function deletePhotos(id, photoIds) {
  const paths = photoIds.map((p) => photoPath(id, p));
  if (isMock()) return void paths.forEach((p) => photoMemory.delete(p));
  if (paths.length) await del(paths);
}

/** The stored book, or null when there is none with this id. */
export async function loadBook(id) {
  if (isMock()) return memory.has(id) ? JSON.parse(memory.get(id)) : null;
  // head() asks the store itself, not its CDN, so an unpublished book is gone at once. The copy
  // is then read by its version, so a re-published book can't come from the cache either.
  const meta = await head(pathOf(id)).catch((err) => {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  });
  if (!meta) return null;
  const res = await get(`${meta.url}?v=${encodeURIComponent(meta.etag)}`, { access: "public" });
  if (!res || res.statusCode !== 200) return null;
  return JSON.parse(await new Response(res.stream).text());
}
