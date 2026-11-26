// What is left to spend on OpenRouter: the smaller of the key's own spending limit and the
// account's credits. Nous Portal and Groq have no API for this, so they aren't shown.
import { checkAccess } from "./_lib/access.js";
import { isMock, json } from "./_lib/http.js";

export async function GET(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;
  if (isMock()) return json({ openrouter: 2.5 });
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return json({ openrouter: null });
  const get = (path) =>
    fetch(`https://openrouter.ai/api/v1/${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  const [k, c] = await Promise.all([get("key"), get("credits")]);
  const left = [k?.data?.limit_remaining, c?.data && c.data.total_credits - c.data.total_usage].filter(Number.isFinite);
  return json({ openrouter: left.length ? Math.max(0, Math.min(...left)) : null });
}
