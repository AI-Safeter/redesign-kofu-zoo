// Small helpers shared by the API functions.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

/** Returns an error Response when the access code is required and missing/wrong, otherwise null. */
export function checkAccess(request) {
  const required = process.env.ACCESS_CODE;
  if (!required) return null;
  let given = request.headers.get("x-access-code") || "";
  try {
    given = decodeURIComponent(given);
  } catch {}
  if (!timingSafeEqual(given, required)) {
    return errorResponse("접근 코드가 올바르지 않습니다.", 401);
  }
  return null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const isMock = () => process.env.MOCK_AI === "1";

/**
 * Streams newline-delimited JSON events to the browser while `work(send, signal)` runs.
 * Sends a heartbeat every 10s so proxies don't drop an idle connection,
 * then a final {type:"done", result} or {type:"error", message} line.
 * If the browser goes away, `signal` aborts so the AI call stops (and stops costing money),
 * and nothing more is written to the closed stream.
 */
export function ndjsonStream(work, request) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request?.signal?.addEventListener?.("abort", () => abort.abort());
  let closed = false;
  let heartbeat;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true;
        }
      };
      heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
      try {
        const result = await work(send, abort.signal);
        send({ type: "done", result });
      } catch (err) {
        if (!abort.signal.aborted) console.error(err);
        send({ type: "error", message: friendlyError(err) });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

function friendlyError(err) {
  const status = err?.status;
  // Our own errors carry a Korean message; anything else is unexpected and stays in the logs.
  if (/[가-힣]/.test(err?.message || "")) return err.message;
  if (status === 401) return "API 키가 올바르지 않습니다. 서버 환경변수를 확인해 주세요.";
  if (status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 529 || status === 503) return "AI 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.";
  return "일시적인 서버 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.";
}
