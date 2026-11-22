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
  const given = request.headers.get("x-access-code") || "";
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
 * Streams newline-delimited JSON events to the browser while `work` runs.
 * Sends a heartbeat every 10s so proxies don't drop an idle connection,
 * then a final {type:"done", result} or {type:"error", message} line.
 */
export function ndjsonStream(work) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
      try {
        const result = await work(send);
        send({ type: "done", result });
      } catch (err) {
        console.error(err);
        send({ type: "error", message: friendlyError(err) });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
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

export function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return "API 키가 올바르지 않습니다. 서버 환경변수를 확인해 주세요.";
  if (status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 529 || status === 503) return "AI 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.";
  return err?.userMessage || err?.message || "알 수 없는 오류가 발생했습니다.";
}
