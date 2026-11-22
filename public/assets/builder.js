/*
 * Builder page: audio → transcript → outline → chapters → saved book.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var DRAFT_KEY = "chronicle:draft";
  var ACCESS_KEY = "chronicle:access";
  var CHAPTER_CONCURRENCY = 3;
  var TRANSCRIBE_CONCURRENCY = 2; // Groq free tier allows ~20 requests/minute

  var config = { accessCodeRequired: false, transcription: true, writing: true };
  var audioFile = null;
  var busy = false;

  // ---------- Helpers ----------

  function sget(store, key) { try { return store.getItem(key); } catch (e) { return null; } }
  function sset(store, key, v) { try { store.setItem(key, v); } catch (e) {} }

  function headers(extra) {
    var h = Object.assign({}, extra || {});
    var code = $("access").value.trim();
    if (code) h["x-access-code"] = code;
    return h;
  }

  function showNotice(html) {
    var n = $("notice");
    n.innerHTML = html;
    n.hidden = false;
  }

  function formatDuration(sec) {
    if (!sec && sec !== 0) return "";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    if (m >= 60) return Math.floor(m / 60) + "시간 " + (m % 60) + "분";
    return m + "분 " + s + "초";
  }

  async function readError(res) {
    try {
      var data = await res.json();
      return data.error || ("오류 " + res.status);
    } catch (e) {
      return res.status === 413 ? "보낸 데이터가 너무 큽니다." : "서버 오류 (" + res.status + ")";
    }
  }

  // Runs `worker(item, index)` over items with limited parallelism.
  async function pool(items, limit, worker) {
    var next = 0;
    async function lane() {
      while (next < items.length) {
        var i = next++;
        await worker(items[i], i);
      }
    }
    var lanes = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) lanes.push(lane());
    await Promise.all(lanes);
  }

  async function withRetry(fn, tries) {
    for (var attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= tries || e.fatal) throw e;
        await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
      }
    }
  }

  // POSTs JSON and reads the newline-delimited JSON event stream the server sends back.
  async function streamCall(url, body, onEvent) {
    var res = await fetch(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var err = new Error(await readError(res));
      err.fatal = res.status === 400 || res.status === 401;
      throw err;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    var result;
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var lines = buf.split("\n");
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        var ev = JSON.parse(lines[i]);
        if (ev.type === "done") result = ev.result;
        else if (ev.type === "error") throw new Error(ev.message);
        else if (onEvent) onEvent(ev);
      }
    }
    if (!result) throw new Error("서버 연결이 끊겼습니다. 다시 시도해 주세요.");
    return result;
  }

  // ---------- Library ----------

  function renderLibrary() {
    var books = Library.list();
    var ul = $("library-list");
    ul.textContent = "";
    $("library").hidden = books.length === 0;
    books.forEach(function (b) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.className = "library__open";
      a.href = "/book?id=" + encodeURIComponent(b.id);
      var name = document.createElement("span");
      name.className = "library__name";
      name.textContent = b.title + (b.subtitle ? " — " + b.subtitle : "");
      var meta = document.createElement("span");
      meta.className = "library__meta";
      meta.textContent = b.chapters + "장 · " + new Date(b.updatedAt).toLocaleDateString("ko-KR");
      a.append(name, meta);

      var dl = document.createElement("button");
      dl.type = "button";
      dl.className = "btn";
      dl.textContent = "HTML 저장";
      dl.addEventListener("click", function () {
        var book = Library.get(b.id);
        if (book) Library.download(book).catch(function (e) { alert(e.message); });
      });

      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn--danger";
      del.textContent = "삭제";
      del.setAttribute("aria-label", b.title + " 삭제");
      del.addEventListener("click", function () {
        if (confirm("'" + b.title + "' 책을 삭제할까요? 되돌릴 수 없습니다.")) {
          Library.remove(b.id);
          renderLibrary();
        }
      });
      li.append(a, dl, del);
      ul.appendChild(li);
    });
  }

  // ---------- Tabs ----------

  function selectTab(which) {
    var audio = which === "audio";
    $("tab-audio").setAttribute("aria-selected", audio);
    $("tab-text").setAttribute("aria-selected", !audio);
    $("tab-audio").tabIndex = audio ? 0 : -1;
    $("tab-text").tabIndex = audio ? -1 : 0;
    $("panel-audio").hidden = !audio;
    $("panel-text").hidden = audio;
  }
  $("tab-audio").addEventListener("click", function () { selectTab("audio"); });
  $("tab-text").addEventListener("click", function () { selectTab("text"); });
  document.querySelector(".tabs").addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      var toText = $("tab-audio").getAttribute("aria-selected") === "true";
      selectTab(toText ? "text" : "audio");
      $(toText ? "tab-text" : "tab-audio").focus();
    }
  });

  // ---------- Audio selection ----------

  function setFile(file) {
    if (!file) return;
    audioFile = file;
    var mb = (file.size / 1024 / 1024).toFixed(1);
    $("file-info").textContent = "선택한 파일: " + file.name + " (" + mb + "MB)";
    $("file-info").hidden = false;
    $("transcribe-btn").disabled = busy || !config.transcription;
  }

  $("audio-file").addEventListener("change", function (e) { setFile(e.target.files[0]); });
  var dz = $("dropzone");
  ["dragenter", "dragover"].forEach(function (t) {
    dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add("is-over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove("is-over"); });
  });
  dz.addEventListener("drop", function (e) {
    var f = e.dataTransfer.files[0];
    if (f) setFile(f);
  });

  // ---------- Transcription ----------

  function setTranscribeProgress(fraction, label) {
    var box = $("transcribe-progress");
    box.hidden = false;
    box.querySelector(".progress__bar span").style.width = Math.round(fraction * 100) + "%";
    box.querySelector(".progress__label").textContent = label;
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // Sends one chunk; waits out rate limits (429 + retryAfter) and retries transient errors.
  async function transcribeChunk(chunk, i, hint, onWait) {
    var url = "/api/transcribe?index=" + i + "&name=" + encodeURIComponent(chunk.name) +
      (hint ? "&hint=" + encodeURIComponent(hint) : "");
    var failures = 0, waits = 0;
    for (;;) {
      var res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headers({ "content-type": chunk.type || "audio/wav" }),
          body: chunk.blob,
        });
      } catch (e) {
        if (++failures >= 3) throw new Error("네트워크 오류로 음성 인식에 실패했습니다.");
        await sleep(1500 * failures);
        continue;
      }
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (res.ok) return data.text || "";
      if (res.status === 429 && data.retryAfter && waits++ < 20) {
        onWait(data.retryAfter);
        await sleep(data.retryAfter * 1000);
        continue;
      }
      var err = new Error(data.error || "서버 오류 (" + res.status + ")");
      if ([401, 413, 500].indexOf(res.status) >= 0 || ++failures >= 3) throw err;
      await sleep(1500 * failures);
    }
  }

  async function transcribe() {
    if (!audioFile || busy) return;
    busy = true;
    $("transcribe-btn").disabled = true;
    $("make-btn").disabled = true;
    try {
      setTranscribeProgress(0.02, "녹음 파일을 준비하는 중… (긴 녹음은 1분 정도 걸릴 수 있어요)");
      var prepared = await AudioChunker.prepare(audioFile);
      var chunks = prepared.chunks;
      var texts = new Array(chunks.length);
      var done = 0;
      var hint = $("hint").value.trim();
      var lengthNote = prepared.duration ? " · 녹음 길이 " + formatDuration(prepared.duration) : "";
      setTranscribeProgress(0.05, "음성을 글로 옮기는 중… 0/" + chunks.length + lengthNote);

      await pool(chunks, TRANSCRIBE_CONCURRENCY, async function (chunk, i) {
        texts[i] = await transcribeChunk(chunk, i, hint, function (sec) {
          setTranscribeProgress(0.05 + 0.95 * (done / chunks.length),
            "무료 사용량 한도에 걸려 " + sec + "초 기다리는 중… " + done + "/" + chunks.length + lengthNote);
        });
        done++;
        setTranscribeProgress(0.05 + 0.95 * (done / chunks.length), "음성을 글로 옮기는 중… " + done + "/" + chunks.length + lengthNote);
      });

      var text = texts.filter(Boolean).join("\n\n");
      var box = $("transcript");
      box.value = box.value.trim() ? box.value.trim() + "\n\n" + text : text;
      onTranscriptInput();
      setTranscribeProgress(1, "완료! 녹취록 " + text.length.toLocaleString() + "자");
      $("review-note").hidden = false;
      selectTab("text");
      box.focus();
      box.setSelectionRange(0, 0);
      box.scrollTop = 0;
    } catch (e) {
      setTranscribeProgress(0, "실패: " + e.message);
    } finally {
      busy = false;
      $("transcribe-btn").disabled = !audioFile || !config.transcription;
      $("make-btn").disabled = !config.writing;
    }
  }
  $("transcribe-btn").addEventListener("click", transcribe);

  // ---------- Transcript draft ----------

  var draftTimer;
  function onTranscriptInput() {
    var v = $("transcript").value;
    $("transcript-count").textContent = v.length.toLocaleString() + "자" + (v.length && v.length < 200 ? " (200자 이상 필요)" : "");
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { sset(localStorage, DRAFT_KEY, v); }, 500);
  }
  $("transcript").addEventListener("input", onTranscriptInput);

  // ---------- Generation ----------

  var job = null; // kept so failed chapters can be retried

  function stepItem(label) {
    var li = document.createElement("li");
    li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label"></span><span class="meta"></span>';
    li.querySelector(".label").textContent = label;
    $("make-steps").appendChild(li);
    return {
      li: li,
      set: function (state, meta) {
        li.className = state ? "is-" + state : "";
        if (meta !== undefined) li.querySelector(".meta").textContent = meta;
      },
      label: function (t) { li.querySelector(".label").textContent = t; },
    };
  }

  function settingsFromForm() {
    return {
      subjectName: $("subject").value.trim(),
      interviewDate: $("date").value.trim(),
      voice: document.querySelector('input[name="voice"]:checked').value,
      chapters: parseInt($("chapters").value, 10),
      notes: $("notes").value.trim(),
    };
  }

  function showError(msg) {
    $("make-error").textContent = msg;
    $("make-error").hidden = !msg;
  }

  async function startGeneration(e) {
    e.preventDefault();
    if (busy) return;
    var transcript = $("transcript").value.trim();
    if (transcript.length < 200) {
      selectTab("text");
      $("transcript").focus();
      alert("녹취록이 필요합니다. 녹음을 글로 옮기거나 녹취록을 붙여넣어 주세요 (200자 이상).");
      return;
    }
    if (config.accessCodeRequired && !$("access").value.trim()) {
      $("access").focus();
      alert("접근 코드를 입력해 주세요.");
      return;
    }
    sset(sessionStorage, ACCESS_KEY, $("access").value.trim());

    job = { id: Library.newId(), transcript: transcript, settings: settingsFromForm(), outline: null, chapters: [] };
    $("make-steps").textContent = "";
    job.outlineStep = stepItem("이야기의 흐름을 읽고 목차를 짜는 중");
    await runJob();
  }

  async function runJob() {
    busy = true;
    $("make-btn").disabled = true;
    $("transcribe-btn").disabled = true;
    $("retry-btn").hidden = true;
    $("make-progress").hidden = false;
    showError("");
    var started = Date.now();
    var timer = setInterval(function () {
      var s = Math.round((Date.now() - started) / 1000);
      $("make-btn").textContent = "만드는 중… " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 1000);

    var payload = { transcript: job.transcript, settings: job.settings };
    try {
      // 1) Outline
      if (!job.outline) {
        job.outlineStep.set("active", "");
        var res = await withRetry(function () {
          return streamCall("/api/outline", payload, function (ev) {
            if (ev.type === "progress") job.outlineStep.set("active", ev.chars.toLocaleString() + "자");
          });
        }, 2);
        job.outline = res.outline;
        job.outlineStep.set("done", "");
        job.outlineStep.label("목차 완성: 《" + job.outline.title + "》");
        job.chapterSteps = job.outline.chapters.map(function (c, i) {
          return stepItem("제" + (i + 1) + "장 " + c.title);
        });
        job.chapters = new Array(job.outline.chapters.length);
      }

      // 2) Chapters (only the ones not written yet)
      var todo = [];
      job.outline.chapters.forEach(function (c, i) { if (!job.chapters[i]) todo.push(i); });
      var failures = [];
      await pool(todo, CHAPTER_CONCURRENCY, async function (i) {
        var step = job.chapterSteps[i];
        step.set("active", "쓰는 중");
        try {
          var r = await withRetry(function () {
            return streamCall("/api/chapter", Object.assign({ outline: job.outline, index: i }, payload), function (ev) {
              if (ev.type === "progress") step.set("active", ev.chars.toLocaleString() + "자");
            });
          }, 2);
          job.chapters[i] = r.chapter;
          step.set("done", "");
        } catch (err) {
          failures.push(err.message);
          step.set("failed", "실패");
        }
      });

      if (failures.length) {
        showError(failures.length + "개 장을 쓰지 못했습니다: " + failures[0]);
        $("retry-btn").hidden = false;
        return;
      }

      // 3) Assemble and save
      var o = job.outline;
      var book = {
        id: job.id,
        createdAt: new Date().toISOString(),
        settings: job.settings,
        title: o.title,
        subtitle: o.subtitle,
        subjectName: o.subjectName || job.settings.subjectName,
        born: o.born,
        epigraph: o.epigraph,
        prologue: o.prologue,
        chapters: o.chapters.map(function (c, i) {
          return {
            title: c.title,
            period: c.period,
            summary: c.summary,
            paragraphs: job.chapters[i].paragraphs,
            pullQuote: job.chapters[i].pullQuote,
          };
        }),
        timeline: o.timeline,
        epilogue: o.epilogue,
      };
      if (!Library.save(book)) {
        // Storage full: still let the user keep the result.
        showError("브라우저 저장 공간이 부족합니다. 책을 HTML 파일로 내려받습니다.");
        await Library.download(book);
        return;
      }
      Library.saveTranscript(book.id, job.transcript);
      sset(localStorage, DRAFT_KEY, "");
      var done = stepItem("완성! 책을 펼칩니다");
      done.set("done", "");
      setTimeout(function () { location.href = "/book?id=" + encodeURIComponent(book.id); }, 700);
    } catch (err) {
      if (job.outlineStep && !job.outline) job.outlineStep.set("failed", "실패");
      showError(err.message);
      $("retry-btn").hidden = false;
    } finally {
      clearInterval(timer);
      busy = false;
      $("make-btn").textContent = "전자책 만들기";
      $("make-btn").disabled = !config.writing;
      $("transcribe-btn").disabled = !audioFile || !config.transcription;
    }
  }

  $("builder").addEventListener("submit", startGeneration);
  $("retry-btn").addEventListener("click", function () {
    if (job && !busy) runJob();
  });

  window.addEventListener("beforeunload", function (e) {
    if (busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- Init ----------

  async function init() {
    renderLibrary();
    var draft = sget(localStorage, DRAFT_KEY);
    if (draft) {
      $("transcript").value = draft;
      onTranscriptInput();
    }
    $("access").value = sget(sessionStorage, ACCESS_KEY) || "";

    try {
      var res = await fetch("/api/config");
      if (!res.ok) throw new Error();
      config = await res.json();
    } catch (e) {
      config = { accessCodeRequired: false, transcription: false, writing: false };
      showNotice("서버 기능(API)에 연결하지 못했습니다. 샘플 책은 볼 수 있지만, 새 책을 만들려면 Vercel 등 서버 기능이 있는 곳에 배포해야 합니다.");
    }
    $("access-field").hidden = !config.accessCodeRequired;
    var problems = [];
    if (!config.transcription) problems.push("음성 인식용 GROQ_API_KEY가 없어 오디오를 글로 옮길 수 없습니다. 녹취록을 직접 붙여넣어 주세요.");
    if (!config.writing) problems.push("ANTHROPIC_API_KEY가 없어 책을 쓸 수 없습니다.");
    if (config.mock) problems.push("모의(MOCK) 모드입니다. 실제 AI 대신 샘플 내용으로 동작합니다.");
    if (problems.length && $("notice").hidden) {
      showNotice(problems.map(function (p) { return "• " + p.replace(/[<>&]/g, ""); }).join("<br>"));
    }
    if (!config.transcription && !draft) selectTab("text");
    $("make-btn").disabled = !config.writing;
  }

  init();
})();
