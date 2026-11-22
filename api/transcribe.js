// Transcribes one audio chunk (sent by the browser as the raw request body)
// with OpenAI's speech-to-text API. The browser splits long recordings into
// chunks small enough for Vercel's 4.5 MB request limit.
import { checkAccess, errorResponse, json, isMock } from "./_lib/http.js";
import { mockTranscribe } from "./_lib/mock.js";

const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const MAX_BYTES = 4_400_000;

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const index = parseInt(url.searchParams.get("index") || "0", 10) || 0;
  if (isMock()) return json({ text: await mockTranscribe(index) });

  if (!process.env.OPENAI_API_KEY) {
    return errorResponse("OPENAI_API_KEY가 서버에 설정되지 않았습니다. 녹취록을 직접 붙여넣어 주세요.", 500);
  }

  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0) return errorResponse("오디오 데이터가 비어 있습니다.");
  if (audio.byteLength > MAX_BYTES) return errorResponse("오디오 조각이 너무 큽니다.", 413);

  const type = request.headers.get("content-type") || "audio/wav";
  const name = url.searchParams.get("name") || "chunk.wav";
  const hint = (url.searchParams.get("hint") || "").slice(0, 600);

  const form = new FormData();
  form.append("file", new Blob([audio], { type }), name);
  form.append("model", MODEL);
  form.append("language", "ko");
  form.append("response_format", "json");
  // A short Korean prompt with names/places improves spelling of proper nouns.
  form.append("prompt", `한 사람의 인생 이야기를 듣는 인터뷰 녹음입니다.${hint ? ` 등장하는 이름과 지명: ${hint}` : ""}`);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("transcription failed", res.status, detail);
    const message =
      res.status === 401
        ? "OpenAI API 키가 올바르지 않습니다."
        : res.status === 429
          ? "음성 인식 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
          : `음성 인식에 실패했습니다 (${res.status}).`;
    return errorResponse(message, res.status === 429 ? 429 : 502);
  }
  const data = await res.json();
  return json({ text: String(data.text || "").trim() });
}
