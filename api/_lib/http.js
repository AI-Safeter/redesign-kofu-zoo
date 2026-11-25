// Small helpers shared by the API functions.
import { timingSafeEqual } from "node:crypto";

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

export const fail = (message, status = 500) => Object.assign(new Error(message), { status });

/** Returns an error Response when the access code is required and missing/wrong, otherwise null. */
export function checkAccess(request) {
  const required = process.env.ACCESS_CODE;
  if (!required) return null;
  let given = request.headers.get("x-access-code") || "";
  try {
    given = decodeURIComponent(given);
  } catch {}
  const [a, b] = [Buffer.from(given), Buffer.from(required)];
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorResponse("접근 코드가 올바르지 않습니다.", 401);
  }
  return null;
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
  request.signal.addEventListener("abort", () => abort.abort());
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
  // Our own errors carry a Korean message; anything else is unexpected and stays in the logs.
  if (/[가-힣]/.test(err?.message || "")) return err.message;
  return "일시적인 서버 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.";
}
