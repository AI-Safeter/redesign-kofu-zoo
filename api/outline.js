// Step 1 of writing: plan the book (title, chapters, prologue, timeline, epilogue).
import { checkAccess } from "./_lib/access.js";
import { errorResponse, isMock, ndjsonStream } from "./_lib/http.js";
import { readSettings, writeOutline } from "./_lib/writer.js";
import { mockOutline } from "./_lib/mock.js";

export async function POST(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;

  let input;
  try {
    input = readSettings(await request.json());
  } catch (err) {
    return errorResponse(err.message || "잘못된 요청입니다.", err.status || 400);
  }

  return ndjsonStream((send, signal) =>
    isMock() ? mockOutline(input.settings, send) : writeOutline({ ...input, onProgress: send, signal }),
  request);
}
