// A published book, for the read-only page /read?id=…
import { errorResponse, json } from "./_lib/http.js";
import { loadBook } from "./_lib/books.js";

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{12}$/.test(id)) return errorResponse("책을 찾을 수 없어요.", 404);
  const book = await loadBook(id).catch(() => null);
  if (!book) return errorResponse("책을 찾을 수 없어요.", 404);
  delete book.editHash;
  return json(book);
}
