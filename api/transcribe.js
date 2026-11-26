// Transcribes one audio chunk (sent by the browser as the raw request body).
// The browser splits long recordings into chunks small enough for Vercel's 4.5 MB request limit.
//
// Engines, in order:
//   OpenRouter audio models (Qwen 3.8 Omni Flash, then Gemini 2.5 Flash) when OPENROUTER_API_KEY
//     is set — far more accurate on Korean interviews, about 2 cents per hour of audio;
//   Groq Whisper large-v3 (free tier) as the fallback.
// TRANSCRIBE_PROVIDER=groq|openrouter forces one.
import { checkAccess } from "./_lib/access.js";
import { errorResponse, errorSummary, json, isMock } from "./_lib/http.js";
import { mockTranscribe } from "./_lib/mock.js";
import { audioFormat, audioModelsEnabled, checkModel, transcribeWithAudioModels } from "./_lib/audio-llm.js";

const MAX_BYTES = 4_400_000;
const TRY_AGAIN = "음성 인식에 잠시 문제가 생겼어요. 잠시 후 다시 눌러 주세요.";

/** Whether this deployment can transcribe at all. */
export function canTranscribe() {
  return audioModelsEnabled() || groqEnabled();
}

const groqEnabled = () => Boolean(process.env.GROQ_API_KEY) && (process.env.TRANSCRIBE_PROVIDER || "").toLowerCase() !== "openrouter";

export async function POST(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const index = parseInt(url.searchParams.get("index"), 10) || 0;
  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0) return errorResponse("오디오 데이터가 비어 있습니다.");
  if (audio.byteLength > MAX_BYTES) return errorResponse("오디오 조각이 너무 큽니다.", 413);
  if (isMock()) return json({ text: await mockTranscribe(index) });

  const type = request.headers.get("content-type") || "audio/wav";
  const name = url.searchParams.get("name") || "chunk.wav";
  // Names and terms the user typed. For Whisper they are sent as a bare list: a descriptive
  // prompt sentence made it skip the start of real recordings.
  const hint = (url.searchParams.get("hint") || "").slice(0, 300).trim();
  // The end of the previous piece's text, as context for the audio models.
  const prev = (url.searchParams.get("prev") || "").slice(-300).trim();

  const groq = groqEnabled();
  const tidy = (t) => paragraphs(collapseRepeats(t.replace(/\s*\n\s*/g, " ")));
  if (audioModelsEnabled() && audioFormat(type, name)) {
    try {
      // The second model runs at the same time; its text only feeds the proofreading step.
      const second = checkModel();
      const altPromise = second
        ? transcribeWithAudioModels({ audio, type, name, hint, prev, signal: request.signal, only: second }).catch(() => null)
        : Promise.resolve(null);
      const main = await transcribeWithAudioModels({ audio, type, name, hint, prev, signal: request.signal });
      // The second opinion only helps proofreading: wait at most 20 s more for it.
      const alt = await Promise.race([altPromise, new Promise((r) => setTimeout(() => r(null), 20_000))]);
      return json({ text: tidy(main.text), alt: alt && alt.model !== main.model ? tidy(alt.text) : undefined });
    } catch (err) {
      console.warn("Audio models failed, falling back to Whisper:", err.message);
      if (!groq && err.thin) return json({ text: tidy(err.thin.text) }); // a quiet piece: little to hear
      if (!groq) return errorResponse("음성 인식에 실패했습니다. 잠시 후 다시 시도해 주세요.", 502);
    }
  }
  if (!groq) return errorResponse("음성 인식용 API 키가 서버에 설정되지 않았습니다.", 500);

  const first = await recognize({ audio, type, name, model: process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3", prompt: hint, signal: request.signal });
  if (first.error) return first.error;
  let best = first;

  // Whisper sometimes skips speech (one long segment with very little text) or loops.
  // Try again once without the hint, on the other Whisper model.
  if (suspicious(first.segments)) {
    const second = await recognize({ audio, type, name, model: "whisper-large-v3-turbo", prompt: "", signal: request.signal });
    if (!second.error && score(second) > score(first)) best = second;
  }
  return json({ text: buildText(best) });
}

/** Starts a new paragraph at a sentence end every ~400 characters. */
function paragraphs(text) {
  const sentences = text.match(/[^.?!。]+[.?!。]+["”']?\s*|[^.?!。]+$/g) || [text];
  let out = "";
  let run = 0;
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (out) out += run > 400 ? "\n" : " ";
    if (run > 400) run = 0;
    out += t;
    run += t.length;
  }
  return out;
}

async function recognize({ audio, type, name, model, prompt, signal }) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), name);
  form.append("model", model);
  form.append("language", "ko");
  form.append("response_format", "verbose_json");
  if (prompt) form.append("prompt", prompt);

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
  } catch (err) {
    console.error("Groq unreachable", err);
    return { error: errorResponse("음성 인식 서버에 연결하지 못했어요. 잠시 후 다시 눌러 주세요.", 502) };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Groq transcription failed", res.status, errorSummary(detail));
    if (res.status === 429) {
      // Free-tier rate limit: tell the browser how long to wait before retrying this chunk.
      const retryAfter = Math.min(120, Math.max(3, Math.ceil(Number(res.headers.get("retry-after")) || 20)));
      return {
        error: json({ error: `음성 인식 사용량 한도에 걸렸습니다. ${retryAfter}초 뒤 자동으로 다시 시도합니다.`, retryAfter }, 429),
      };
    }
    const message =
      res.status === 401 ? "음성 인식 서비스 설정에 문제가 있어요. 사이트 관리자에게 알려 주세요." : TRY_AGAIN;
    return { error: errorResponse(message, 502) };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { error: errorResponse(TRY_AGAIN, 502) };
  }
  return { text: String(data.text || "").trim(), segments: Array.isArray(data.segments) ? data.segments : null };
}

