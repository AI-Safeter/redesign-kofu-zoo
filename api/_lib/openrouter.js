// Writing through OpenRouter (https://openrouter.ai), used when OPENROUTER_API_KEY is set
// and no ANTHROPIC_API_KEY is. Defaults to free models that write Korean well; OpenRouter
// tries the next model in the list when one is busy or rate-limited.

const DEFAULT_MODELS = [
  "baidu/ernie-5.5-flash-preview:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
];

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

export async function callOpenRouter({ system, userText, schema, schemaName, onProgress }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "x-title": "Life Chronicle E-book",
    },
    body: JSON.stringify({
      models: models(),
      stream: true,
      max_tokens: 16000,
      temperature: 0.7,
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
    }
  }

  if (finish === "length") throw fail("결과가 너무 길어 중간에 끊겼습니다. 다시 시도해 주세요.");
  const data = extractJson(text);
  if (!data) {
    console.error("OpenRouter reply was not JSON:", text.slice(0, 500));
    throw fail("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.");
  }
  return { data };
}
