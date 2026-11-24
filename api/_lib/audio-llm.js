// Transcription with audio-capable language models through OpenRouter.
//
// On a real Korean interview these were far more accurate than Whisper and barely affected
// by where the browser cuts the audio (hard-spot checklist, 17 items, same 100 s pieces):
//   qwen/qwen3.8-omni-flash 14/17 (~$0.02 per hour of audio), google/gemini-2.5-flash 13/17
//   (~$0.15/hour), Groq whisper-large-v3 5/17. They also kept fillers Whisper silently drops,
//   and invented no passages. Whisper (Groq) remains the free fallback.

const DEFAULT_MODELS = ["qwen/qwen3.8-omni-flash", "google/gemini-2.5-flash"];

export function audioModelsEnabled() {
  const wanted = (process.env.TRANSCRIBE_PROVIDER || "").toLowerCase();
  if (wanted && wanted !== "openrouter") return false;
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function models() {
  const list = (process.env.OPENROUTER_AUDIO_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

/** "wav" or "mp3" when the audio models accept this file, else null. */
export function audioFormat(type, name) {
  if (/wav/i.test(type) || /\.wav$/i.test(name)) return "wav";
  if (/mpeg|mp3/i.test(type) || /\.mp3$/i.test(name)) return "mp3";
  return null;
}

/** Seconds of audio in a PCM/μ-law WAV file, from its header; null if unknown. */
function wavSeconds(buf) {
  const v = new DataView(buf);
  if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  const byteRate = v.getUint32(28, true);
  return byteRate ? (buf.byteLength - 44) / byteRate : null;
}

function instructions(hint) {
  return [
    "이 오디오는 한국어 인터뷰 녹음의 한 부분입니다. 들리는 말을 처음부터 끝까지 빠짐없이, 요약하거나 고치거나 다듬지 말고 들리는 그대로 받아 적으세요.",
    "말한 순서대로 적고, 문장이 끝나면 마침표나 물음표를 찍으세요.",
    "음악이나 침묵만 있는 부분은 적지 말고, (음악)이나 [웃음] 같은 설명도 넣지 마세요.",
    hint ? `녹음에 나오는 이름과 용어는 이 철자로 적으세요: ${hint}` : "",
    "머리말이나 설명 없이 받아 적은 글만 출력하세요.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Removes things the model may add around the transcript. */
function clean(text) {
  return String(text || "")
    .replace(/```[a-z]*\n?|```/g, "")
    .replace(/^\s*(다음은|아래는|받아\s?쓴|Here is|Transcript)[^\n]*[:：]\s*\n/i, "")
    .replace(/[(\[（［](음악|웃음|박수|침묵|기침|잡음|music|laughter|silence)[^)\]）］]*[)\]）］]/gi, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const REFUSAL = /^(죄송|I'?m sorry|I can(no|')t|Sorry)/i;

/**
 * Transcribes one chunk, trying each audio model in turn. Throws when none gives usable text
 * (the caller then falls back to Whisper).
 */
export async function transcribeWithAudioModels({ audio, type, name, hint, signal }) {
  const format = audioFormat(type, name);
  if (!format) throw new Error("unsupported format for audio models");
  const seconds = format === "wav" ? wavSeconds(audio) : null;
  const data = Buffer.from(audio).toString("base64");
  let lastError;

  for (const model of models()) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
          "x-title": "Life Chronicle E-book",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 8000,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: instructions(hint) },
                { type: "input_audio", input_audio: { data, format } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        lastError = new Error(`${model}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        continue;
      }
      const body = await res.json();
      const choice = body.choices?.[0];
      const text = clean(choice?.message?.content);
      const chars = text.replace(/\s/g, "").length;
      // Reject refusals, empty answers for real audio, and answers cut off by the length limit.
      if (REFUSAL.test(text)) throw new Error(`${model}: refused`);
      if (seconds && seconds > 20 && chars < seconds * 0.5) throw new Error(`${model}: too little text (${chars} chars for ${Math.round(seconds)} s)`);
      if (choice?.finish_reason === "length") throw new Error(`${model}: cut off`);
      return { text, model };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError || new Error("no audio model available");
}
