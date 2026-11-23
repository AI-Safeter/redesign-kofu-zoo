# 인생 이야기 전자책 · Life Chronicle E-book Builder

Upload a recorded interview (Korean) and get a 10–13 page HTML e-book that chronicles one person's life: cover, contents, prologue, 5–8 chronological chapters, a timeline (연보), and an epilogue.

- **Sample book:** `/book?sample` (a fictional person, written by hand to show the format)
- **Builder:** `/` (upload audio → review transcript → generate → read, edit, download)

## How it works

```
Browser                                   Vercel functions (api/)            External APIs
───────                                   ───────────────────────            ─────────────
audio file ─▶ decode at 16 kHz mono,
              cut into ~100 s WAV chunks ─▶ /api/transcribe (per chunk) ─▶ Groq Whisper large-v3 (Korean, free tier)
transcript (user reviews & fixes names)
            ─▶ /api/outline ─────────────▶ Claude or a free OpenRouter model: title, chapter plan, prologue, timeline, epilogue
            ─▶ /api/chapter × N (3 at once) ▶ same model: each chapter's text + pull quote
book JSON saved in localStorage ─▶ /book?id=… reader (page turning, edit mode, font size,
                                   dark mode, print/PDF, download as one standalone .html file)
```

- Long recordings are split in the browser, at quiet moments, so every request stays under Vercel's 4.5 MB body limit.
- When Groq's free tier says "slow down", the browser waits the time Groq asks for and retries that chunk automatically.
- Each chapter is its own request, so no single function call comes close to the 300 s limit. The transcript is sent with prompt caching, so repeated calls for one book reuse it cheaply.
- Claude is told to use only facts from the interview, quote the interviewee's real words, and leave uncertain dates approximate.
- Nothing is stored on the server. Books live in the browser that made them, and **저장** downloads a single self-contained `.html` file you can send to family.

## Deploy to Vercel

1. Push this repository to GitHub (already done if you're reading this there).
2. Go to <https://vercel.com/new>, import the repository, and keep the defaults. `vercel.json` already sets the output directory (`public/`) and the function timeout.
3. In **Settings → Environment Variables**, add:

   | Name | Required | What for |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | one of these two | Writing the book with Claude (best quality, paid). <https://platform.claude.com> |
   | `OPENROUTER_API_KEY` | one of these two | Writing the book with free models through OpenRouter, used when `ANTHROPIC_API_KEY` is not set. <https://openrouter.ai/keys> |
   | `GROQ_API_KEY` | for audio | Transcribing audio, free. Create a key at <https://console.groq.com/keys>. Without it, users can still paste a transcript |
   | `ACCESS_CODE` | recommended | If set, visitors must enter this code before the app calls the paid APIs |
   | `CLAUDE_MODEL` | no | Defaults to `claude-opus-5-5` |
   | `CLAUDE_EFFORT` | no | `low` / `medium` / `high` (default) / `xhigh` / `max` |
   | `OPENROUTER_MODELS` | no | Comma-separated models, tried in order. Default: `baidu/ernie-5.5-flash-preview:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free` |
   | `WRITER_PROVIDER` | no | `anthropic` or `openrouter`, to choose when both keys are set |
   | `GROQ_TRANSCRIBE_MODEL` | no | Defaults to `whisper-large-v3` (`whisper-large-v3-turbo` is faster, slightly less accurate) |
   | `OPENAI_API_KEY` | no | Paid alternative to Groq for transcription; used only when `GROQ_API_KEY` is not set or `TRANSCRIBE_PROVIDER=openai` |
   | `OPENAI_TRANSCRIBE_MODEL` | no | Defaults to `whisper-1` |

4. Redeploy so the variables take effect.

**Set `ACCESS_CODE` on any public deployment.** Without it, anyone who finds the URL can spend your API credits.

## Rough cost per book

For a 1-hour interview: transcription is free on Groq's free tier, which allows about 2 hours of audio per hour (7,200 audio seconds/hour, 20 requests/minute). Very long recordings simply pause and resume while transcribing. With OpenRouter's free models, writing is free too (free models allow about 20 requests a minute; one book uses 6–9). Free models are good but noticeably weaker writers than Claude, and they are sometimes busy, in which case the next model in the list is used. With Claude, writing is 1 outline call plus 5–8 chapter calls on Claude Opus 5.5 ($4 / $20 per million input/output tokens, cached input $0.20), roughly $1–2 depending on transcript length and effort level.

## Run locally

```bash
npm install
cp .env.example .env.local    # add your keys
npm run dev                   # http://localhost:3000
npm run dev:mock              # no keys needed: fake transcription and writing, for trying the UI
```

## Files

```
public/
  index.html            builder page
  book.html             reader
  books/sample.json     sample book (fictional)
  assets/
    builder.js          upload → transcribe → outline → chapters → save
    audio.js            in-browser decoding and chunking of the recording
    book-render.js      e-book renderer (also inlined into downloaded books)
    book.css            e-book styles (also inlined into downloaded books)
    library.js          localStorage library + standalone HTML export
    app.css             builder styles
api/
  config.js             which features this deployment has keys for
  transcribe.js         one audio chunk → text (Groq, or OpenAI as a fallback)
  outline.js            transcript → book plan (Claude)
  chapter.js            transcript + plan → one chapter (Claude)
  _lib/writer.js        prompts, JSON schemas, Claude calls, output clean-up
  _lib/openrouter.js    OpenRouter (free models) calls
  _lib/http.js          access code, streaming responses, error messages
  _lib/mock.js          fake responses for MOCK_AI=1
scripts/dev-server.js   local server that mimics Vercel's routing
```
