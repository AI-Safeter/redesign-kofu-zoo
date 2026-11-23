// Transcribes one audio chunk (sent by the browser as the raw request body).
// The browser splits long recordings into chunks small enough for Vercel's 4.5 MB request limit.
//
// Providers (both speak the same OpenAI-style API):
//   groq   — free tier, Whisper large-v3 (default when GROQ_API_KEY is set)
//   openai — paid, whisper-1 / gpt-4o-transcribe (used when only OPENAI_API_KEY is set)
import { checkAccess, errorResponse, json, isMock } from "./_lib/http.js";
import { mockTranscribe } from "./_lib/mock.js";

const MAX_BYTES = 4_400_000;

const PROVIDERS = {
  groq: {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    keyEnv: "GROQ_API_KEY",
    model: () => process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3",
  },
  openai: {
    name: "OpenAI",
    url: "https://api.openai.com/v1/audio/transcriptions",
    keyEnv: "OPENAI_API_KEY",
    model: () => process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
  },
};

export function transcriptionProvider() {
  const wanted = (process.env.TRANSCRIBE_PROVIDER || "").toLowerCase();
  if (PROVIDERS[wanted] && process.env[PROVIDERS[wanted].keyEnv]) return PROVIDERS[wanted];
  if (process.env.GROQ_API_KEY) return PROVIDERS.groq;
  if (process.env.OPENAI_API_KEY) return PROVIDERS.openai;
  return null;
}

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const index = parseInt(url.searchParams.get("index") || "0", 10) || 0;
  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0) return errorResponse("오디오 데이터가 비어 있습니다.");
  if (audio.byteLength > MAX_BYTES) return errorResponse("오디오 조각이 너무 큽니다.", 413);
  if (isMock()) return json({ text: await mockTranscribe(index) });

  const provider = transcriptionProvider();
  if (!provider) {
    return errorResponse("음성 인식용 API 키(GROQ_API_KEY)가 서버에 설정되지 않았습니다. 녹취록을 직접 붙여넣어 주세요.", 500);
  }

  const type = request.headers.get("content-type") || "audio/wav";
  const name = url.searchParams.get("name") || "chunk.wav";
  const hint = (url.searchParams.get("hint") || "").slice(0, 600);

  const form = new FormData();
  form.append("file", new Blob([audio], { type }), name);
  form.append("model", provider.model());
  form.append("language", "ko");
  form.append("response_format", "json");
  // A short Korean prompt with names/places improves spelling of proper nouns.
  form.append("prompt", `한 사람의 인생 이야기를 듣는 인터뷰 녹음입니다.${hint ? ` 등장하는 이름과 지명: ${hint}` : ""}`);

  let res;
  try {
    res = await fetch(provider.url, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env[provider.keyEnv]}` },
      body: form,
    });
  } catch (err) {
    console.error(`${provider.name} unreachable`, err);
    return errorResponse(`음성 인식 서버(${provider.name})에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.`, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`${provider.name} transcription failed`, res.status, detail);
    if (res.status === 429) {
      // Free-tier rate limit: tell the browser how long to wait before retrying this chunk.
      const retryAfter = Math.min(120, Math.max(3, Math.ceil(Number(res.headers.get("retry-after")) || 20)));
      return json(
        {
          error: `음성 인식 사용량 한도에 걸렸습니다. ${retryAfter}초 뒤 자동으로 다시 시도합니다.`,
          retryAfter,
        },
        429,
      );
    }
    const message =
      res.status === 401
        ? `${provider.name} API 키가 올바르지 않습니다.`
        : `음성 인식에 실패했습니다 (${provider.name} ${res.status}).`;
    return errorResponse(message, 502);
  }
  const data = await res.json();
  return json({ text: String(data.text || "").trim() });
}