/** Signs that Whisper skipped or looped: long stretches with almost no text, or repetition. */
function suspicious(segments) {
  return segments?.some((seg) => {
    const secs = seg.end - seg.start;
    const chars = String(seg.text || "").replace(/\s/g, "").length;
    return (secs >= 8 && chars / secs < 2) || seg.compression_ratio > 2.4;
  });
}

/** Higher is better: characters per second of audio, minus a penalty for each bad segment. */
function score(result) {
  if (!result.segments?.length) return result.text.length;
  const span = result.segments[result.segments.length - 1].end - result.segments[0].start || 1;
  const bad = result.segments.filter((s) => suspicious([s])).length;
  return result.text.replace(/\s/g, "").length / span - bad * 2;
}

// Phrases Whisper invents over music or silence at the end of a recording.
const OUTRO = /^(감사합니다|시청해 ?주셔서 감사합니다|구독과 좋아요.*|MBC 뉴스.*)[.!]?$/;

/**
 * Joins segments into text, starting a new line where the speaker paused for over a second
 * after finishing a sentence, and dropping invented sign-offs over silence.
 */
function buildText(result) {
  const segs = result.segments;
  if (!segs?.length) return collapseRepeats(result.text);
  const kept = segs.filter((seg, i) => {
    const t = String(seg.text || "").trim();
    if (!t) return false;
    const last = i >= segs.length - 2;
    return !(last && OUTRO.test(t) && (seg.no_speech_prob > 0.3 || seg.avg_logprob < -0.6));
  });
  let out = "";
  let paragraph = 0;
  let last = "";
  kept.forEach((seg, i) => {
    const t = collapseRepeats(String(seg.text).trim());
    if (!t || t === last) return; // a segment repeated word for word is a loop
    last = t;
    if (out) {
      const prev = kept[i - 1];
      const ended = /[.?!。요다죠까]$/.test(out.trim());
      // New paragraph at a pause after a sentence, or after ~400 characters at a sentence end.
      const brk = ended && (seg.start - prev.end > 0.6 || paragraph > 400);
      out += brk ? "\n" : " ";
      if (brk) paragraph = 0;
    }
    out += t;
    paragraph += t.length;
  });
  return out.trim();
}

/**
 * Collapses a loop: a phrase of 1–4 words said three or more times in a row ("네 네 네 네" →
 * "네"). Two repeats are kept, since Korean doubles on purpose ("한 명 한 명", "한 걸음 한 걸음").
 */
function collapseRepeats(text) {
  return text.replace(/(^|\s)(\S+(?:\s+\S+){0,3}?)(?:\s+\2){2,}(?=\s|$)/g, "$1$2");
}
