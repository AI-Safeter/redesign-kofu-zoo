# 인생 이야기 전자책 · Life Chronicle E-book Builder

Upload a recorded interview (Korean) and get an HTML e-book that chronicles one person's life, in time order:

- **Cover**, **contents**, **이 책의 사람들** (the people in the story), **책을 펴내며** (preface with an epigraph in their own words)
- **3–8 chapters**, each opening with its years, the person's age and the place (e.g. "1955–1972 · 출생–17세 · 경북 안동"), a pull quote, and an **인터뷰에서** box with a real question and answer from the recording
- **남기고 싶은 말** (their message to the family, verbatim), **연보** (timeline grouped by chapter, with ages) and **에필로그**

- **Sample book:** `/book?sample` (a fictional person, written by hand to show the format)
- **Builder:** `/` (upload audio and press 전자책 만들기 → read, correct in 글 고치기, save as a file or PDF)

### Faithfulness

A family book must not put words in anyone's mouth, so the pipeline checks the model's work in code:

- Every quotation (pull quotes, the epigraph, 남기고 싶은 말, the interview excerpts, and any “…” in the text) is matched against the transcript. Quotes that can't be found are dropped or, inside the text, listed for the family to check in 글 고치기 mode.
- The number of chapters is capped by how much the interview contains (about one chapter per 1,500 characters), and chapter length is scaled to the material, so a short interview gives a short book instead of a padded one.
- Each episode and quote is assigned to one chapter; repeated paragraphs and sentences are removed.
- Ages are computed from years in code, not by the model.

## How it works

```
Browser                                   Vercel functions (api/)            External APIs
───────                                   ───────────────────────            ─────────────
audio file ─▶ decode at 16 kHz mono,
              cut into ~100 s WAV chunks ─▶ /api/transcribe (per chunk) ─▶ Qwen 3.8 Omni Flash / Gemini 2.5 Flash (OpenRouter),
                                                               falling back to Groq Whisper large-v3 (free)
transcript ─▶ /api/fixes: confident sound-alike corrections applied automatically
            ─▶ /api/outline ─────────────▶ Claude or a free OpenRouter model: title, chapter plan, prologue, timeline, epilogue
            ─▶ /api/chapter × N (3 at once) ▶ same model: each chapter's text + pull quote
book JSON saved in localStorage ─▶ /book?id=… reader (page turning, edit mode, font size,
                                   dark mode, print/PDF, download as one standalone .html file)
```

