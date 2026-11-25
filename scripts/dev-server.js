// Local development server: serves public/ and routes /api/<name> to api/<name>.js,
// calling its exported GET/POST handler the same way Vercel does.
// Usage: npm run dev   (reads .env.local / .env if present)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const PORT = Number(process.env.PORT) || 3000;

// Variables already in the environment win; .env.local wins over .env.
for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function handleApi(req, res, name) {
  const file = path.join(root, "api", `${name}.js`);
  if (!/^[a-z-]+$/.test(name) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod[req.method];
  if (!handler) {
    res.writeHead(405).end("Method not allowed");
    return;
  }
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
  // Abort the handler's work when the browser goes away, as Vercel does.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body,
    duplex: "half",
    signal: abort.signal,
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    const stream = Readable.fromWeb(response.body);
    res.on("close", () => stream.destroy()); // cancels the web stream too
    stream.pipe(res);
  }
  else res.end();
}

async function handleStatic(req, res) {
  let file = path.join(root, "public", decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(path.join(root, "public"))) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
  } catch {
    if (existsSync(file + ".html")) file += ".html"; // cleanUrls, like vercel.json
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

http
  .createServer(async (req, res) => {
    try {
      const m = req.url.match(/^\/api\/([^/?]+)/);
      if (m) await handleApi(req, res, m[1]);
      else await handleStatic(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Server error");
    }
  })
  .listen(PORT, () => {
    console.log(`InterviewToEbook: http://localhost:${PORT}${process.env.MOCK_AI === "1" ? "  (mock AI)" : ""}`);
  });
