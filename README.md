# InterviewToEbook · 인생 이야기 전자책

Live: https://interview-to-ebook.vercel.app

Upload a recorded interview (Korean) and get an HTML e-book that chronicles one person's life, in time order:

- **Cover**, **contents**, **이 책의 사람들** (the people in the story), **책을 펴내며** (preface with an epigraph in their own words)
- **Chapters** (up to 12; the interview's length decides), each opening with its years, the person's age and the place (e.g. "1955–1972 · 출생–17세 · 경북 안동"), a pull quote, and an **인터뷰에서** box with a real question and answer from the recording
- **남기고 싶은 말** (their message to the family, verbatim), **연보** (timeline grouped by chapter, with ages) and **에필로그**

- **Builder:** `/` (upload audio and press 전자책 만들기 → read, correct in 글 고치기, save as a file or PDF)
- **Published books:** `/read?id=…` (read-only pages made with 발행하기)

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
            ─▶ /api/outline ─────────────▶ Claude Sonnet 5.5 via Nous (free OpenRouter models as fallback): title, chapter plan, prologue, timeline, epilogue
            ─▶ /api/chapter × N (3 at once) ▶ same model: each chapter's text + pull quote
book JSON saved in localStorage ─▶ /book?id=… reader (page turning, 글 고치기, 한꺼번에 바꾸기, 발행)
published copy in Vercel Blob ───▶ /read?id=… read-only page anyone with the link can open
```

- Long recordings are split in the browser, at quiet moments, so every request stays under Vercel's 4.5 MB body limit.
- **Why audio language models instead of Whisper:** on a real 9-minute Korean interview, scored on 17 hard spots (names, numbers, terms), Whisper got 5/17 on the app's pieces and 10/17 on the whole file; Qwen 3.8 Omni Flash and Gemini 2.5 Flash got 13–14/17 on the same pieces and invented nothing.
- If the audio models fail (or the OpenRouter account has no credit), each piece falls back to Groq Whisper. When Groq's free tier says "slow down", the browser waits the time Groq asks for and retries.
- The user never has to read the transcript. An AI proofreading step, helped by a second, independent transcription from Gemini 2.5 Flash, finds likely mishearings and applies only the confident sound-alike ones; numbers, names and terms are left as heard. Anything else is corrected in the finished book with 글 고치기.
- Each chapter is its own request, so no single function call comes close to the 300 s limit. The transcript is sent with prompt caching, so repeated calls for one book reuse it cheaply.
- Books live in the browser that made them. Only a book you **발행** is stored on the server (Vercel Blob), and **발행 취소** deletes it. **파일로 저장** in 내 서재 downloads a single self-contained `.html` file you can send to family.
- A book in progress is saved after every step: if a chapter fails or the page is reloaded, **이어서 쓰기** continues where it stopped.
- A model that loops or returns broken JSON is skipped and the request is retried on the next model.

## Deploy to Vercel

1. Push this repository to GitHub (already done if you're reading this there).
2. Go to <https://vercel.com/new>, import the repository, and keep the defaults. `vercel.json` already sets the output directory (`public/`) and the function timeout.
3. For 발행하기, create a Blob store (**Storage → Create → Blob**, public access) and connect it to this project. This sets `BLOB_READ_WRITE_TOKEN`.
4. In **Settings → Environment Variables**, add:

   | Name | Required | What for |
   |---|---|---|
   | `NOUS_API_KEY` | recommended | Writing the book with Claude Sonnet 5.5 through Nous Portal (best Korean in our tests, ≈$0.25 per 1-hour interview with prompt caching). <https://portal.nousresearch.com> |
   | `OPENROUTER_API_KEY` | recommended | Speech recognition (Qwen audio model), and free writing models used when there is no Nous key or Nous fails. <https://openrouter.ai/keys> |
   | `GROQ_API_KEY` | recommended | Free Whisper fallback for transcription (used when the OpenRouter audio models fail or there's no OpenRouter key). Create a key at <https://console.groq.com/keys>. Without it, recordings can only be transcribed through OpenRouter |
   | `BLOB_READ_WRITE_TOKEN` | for 발행하기 | Publishing books as read-only pages (`/read?id=…`). Set by step 3. Without it the 발행하기 button is hidden |
   | `ACCESS_CODE` | recommended | If set, visitors must enter this code (once per device) before the app calls the paid APIs. After 20 wrong tries, that network address is refused for 24 hours |
   | `OPENROUTER_MODELS` | no | Comma-separated models, tried in order. Default: `nvidia/nemotron-3-ultra-550b-a55b:free`, `baidu/ernie-5.5-flash-preview:free`, `google/gemma-4-31b-it:free` |
   | `NOUS_MODELS` | no | Comma-separated Nous Portal models, tried in order. Default: `anthropic/claude-sonnet-5.5` |
   | `WRITER_EFFORT` | no | Reasoning effort for the gateway models: `low` (default) / `medium` / `high` |
   | `OPENROUTER_AUDIO_MODELS` | no | Audio models for transcription, tried in order. Default: `qwen/qwen3.8-omni-flash`, `google/gemini-2.5-flash`. These are paid (≈$0.02 and ≈$0.15 per hour of audio), so the OpenRouter account needs some credit |
   | `OPENROUTER_AUDIO_CHECK_MODEL` | no | Second audio model whose transcription guides proofreading. Default: `google/gemini-2.5-flash`; set it empty to turn it off |
   | `TRANSCRIBE_PROVIDER` | no | `openrouter` or `groq` to force one transcription engine |
   | `GROQ_TRANSCRIBE_MODEL` | no | Defaults to `whisper-large-v3` (`whisper-large-v3-turbo` is faster, slightly less accurate) |

5. Redeploy so the variables take effect.

**Set `ACCESS_CODE` on any public deployment.** Without it, anyone who finds the URL can spend your API credits.

## Rough cost per book

For a 1-hour interview: transcription costs about $0.02 with Qwen 3.8 Omni Flash, plus about $0.15 for the Gemini second opinion (or nothing on Groq's free Whisper fallback, which allows about 2 hours of audio per hour; longer recordings pause and resume). Writing through Nous is 1 outline call plus one call per chapter (up to 12) on Claude Sonnet 5.5, with the transcript cached after the first call: about $0.07 for a 9-minute interview and roughly $0.20 for an hour. OpenRouter's free models write for nothing but noticeably worse, and are sometimes busy, in which case the next model in the list is used.

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
  read.html             published book page
  books/sample.json     sample book (fictional), used as fake output with MOCK_AI=1
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
  _lib/writer.js        prompts, JSON schemas, output clean-up and checks
  _lib/verify.js        checks that quotations appear in the transcript
  _lib/openrouter.js    writing calls to Nous and OpenRouter
  _lib/http.js          access code, streaming responses, error messages
  _lib/mock.js          fake responses for MOCK_AI=1
scripts/dev-server.js   local server that mimics Vercel's routing
```
