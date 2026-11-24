// Writing through OpenRouter (https://openrouter.ai), used when OPENROUTER_API_KEY is set
// and no ANTHROPIC_API_KEY is. Defaults to free models that write Korean well; OpenRouter
// tries the next model in the list when one is busy or rate-limited.

// Order from real runs: Nemotron answered reliably; ERNIE writes good Korean but often spends
// its whole budget on hidden reasoning and returns nothing.
const DEFAULT_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "baidu/ernie-5.5-flash-preview:free",
  "google/gemma-4-31b-it:free",
];

// Models that just failed (looped, empty or broken output) are skipped for a while, so the
// other chapters of the same book don't each waste a minute on them. Per server instance.
const recentFailures = new Map();
const SKIP_MS = 10 * 60 * 1000;
function healthy(list) {
  const now = Date.now();
  const ok = list.filter((m) => !(now - (recentFailures.get(m) || 0) < SKIP_MS));
  return ok.length ? ok : list;
}

function models() {
  const list = (process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

const fail = (message, status = 500) => Object.assign(new Error(message), { status });

/** Pulls the JSON object out of a reply that may be wrapped in ``` fences or extra prose. */
export function extractJson(text) {
  const cleaned = text.replace(/^﻿/, "").replace(/```(?:json)?/gi, "").trim();
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
 * Free models occasionally loop until they hit the length limit, or return text that is not
 * JSON. When that happens, the request is tried again without the model that failed.
 */
export async function callOpenRouter(args) {
  let list = healthy(models());
  for (;;) {
    // Don't start another model when the function is about to run out of time.
    if (args.deadline && args.deadline - Date.now() < 20_000) throw Object.assign(new Error("시간이 부족합니다. 다시 시도해 주세요."), { status: 504 });
    try {
      return await attempt({ ...args, models: list });
    } catch (err) {
      const rest = list.filter((m) => m !== err.servedBy);
      if (err.retryOther && err.servedBy) recentFailures.set(err.servedBy, Date.now());
      if (!err.retryOther || !err.servedBy || rest.length === 0 || rest.length === list.length || args.signal?.aborted) throw err;
      console.warn(`OpenRouter: retrying without ${err.servedBy}`);
      list = rest;
    }
  }
}

async function attempt({ system, userText, schema, schemaName, onProgress, signal, models: modelList }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "x-title": "Life Chronicle E-book",
    },
    body: JSON.stringify({
      models: modelList,
      stream: true,
      max_tokens: 16000,
      temperature: 0.4,
      // Keep hidden reasoning short: it counts against max_tokens and some free models loop in it.
      reasoning: { effort: "low", exclude: true },
      // Models that support it are held to the schema; the others get it in the prompt.
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `${userText}\n\nReply with only one JSON object (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("OpenRouter error", res.status, detail.slice(0, 500));
    if (res.status === 401) throw fail("OpenRouter API 키가 올바르지 않습니다.", 401);
    if (res.status === 402) throw fail("OpenRouter 크레딧이 부족합니다.", 402);
    if (res.status === 429) throw fail("무료 AI 모델 사용량 한도에 걸렸습니다. 1~2분 뒤 다시 시도해 주세요.", 429);
    throw fail(`AI 서버 오류 (OpenRouter ${res.status}). 잠시 후 다시 시도해 주세요.`, 502);
  }

  // Read the server-sent event stream and collect the text.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let lastSent = 0;
  let finish = null;
  let servedBy = "";
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue; // skips ": OPENROUTER PROCESSING" keep-alives
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) {
        console.error("OpenRouter stream error", event.error);
        throw fail("AI 모델이 응답 도중 멈췄습니다. 다시 시도해 주세요.", 502);
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

  if (finish === "length") {
    console.error(`OpenRouter ${servedBy} hit the length limit after ${text.length} chars; tail:`, JSON.stringify(text.slice(-300)));
    throw Object.assign(fail("결과가 너무 길어 중간에 끊겼습니다. 다시 시도해 주세요."), { servedBy, retryOther: true });
  }
  const data = extractJson(text);
  if (!data) {
    console.error(`OpenRouter ${servedBy} reply was not JSON:`, text.slice(0, 500));
    throw Object.assign(fail("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요."), { servedBy, retryOther: true });
  }
  return { data, model: servedBy };
}
