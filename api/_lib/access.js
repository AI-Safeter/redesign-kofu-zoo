// The site's access code (ACCESS_CODE). After 20 wrong tries from one network address within
// 24 hours, that address is refused, even with the right code, until the 24 hours have passed,
// so the code can't be found by trying every number.
// Wrong tries are counted in this server's memory (so a burst of parallel guesses is stopped
// at once) and, when a Blob store is connected, as small files in it (so the count is shared by
// every server instance and survives restarts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { del, list, put } from "@vercel/blob";
import { errorResponse, isMock } from "./http.js";

const MAX_TRIES = 20;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const tries = new Map(); // address → times of wrong tries seen by this instance
const lockedUntil = new Map(); // address → time, once a lock was found in the store
const known = new Set(); // addresses that gave the right code while not locked: they know it

const useStore = () => !isMock() && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const recent = (times, now) => times.filter((t) => now - t < WINDOW_MS);

/** "ok", "wrong" (the code given is wrong) or "locked" (too many wrong tries from here). */
export async function accessStatus(request) {
  const code = process.env.ACCESS_CODE;
  if (!code) return "ok";
  const header = request.headers.get("x-access-code");
  if (!header) return "wrong"; // no code sent (a first visit): not a guess, so not counted
  const now = Date.now();
  const addr = addressOf(request, code);
  const right = matches(header, code);

  const mine = recent(tries.get(addr) || [], now);
  if (!right) mine.push(now); // counted before anything is awaited, so parallel guesses add up
  tries.set(addr, mine);
  if (right && known.has(addr)) return "ok";
  const limit = right ? MAX_TRIES : MAX_TRIES + 1; // the 20th wrong try is still only "wrong"
  if (mine.length >= limit || (lockedUntil.get(addr) || 0) > now) return "locked";

  if (useStore()) {
    try {
      const prefix = `access/${addr}/`;
      if (!right) {
        await put(`${prefix}${now}-${randomBytes(4).toString("hex")}`, "1", { access: "public", addRandomSuffix: false, contentType: "text/plain" });
      }
      const { blobs } = await list({ prefix, limit: 1000 });
      const time = (b) => Number(b.pathname.slice(prefix.length).split("-")[0]);
      const old = blobs.filter((b) => now - time(b) >= WINDOW_MS);
      if (old.length) del(old.map((b) => b.url)).catch(() => {});
      const stored = blobs.filter((b) => now - time(b) < WINDOW_MS).map(time).sort((a, b) => a - b);
      if (stored.length >= limit) {
        lockedUntil.set(addr, stored[stored.length - MAX_TRIES] + WINDOW_MS);
        return "locked";
      }
    } catch (err) {
      console.error("Access-try store failed; counting in memory only:", err.message);
    }
  }
  if (!right) return "wrong";
  known.add(addr);
  return "ok";
}

/** Returns an error Response when the access code is required and missing/wrong, otherwise null. */
export async function checkAccess(request) {
  const status = await accessStatus(request);
  if (status === "ok") return null;
  return errorResponse(status === "locked" ? "접근 코드를 여러 번 틀려서 24시간 동안 쓸 수 없어요." : "접근 코드가 올바르지 않습니다.", 401);
}

function matches(header, code) {
  let given = header;
  try {
    given = decodeURIComponent(given);
  } catch {}
  const [a, b] = [Buffer.from(given), Buffer.from(code)];
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The caller's address, hashed with the code so the stored names say nothing on their own. */
function addressOf(request, code) {
  // Vercel sets these itself (a client can't choose them); the local dev server has neither.
  const ip = request.headers.get("x-real-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  return createHash("sha256").update(`${code}\n${ip}`).digest("hex").slice(0, 32);
}
