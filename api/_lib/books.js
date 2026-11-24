// Published books: one JSON file per book in Vercel Blob (BLOB_READ_WRITE_TOKEN, set when a
// Blob store is connected to the project), or in this server's memory with MOCK_AI=1.
import { del, get, put } from "@vercel/blob";
import { isMock } from "./http.js";

const memory = new Map(); // MOCK_AI only: lost when the dev server restarts

export const canPublish = () => isMock() || Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const pathOf = (id) => `books/${id}.json`;

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
  if (isMock()) return void memory.delete(id);
  await del(pathOf(id));
}

/** The stored book, or null when there is none with this id. */
export async function loadBook(id) {
  if (isMock()) return memory.has(id) ? JSON.parse(memory.get(id)) : null;
  const res = await get(pathOf(id), { access: "public" });
  if (!res || res.statusCode !== 200) return null;
  return JSON.parse(await new Response(res.stream).text());
}
