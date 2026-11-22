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
    period: c.period,
    summary: c.summary,
    notes: "(모의 데이터)",
  }));
  while (chapters.length < settings.chapters) {
    chapters.push({ ...chapters[chapters.length % book.chapters.length], title: `추가 장 ${chapters.length + 1}` });
  }
  const { title, subtitle, subjectName, born, epigraph, prologue, timeline, epilogue } = book;
  return { outline: { title, subtitle, subjectName, born, epigraph, prologue, chapters, timeline, epilogue } };
}

export async function mockChapter(index, onProgress) {
  const book = await sample();
  for (let i = 1; i <= 4; i++) {
    await sleep(250 + Math.random() * 400);
    onProgress({ type: "progress", chars: i * 500 });
  }
  const c = book.chapters[index % book.chapters.length];
  return { chapter: { paragraphs: c.paragraphs, pullQuote: c.pullQuote } };
}
