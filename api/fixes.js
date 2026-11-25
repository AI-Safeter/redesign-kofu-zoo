// Proofreading step: suggests likely speech-recognition errors for the user to accept.
import { checkAccess } from "./_lib/access.js";
import { errorResponse, isMock, ndjsonStream } from "./_lib/http.js";
import { findFixes, readSettings } from "./_lib/writer.js";
import { mockFixes } from "./_lib/mock.js";

export async function POST(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;

  let input;
  try {
    const body = await request.json();
    input = readSettings(body);
    // A second model's independent transcription, if the browser has one.
    input.alt = String(body?.alt || "").slice(0, 400_000);
  } catch (err) {
    return errorResponse(err.message || "잘못된 요청입니다.", err.status || 400);
  }

  return ndjsonStream((send, signal) =>
    isMock() ? mockFixes(input.transcript) : findFixes({ ...input, onProgress: send, signal }),
  request);
}
