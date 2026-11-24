// Proofreading step: suggests likely speech-recognition errors for the user to accept.
import { checkAccess, errorResponse, isMock, ndjsonStream } from "./_lib/http.js";
import { findFixes, readSettings } from "./_lib/writer.js";

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let input;
  try {
    input = readSettings(await request.json());
  } catch (err) {
    return errorResponse(err.message || "잘못된 요청입니다.", err.status || 400);
  }

  return ndjsonStream(
    (send, signal) =>
      isMock()
        ? Promise.resolve({
            fixes: input.transcript.includes("갯벌")
              ? [{ heard: "갯벌", meant: "갯벌", kind: "mishearing", checked: false, why: "(시험 모드 예시 — 실제로는 잘못 들린 말만 보여 줍니다)" }]
              : [],
            model: "mock",
          })
        : findFixes({ ...input, onProgress: send, signal }),
    request,
  );
}