- Long recordings are split in the browser, at quiet moments, so every request stays under Vercel's 4.5 MB body limit.
- **Why audio language models instead of Whisper:** on a real 9-minute Korean interview, scored on 17 hard spots (names, numbers, terms, the speaker's introduction), the app's Whisper pieces got 5/17 and even the whole file only 10/17, and Whisper's output changed when the audio start moved by 0.4 s. Qwen 3.8 Omni Flash got 13–14/17 and Gemini 2.5 Flash 13–14/17 on the same pieces, kept the speaker's fillers and invented nothing. Qwen costs about 2 cents per hour of audio.
- If the audio models fail (or the OpenRouter account has no credit), each piece falls back to Groq Whisper. When Groq's free tier says "slow down", the browser waits the time Groq asks for and retries.
- The user never has to read the transcript. After transcription, an AI proofreading step finds likely mishearings and applies only the confident sound-alike ones; numbers, names and terms are left as heard. Anything else is corrected in the finished book with 글 고치기.
- Each chapter is its own request, so no single function call comes close to the 300 s limit. The transcript is sent with prompt caching, so repeated calls for one book reuse it cheaply.
- Claude is told to use only facts from the interview, quote the interviewee's real words, and leave uncertain dates approximate.
- Nothing is stored on the server. Books live in the browser that made them, and **보기 설정 → HTML 파일로 저장** downloads a single self-contained `.html` file you can send to family.
- A book in progress is saved after every step: if a chapter fails or the page is reloaded, **이어서 쓰기** continues where it stopped.
- With OpenRouter, a model that loops or returns broken JSON is skipped and the request is retried on the next free model.

## Deploy to Vercel

1. Push this repository to GitHub (already done if you're reading this there).
2. Go to <https://vercel.com/new>, import the repository, and keep the defaults. `vercel.json` already sets the output directory (`public/`) and the function timeout.
3. In **Settings → Environment Variables**, add:

   | Name | Required | What for |
   |---|---|---|
   | `NOUS_API_KEY` | recommended | Writing the book with Claude Sonnet 5.5 through Nous Portal (best Korean in our tests, ≈$0.25 per 1-hour interview with prompt caching). <https://portal.nousresearch.com> |
   | `OPENROUTER_API_KEY` | recommended | Speech recognition (Qwen audio model), and free writing models used when there is no Nous key or Nous fails. <https://openrouter.ai/keys> |
   | `ANTHROPIC_API_KEY` | no | Writing with Claude through Anthropic's own API instead; takes priority over the gateways when set. <https://platform.claude.com> |
   | `GROQ_API_KEY` | recommended | Free Whisper fallback for transcription (used when the OpenRouter audio models fail or there's no OpenRouter key). Create a key at <https://console.groq.com/keys>. Without it, recordings can only be transcribed through OpenRouter |
   | `BLOB_READ_WRITE_TOKEN` | for 발행하기 | Publishing books as read-only pages (`/read?id=…`). Set automatically when you create a Blob store in Vercel (Storage → Create → Blob) and connect it to this project. Without it the 발행하기 button is hidden |
   | `ACCESS_CODE` | recommended | If set, visitors must enter this code before the app calls the paid APIs |
   | `CLAUDE_MODEL` | no | Defaults to `claude-opus-5-5` |
   | `CLAUDE_EFFORT` | no | `low` / `medium` / `high` (default) / `xhigh` / `max` |
   | `OPENROUTER_MODELS` | no | Comma-separated models, tried in order. Default: `nvidia/nemotron-3-ultra-550b-a55b:free`, `baidu/ernie-5.5-flash-preview:free`, `google/gemma-4-31b-it:free` |
   | `NOUS_MODELS` | no | Comma-separated Nous Portal models, tried in order. Default: `anthropic/claude-sonnet-5.5` |
   | `WRITER_EFFORT` | no | Reasoning effort for the gateway models: `low` (default) / `medium` / `high` |
   | `WRITER_PROVIDER` | no | `anthropic` or `gateway` (Nous, then OpenRouter), to choose when both kinds of key are set |
   | `OPENROUTER_AUDIO_MODELS` | no | Audio models for transcription, tried in order. Default: `qwen/qwen3.8-omni-flash`, `google/gemini-2.5-flash`. These are paid (≈$0.02 and ≈$0.15 per hour of audio), so the OpenRouter account needs some credit |
   | `TRANSCRIBE_PROVIDER` | no | `openrouter`, `groq` or `openai` to force one transcription engine |
   | `GROQ_TRANSCRIBE_MODEL` | no | Defaults to `whisper-large-v3` (`whisper-large-v3-turbo` is faster, slightly less accurate) |
   | `OPENAI_API_KEY` | no | Paid alternative to Groq for transcription; used only when `GROQ_API_KEY` is not set or `TRANSCRIBE_PROVIDER=openai` |
   | `OPENAI_TRANSCRIBE_MODEL` | no | Defaults to `whisper-1` |

4. Redeploy so the variables take effect.

**Set `ACCESS_CODE` on any public deployment.** Without it, anyone who finds the URL can spend your API credits.

## Rough cost per book

For a 1-hour interview: transcription costs about $0.02 with Qwen 3.8 Omni Flash (or nothing on Groq's free Whisper fallback, which allows about 2 hours of audio per hour: 7,200 audio seconds/hour, 20 requests/minute). Very long recordings simply pause and resume while transcribing. With OpenRouter's free models, writing is free too (free models allow about 20 requests a minute; one book uses 3–13). Free models are good but noticeably weaker writers than Claude, and they are sometimes busy, in which case the next model in the list is used. With Claude, writing is 1 outline call plus one call per chapter (up to 12; the interview length decides) on Claude Opus 5.5 ($4 / $20 per million input/output tokens, cached input $0.20), roughly $1–2 depending on transcript length and effort level.

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
  transcribe.js         one audio chunk → text (OpenRouter audio models, Whisper fallback)
  _lib/audio-llm.js     transcription with audio language models (Qwen, Gemini) via OpenRouter
  outline.js            transcript → book plan
  chapter.js            transcript + plan → one chapter
  fixes.js              transcript → suggested corrections of mishearings
  publish.js            book → read-only page in Vercel Blob (same link when published again); DELETE removes it
  read.js               published book for /read?id=…
  _lib/books.js         Vercel Blob storage (in memory with MOCK_AI=1)
  _lib/writer.js        prompts, JSON schemas, Claude calls, output clean-up and checks
  _lib/verify.js        checks that quotations appear in the transcript
  _lib/openrouter.js    OpenRouter (free models) calls
  _lib/http.js          access code, streaming responses, error messages
  _lib/mock.js          fake responses for MOCK_AI=1
scripts/dev-server.js   local server that mimics Vercel's routing
```
