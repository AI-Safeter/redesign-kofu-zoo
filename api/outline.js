// Step 1 of writing: plan the book (title, chapters, prologue, timeline, epilogue).
import { checkAccess, errorResponse, isMock, ndjsonStream } from "./_lib/http.js";
import { readSettings, writeOutline } from "./_lib/claude.js";
import { mockOutline } from "./_lib/mock.js";

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let input;
  try {
    input = readSettings(await request.json());
  } catch (err) {
    return errorResponse(err.message || "잘못된 요청입니다.", err.status || 400);
  }

  return ndjsonStream((send) =>
    isMock() ? mockOutline(input.settings, send) : writeOutline({ ...input, onProgress: send }),
  );
}
