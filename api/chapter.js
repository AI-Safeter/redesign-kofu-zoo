// Step 2 of writing: write one chapter. The browser calls this once per chapter.
import { checkAccess, errorResponse, isMock, ndjsonStream } from "./_lib/http.js";
import { readSettings, writeChapter } from "./_lib/writer.js";
import { mockChapter } from "./_lib/mock.js";

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let body, input;
  try {
    body = await request.json();
    input = readSettings(body);
  } catch (err) {
    return errorResponse(err.message || "잘못된 요청입니다.", err.status || 400);
  }
  const { outline } = body;
  const index = parseInt(body.index, 10);
  if (!Array.isArray(outline?.chapters) || !(index >= 0 && index < outline.chapters.length)) {
    return errorResponse("잘못된 장 정보입니다.");
  }

  return ndjsonStream((send, signal) =>
    isMock() ? mockChapter(index, send) : writeChapter({ ...input, outline, index, onProgress: send, signal }),
  request);
}
