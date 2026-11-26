// Writing through OpenAI-compatible model gateways, tried in order:
//   1. Nous Portal (https://portal.nousresearch.com) when NOUS_API_KEY is set: Claude Sonnet 5.5
//      by default, which wrote by far the most natural Korean in a side-by-side test of four
//      models on the same interview.
//   2. OpenRouter (https://openrouter.ai) when OPENROUTER_API_KEY is set: free models, used on
//      their own or when the first gateway fails (no credit, outage).
// Both speak the same API, so one client serves both.
import { errorSummary, fail } from "./http.js";

// Order from real runs: Nemotron answered reliably; ERNIE writes good Korean but often spends
// its whole budget on hidden reasoning and returns nothing.
const OPENROUTER_DEFAULT_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "baidu/ernie-5.5-flash-preview:free",
  "google/gemma-4-31b-it:free",
];
const NOUS_DEFAULT_MODELS = ["anthropic/claude-sonnet-5.5"];

export const list = (value, fallback) => {
  const items = String(value || "").split(",").map((m) => m.trim()).filter(Boolean);
  return items.length ? items : fallback;
};

/** The configured gateways, in the order they are tried. */
export function gateways() {
  const out = [];
  if (process.env.NOUS_API_KEY) {
    out.push({
      name: "Nous",
      url: "https://inference-api.nousresearch.com/v1/chat/completions",
      key: process.env.NOUS_API_KEY,
      models: list(process.env.NOUS_MODELS, NOUS_DEFAULT_MODELS),
      fallbackList: false, // one model per request; the next model is tried by us
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    out.push({
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: process.env.OPENROUTER_API_KEY,
      models: list(process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL, OPENROUTER_DEFAULT_MODELS),
      fallbackList: true, // OpenRouter moves to the next model itself when one is busy
    });
  }
  return out;
}

// Models that just failed (looped, empty or broken output) are skipped for a while, so the
// other chapters of the same book don't each waste a minute on them. Per server instance.
const recentFailures = new Map();
const SKIP_MS = 10 * 60 * 1000;
function healthy(models) {
  const now = Date.now();
  const ok = models.filter((m) => now - (recentFailures.get(m) || 0) >= SKIP_MS);
  return ok.length ? ok : models;
}

const isClaude = (model) => /^anthropic\//.test(model);

/** Pulls the JSON object out of a reply that may be wrapped in ``` fences or extra prose. */
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/**
 * Asks each gateway in turn. Within a gateway, a model that loops, returns broken JSON or
 * isn't available is dropped and the next one tried. `cached` is the large text repeated in
 * every call of a book (the transcript): Claude models keep it in the prompt cache, so after
 * the first call of a book it is billed at a fraction of the price.
 */
export async function callGateways(args) {
  let lastError;
  for (const gw of gateways()) {
    try {
      return await callGateway(gw, args);
    } catch (err) {
      if (args.signal.aborted || err.status === 504) throw err;
      lastError = err;
      console.warn(`${gw.name} failed (${err.message}); trying the next gateway`);
    }
  }
  throw lastError;
}

async function callGateway(gw, args) {
  let models = healthy(gw.models);
  for (;;) {
    // Don't start another model when the function is about to run out of time.
    if (args.deadline - Date.now() < 20_000) throw fail("시간이 부족합니다. 다시 시도해 주세요.", 504);
    try {
      return await attempt(gw, gw.fallbackList ? models : [models[0]], args);
    } catch (err) {
      if (args.signal.aborted) throw err;
      const failed = err.servedBy || (!gw.fallbackList && models[0]);
      if (err.retryOther && failed) recentFailures.set(failed, Date.now());
      const rest = models.filter((m) => m !== failed);
      // Without a list on the server side, an unusable model (error status) moves us on too.
      const moveOn = err.retryOther || (!gw.fallbackList && err.status !== 401 && err.status !== 402);
      if (!moveOn || rest.length === 0 || rest.length === models.length) throw err;
      console.warn(`${gw.name}: retrying without ${failed}`);
      models = rest;
    }
  }
}

async function attempt(gw, models, { system, cached, userText, schema, schemaName, onProgress, signal }) {
  const claude = models.every(isClaude);
  // The repeated text goes last in the system message and is marked for caching, so every
  // call of the same book shares the same cached beginning.
  const systemContent = claude && cached
    ? [{ type: "text", text: system }, { type: "text", text: cached, cache_control: { type: "ephemeral" } }]
    : [system, cached].filter(Boolean).join("\n\n");

  const res = await fetch(gw.url, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${gw.key}`,
      "content-type": "application/json",
      "x-title": "InterviewToEbook",
    },
    body: JSON.stringify({
      ...(models.length > 1 ? { models } : { model: models[0] }),
      stream: true,
      max_tokens: 16000,
      // Claude takes no sampling settings; for the free models a low temperature keeps them on task.
      ...(claude ? {} : { temperature: 0.4 }),
      // Keep hidden reasoning short: it is billed as output, and some free models loop in it.
      reasoning: { effort: process.env.WRITER_EFFORT || "low", exclude: true },
      usage: { include: true },
      // The free models are held to the schema by the server. Claude gets it only in the prompt:
      // Anthropic puts a response schema ahead of everything else, so the outline and the
      // chapters (different schemas) could never share the cached transcript.
      ...(claude ? {} : { response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } } }),
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${userText}\n\nReply with only one JSON object (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`${gw.name} error`, res.status, errorSummary(detail));
    if (res.status === 401) throw fail(`${gw.name} API 키가 올바르지 않습니다.`, 401);
    if (res.status === 402) throw fail(`${gw.name} 크레딧이 부족합니다.`, 402);
    if (res.status === 429) throw fail("AI 모델 사용량 한도에 걸렸습니다. 1~2분 뒤 다시 시도해 주세요.", 429);
    throw fail(`AI 서버 오류 (${gw.name} ${res.status}). 잠시 후 다시 시도해 주세요.`, 502);
  }

  // Read the server-sent event stream and collect the text.
  let buffer = "";
  let text = "";
  let lastSent = 0;
  let finish = null;
  let servedBy = models.length === 1 ? models[0] : "";
  let usage = null;
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + chunk).split("\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue; // skips ": PROCESSING" keep-alives
      let event;
      try {
        event = JSON.parse(line.slice(5)); // also skips "[DONE]"
      } catch {
        continue;
      }
      if (event.error) {
        console.error(`${gw.name} stream error`, errorSummary(event.error));
        throw Object.assign(fail("AI 모델이 응답 도중 멈췄습니다. 다시 시도해 주세요.", 502), { servedBy, retryOther: true });
      }
      if (event.model) servedBy = event.model;
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        if (text.length - lastSent > 200) {
          lastSent = text.length;
          onProgress?.({ type: "progress", chars: text.length });
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (event.usage) usage = event.usage;
    }
  }
  logUsage(gw.name, servedBy, usage);

  if (finish === "length") {
    console.error(`${gw.name} ${servedBy} hit the length limit after ${text.length} chars`);
    throw Object.assign(fail("결과가 너무 길어 중간에 끊겼습니다. 다시 시도해 주세요."), { servedBy, retryOther: true });
  }
  const data = extractJson(text);
  if (!data) {
    console.error(`${gw.name} ${servedBy} reply was not JSON (${text.length} chars)`); // no content: it is the book's text
    throw Object.assign(fail("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요."), { servedBy, retryOther: true });
  }
  return { data, model: servedBy };
}

/** One line per call in the server log: tokens, how many came from the cache, and the cost. */
function logUsage(gateway, model, usage) {
  if (!usage) return;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const written = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const cost = typeof usage.cost === "number" ? ` $${usage.cost.toFixed(4)}` : "";
  console.log(`[usage] ${gateway} ${model} in=${usage.prompt_tokens} (cached ${cachedTokens}, cache write ${written}) out=${usage.completion_tokens}${cost}`);
}
