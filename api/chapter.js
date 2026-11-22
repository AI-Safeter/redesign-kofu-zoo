// Step 2 of writing: write one chapter. The browser calls this once per chapter.
import { checkAccess, errorResponse, isMock, ndjsonStream } from "./_lib/http.js";
import { readSettings, writeChapter } from "./_lib/claude.js";
import { mockChapter } from "./_lib/mock.js";

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let input, outline, index;
  try {
    const body = await request.json();
    input = readSettings(body);
    outline = body.outline;
    index = parseInt(body.index, 10);
    if (!outline || !Array.isArray(outline.chapters) || !(index >= 0 && index < outline.chapters.length)) {
      throw Object.assign(new Error("잘못된 장 정보입니다."), { status: 400 });
    }
  } catch (err) {
    return errorResponse(err.message || "잘못된 요청입니다.", err.status || 400);
  }

  return ndjsonStream((send) =>
    isMock() ? mockChapter(index, send) : writeChapter({ ...input, outline, index, onProgress: send }),
  );
}
