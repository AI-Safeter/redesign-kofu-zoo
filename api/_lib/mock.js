// Fake responses for MOCK_AI=1, so the UI can be tried without API keys.
// Built from the bundled sample book.
import { readFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sample() {
  const file = path.join(process.cwd(), "public/books/sample.json");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function mockTranscribe(index) {
  await sleep(600);
  return `(모의 녹취 ${index + 1}) 어릴 적에 우리 집은 바닷가 바로 앞이었어요. 아침마다 갯벌 냄새가 났지. 아버지는 배를 타셨고 어머니는 굴을 까셨어요. `.repeat(4);
}

export async function mockOutline(settings, onProgress) {
  const book = await sample();
  for (let i = 1; i <= 5; i++) {
    await sleep(300);
    onProgress({ type: "progress", chars: i * 700 });
  }
  const chapters = book.chapters.slice(0, settings.chapters).map((c) => ({
    title: c.title,
    yearFrom: c.yearFrom,
    yearTo: c.yearTo,
    place: c.place,
    summary: c.summary,
    events: [],
    quotes: [c.pullQuote.text],
    notes: "(모의 데이터)",
  }));
  const { title, subtitle, subjectName, birthYear, birthplace, epigraph, people, prologue, timeline, lastWords, epilogue } = book;
  return {
    outline: { kind: "life", speakerRole: "", speaksAs: "나", title, subtitle, subjectName, birthYear, birthplace, epigraph, people, prologue, chapters, timeline: timeline.filter((t) => t.chapter <= chapters.length), lastWords, epilogue },
    model: "mock",
  };
}

export async function mockFixes(transcript) {
  return {
    fixes: transcript.includes("갯벌")
      ? [{ heard: "갯벌", meant: "갯벌", kind: "mishearing", checked: false, why: "(시험 모드 예시 — 실제로는 잘못 들린 말만 보여 줍니다)" }]
      : [],
    model: "mock",
  };
}

export async function mockChapter(index, onProgress) {
  const book = await sample();
  for (let i = 1; i <= 4; i++) {
    await sleep(250 + Math.random() * 400);
    onProgress({ type: "progress", chars: i * 500 });
  }
  const c = book.chapters[index % book.chapters.length];
  return { chapter: { paragraphs: c.paragraphs, pullQuote: c.pullQuote, excerpt: c.excerpt, unverified: [] }, model: "mock" };
}
