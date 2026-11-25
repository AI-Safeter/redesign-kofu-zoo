/*
 * Builder page: audio → transcript (auto-corrected) → outline → chapters → saved book.
 * A book in progress is saved after every step, so a reload or a failed chapter never
 * throws away work that is already done.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var JOB_KEY = "chronicle:job";
  var TX_KEY = "chronicle:tx";
  var ACCESS_KEY = "chronicle:access";
  var CHAPTER_CONCURRENCY = 3;

  var config = { accessCodeRequired: false, transcription: true, writing: true };
  var accessCode = sget(ACCESS_KEY) || ""; // asked once, on the first visit
  var audioFile = null;
  var busy = false;
  var tx = null; // the current transcription: { id, file, hint, prepared, texts, alts }
  var job = null; // the current book: { id, transcript, settings, outline, chapters }
  var steps = null; // the progress list's items for the current run

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- Small helpers ----------

  function sget(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function sgetJson(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function sset(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }
  function sdel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  function headers(extra) {
    var h = Object.assign({}, extra);
    if (accessCode) h["x-access-code"] = encodeURIComponent(accessCode); // header values must be ASCII
    return h;
  }

  function showNotice(lines) {
    var n = $("notice");
    n.textContent = "";
    lines.forEach(function (l) {
      var p = document.createElement("p");
      p.textContent = l;
      n.appendChild(p);
    });
    n.hidden = lines.length === 0;
  }

  function formatDuration(sec) {
    var total = Math.round(sec); // round first, so 179.98 s reads 3분 0초, not 2분 60초
    var m = Math.floor(total / 60), s = total % 60;
    if (m >= 60) return Math.floor(m / 60) + "시간 " + (m % 60) + "분";
    return m ? m + "분 " + s + "초" : s + "초";
  }

  async function readError(res) {
    try {
      var data = await res.json();
      if (data.error) return data.error;
    } catch (e) {}
    if (res.status === 413) return "보낸 데이터가 너무 큽니다.";
    if (res.status === 401) return "접근 코드가 올바르지 않습니다.";
    return "일시적인 서버 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.";
  }

  async function withRetry(fn, tries) {
    for (var attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= tries || e.fatal) throw e;
        await sleep(4000 * attempt);
      }
    }
  }

  // POSTs JSON and reads the newline-delimited JSON event stream the server sends back.
  async function streamCall(url, body, onEvent) {
    var res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("인터넷 연결이 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
    }
    if (!res.ok) {
      var err = new Error(await readError(res));
      err.fatal = res.status === 400 || res.status === 401;
      throw err;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    var result;
    try {
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
    } catch (e) {
      if (e instanceof SyntaxError || /network|fetch|load/i.test(e.message)) {
        throw new Error("서버 연결이 끊겼습니다. 다시 시도해 주세요.");
      }
      throw e;
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
      li.innerHTML = '<a class="library__open"><span class="library__name"></span><span class="library__meta"></span></a>' +
        '<div class="library__actions"><button type="button" class="btn">파일로 저장</button><button type="button" class="btn btn--danger">삭제</button></div>';
      li.querySelector("a").href = "/book?id=" + encodeURIComponent(b.id);
      li.querySelector(".library__name").textContent = b.title + (b.subtitle ? " — " + b.subtitle : "");
      li.querySelector(".library__meta").textContent = b.chapters + "장 · " + new Date(b.updatedAt).toLocaleDateString("ko-KR");
      var buttons = li.querySelectorAll("button");
      buttons[0].onclick = function () {
        var book = Library.get(b.id);
        if (book) Library.download(book).catch(function (e) { showNotice([e.message]); });
      };
      buttons[1].setAttribute("aria-label", b.title + " 삭제");
      buttons[1].onclick = function () {
        if (confirm("‘" + b.title + "’ 책을 삭제할까요? 되돌릴 수 없습니다.")) {
          Library.remove(b.id);
          renderLibrary();
        }
      };
      ul.appendChild(li);
    });
  }

  // ---------- Step 1: audio ----------

  var MEDIA_NAME = /\.(mp3|m4a|mp4|aac|wav|ogg|oga|opus|flac|webm|mov|amr|3gp|wma)$/i;
  function setFile(file) {
    if (!file || busy) return; // the picker is disabled while transcribing; ignore drops too
    if (!file.size) return showFileInfo("빈 파일이에요. 녹음 파일을 다시 골라 주세요.", true);
    if (!/^(audio|video)\//.test(file.type) && !MEDIA_NAME.test(file.name)) {
      return showFileInfo("녹음(오디오)이나 동영상 파일을 골라 주세요. ‘" + file.name + "’은(는) 녹음 파일이 아니에요.", true);
    }
    audioFile = file;
    tx = null;
    showFileInfo("선택한 파일: " + file.name + " (" + (file.size / 1024 / 1024).toFixed(1) + "MB)", false);
  }

  function showFileInfo(msg, isError) {
    $("file-info").textContent = msg;
    $("file-info").hidden = false;
    $("file-info").classList.toggle("is-error", isError);
  }

  $("audio-file").addEventListener("change", function (e) { setFile(e.target.files[0]); });
  var dz = $("dropzone");
  // A file dropped anywhere else on the page must not make the browser open it (and lose the work).
  ["dragover", "drop"].forEach(function (t) {
    document.addEventListener(t, function (e) { if (!dz.contains(e.target)) e.preventDefault(); });
  });
  ["dragenter", "dragover"].forEach(function (t) {
    dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add("is-over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove("is-over"); });
  });
  dz.addEventListener("drop", function (e) { setFile(e.dataTransfer.files[0]); });
  var coarsePointer = matchMedia("(pointer: coarse)").matches; // phones and tablets
  if (coarsePointer) $("dropzone-main").textContent = "눌러서 녹음 파일 고르기";

  // Sends one chunk; waits out rate limits (429 + retryAfter) and retries short outages.
  async function transcribeChunk(chunk, i, hint, onWait, prev) {
    var url = "/api/transcribe?index=" + i + "&name=" + encodeURIComponent(chunk.name) +
      (hint ? "&hint=" + encodeURIComponent(hint) : "") +
      (prev ? "&prev=" + encodeURIComponent(prev.slice(-300)) : "");
    var failures = 0, waits = 0;
    for (;;) {
      var res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headers({ "content-type": chunk.type || "audio/wav" }),
          body: chunk.getBlob(),
        });
      } catch (e) {
        if (++failures >= 3) throw new Error("인터넷 연결이 끊겨 받아쓰기를 마치지 못했습니다.");
        await sleep(1500 * failures);
        continue;
      }
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (res.ok) {
        tx.alts[i] = data.alt || "";
        return data.text || "";
      }
      if (res.status === 429 && data.retryAfter && waits++ < 20) {
        onWait(data.retryAfter);
        await sleep(data.retryAfter * 1000);
        continue;
      }
      var err = new Error(data.error || "받아쓰기 서버에 문제가 생겼습니다.");
      if ([401, 413, 500].indexOf(res.status) >= 0 || ++failures >= 3) throw err;
      await sleep(1500 * failures);
    }
  }

  /**
   * Turns the chosen recording into text, one piece at a time (each piece gets the end of the
   * previous one as context). report(fraction, label) shows progress.
   */
  async function transcribeRecording(report) {
    var hint = $("hint").value.trim();
    if (tx && tx.done && tx.file === audioFile && tx.hint === hint) return tx.text;
    // A new file or a changed name/term hint means the pieces must be heard again.
    if (!tx || tx.file !== audioFile || tx.hint !== hint) {
      report(0, "녹음 파일을 준비하는 중");
      tx = { file: audioFile, hint: hint, prepared: await AudioChunker.prepare(audioFile), texts: [], alts: [] };
      tx.id = [audioFile.name, audioFile.size, audioFile.lastModified, hint].join("|");
      var saved = sgetJson(TX_KEY);
      if (saved && saved.id === tx.id && saved.total === tx.prepared.chunks.length) {
        tx.texts = saved.texts || [];
        tx.alts = saved.alts || [];
      }
    }
    var chunks = tx.prepared.chunks;
    var total = chunks.length;
    var lengthNote = tx.prepared.duration ? " · 녹음 길이 " + formatDuration(tx.prepared.duration) : "";
    var done = tx.texts.filter(function (t) { return t != null; }).length;
    var started = Date.now();
    var doneHere = 0;
    var progress = function (extra) {
      var eta = doneHere > 0 && done < total ? " · 약 " + Math.ceil((((Date.now() - started) / doneHere) * (total - done)) / 60000) + "분 남음" : "";
      report(done / total, (extra || "녹음을 글로 옮기는 중 ") + done + "/" + total + lengthNote + eta);
    };
    progress();
    for (var i = 0; i < total; i++) {
      if (tx.texts[i] != null) continue;
      tx.texts[i] = await transcribeChunk(chunks[i], i, hint, function (sec) {
        progress("사용량 한도로 " + sec + "초 기다리는 중 ");
      }, i > 0 ? tx.texts[i - 1] : "");
      done++;
      doneHere++;
      // Saved as each piece arrives, so a reload or a sleeping phone doesn't lose it:
      // choosing the same file again continues where it stopped.
      sset(TX_KEY, JSON.stringify({ id: tx.id, name: tx.file.name, total: total, texts: tx.texts, alts: tx.alts }));
      progress();
    }

    // Pieces were cut mid-speech: join with a space unless the piece ended a sentence.
    var join = function (list) {
      return list.filter(Boolean).reduce(function (acc, t) {
        if (!acc) return t;
        var a = acc.trim();
        var ended = /(다|요|죠|까|네)[.?!]?$|[?!]$/.test(a);
        if (!ended) a = a.replace(/\.$/, ""); // the piece was cut mid-sentence
        return a + (ended ? "\n" : " ") + t;
      }, "");
    };
    tx.text = join(tx.texts);
    tx.altText = join(tx.alts);
    tx.done = true;
    tx.prepared = null; // release the decoded audio
    sdel(TX_KEY);
    $("tx-resume").hidden = true;
    return tx.text;
  }

  // Applies the corrections the AI is sure of (sound-alike mishearings it would have ticked by
  // default). Everything else is left for the reader to fix in the finished book.
  async function autoFix(text, settings) {
    try {
      var res = await withRetry(function () {
        return streamCall("/api/fixes", { transcript: text, alt: tx.altText, settings: settings });
      }, 2);
      res.fixes.forEach(function (f) {
        if (!f.checked) return;
        // Short, common words (e.g. "이젠") change only where the AI saw them; longer ones everywhere.
        text = f.heard.length <= 2 ? text.replace(f.heard, function () { return f.meant; }) : text.split(f.heard).join(f.meant);
      });
    } catch (e) {} // optional: the book is written from the text as heard
    return text;
  }

  // ---------- Step 3 → generation ----------

  function settingsFromForm() {
    return {
      subjectName: $("subject").value.trim(),
      interviewer: $("interviewer").value.trim(),
      subjectRole: $("role").value.trim(),
      interviewDate: koreanDate($("date").value),
      interviewPlace: $("place").value.trim(),
      voice: document.querySelector('input[name="voice"]:checked').value,
      terms: $("hint").value.trim(),
      chapters: parseInt($("chapters").value, 10),
    };
  }

  function showError(msg) {
    $("make-error").textContent = msg || "";
    $("make-error").hidden = !msg;
  }

  /** "2026-11-26" from the date picker → "2026년 11월 26일", as it is written in the book. */
  function koreanDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    return m ? m[1] + "년 " + Number(m[2]) + "월 " + Number(m[3]) + "일" : "";
  }

  function saveJob() {
    if (job) sset(JOB_KEY, JSON.stringify(job)); // if storage is full, carry on without the safety copy
  }
  function dropJob() {
    job = null;
    sdel(JOB_KEY);
  }

  async function startGeneration(e) {
    e.preventDefault();
    if (busy) return;
    showError("");
    if (!audioFile) {
      showError("녹음 파일을 골라 주세요.");
      $("audio-file").focus();
      return;
    }

    // Long recordings can crash a phone's browser while decoding.
    if (coarsePointer && !(tx && tx.file === audioFile)) {
      var secs = await AudioChunker.duration(audioFile);
      if (secs && secs > 90 * 60 &&
          !confirm("녹음이 " + formatDuration(secs) + "이에요. 휴대폰에서는 90분이 넘는 녹음을 받아쓰다 멈출 수 있어요. 컴퓨터에서 하시길 권해요. 그래도 계속할까요?")) return;
    }
    var unfinished = sgetJson(JOB_KEY);
    if (unfinished && unfinished.outline && (!job || job.id !== unfinished.id)) {
      if (!confirm("만들다 만 책 《" + unfinished.outline.title + "》이 있어요. 새 책을 만들면 그 책은 사라집니다. 계속할까요?")) return;
    }
    $("resume").hidden = true;

    job = {
      id: Library.newId(),
      transcript: null, // filled in by the run: recording → text
      settings: settingsFromForm(),
      outline: null,
      chapters: [],
    };
    saveJob();
    await runJob();
  }

  // ----- Progress display -----

  function stepItem(label) {
    var li = document.createElement("li");
    li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label"></span><span class="meta"></span>';
    li.querySelector(".label").textContent = label;
    $("make-steps").appendChild(li);
    return {
      set: function (state, meta) {
        li.className = "is-" + state;
        li.querySelector(".meta").textContent = meta || "";
      },
    };
  }

  function renderSteps() {
    $("make-steps").textContent = "";
    steps = {
      transcribe: stepItem("녹음을 글로 옮기기"),
      outline: stepItem(job.outline ? "목차 완성: 《" + job.outline.title + "》" : "이야기의 흐름을 읽고 목차를 짜는 중"),
      chapters: [],
    };
    if (job.transcript) steps.transcribe.set("done");
    if (job.outline) {
      steps.outline.set("done");
      steps.chapters = job.outline.chapters.map(function (c, i) {
        var s = stepItem("제" + (i + 1) + "장 " + c.title);
        if (job.chapters[i]) s.set("done");
        return s;
      });
    }
  }

  var written = function () { return job.chapters.filter(Boolean).length; };

  function updateOverall(status) {
    // Fixed shares of the bar (recording 30%, outline 10%, chapters the rest), so it never goes
    // backwards when the outline turns out to have more chapters than guessed.
    var pct = !job.transcript
      ? Math.round(30 * (job.txFraction || 0))
      : !job.outline
      ? Math.round(30 + 10 * Math.min(0.9, job.outlineStarted ? (Date.now() - job.outlineStarted) / 120000 : 0))
      : Math.round(40 + (60 * written()) / Math.max(1, job.outline.chapters.length));
    $("overall-bar").style.width = pct + "%";
    $("overall-bar").parentNode.setAttribute("aria-valuenow", String(pct));
    if (status) $("overall-status").textContent = status;
    var remaining = job.outline ? job.outline.chapters.length - written() : 0;
    var eta = "";
    if (remaining > 0) {
      // Never let the estimate go up: a growing countdown worries people more than a vague one.
      var left = estimateLeft(remaining);
      job.lastEta = job.lastEta ? Math.min(job.lastEta, left) : left;
      eta = job.lastEta <= 1 ? (remaining <= 1 ? " · 거의 다 됐어요" : " · 1분 안팎 남음") : " · 약 " + job.lastEta + "분 남음";
    }
    $("overall-eta").textContent = eta;
  }

  // Minutes left for the chapters: measured speed once a chapter is done, else ~2 minutes per round.
  function estimateLeft(remaining) {
    var rounds = Math.ceil(remaining / CHAPTER_CONCURRENCY);
    var doneHere = written() - (job.chaptersAtStart || 0);
    var perRound = doneHere > 0 && job.chaptersStarted ? (Date.now() - job.chaptersStarted) / Math.ceil(doneHere / CHAPTER_CONCURRENCY) : 120000;
    return Math.max(1, Math.ceil((rounds * perRound) / 60000));
  }

  // ----- The run -----

  var wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }

  function setBusyUi(on) {
    busy = on;
    $("form-fields").disabled = on;
    var failed = Boolean(job && job.failed);
    $("make-btn").hidden = on || failed;
    $("retry-btn").hidden = $("restart-btn").hidden = on || !failed;
    $("make-progress").hidden = !job;
    dz.classList.toggle("is-disabled", on);
    keepAwake(on);
  }

  async function runJob() {
    var finished = false;
    job.failed = false;
    setBusyUi(true);
    showError("");
    renderSteps();
    $("make-progress").scrollIntoView({ behavior: "smooth", block: "start" });
    var ticker = setInterval(function () { updateOverall(); }, 5000);

    try {
      // 1) Recording → text, with the corrections the AI is sure of
      if (!job.transcript) {
        steps.transcribe.set("active");
        var heard = await transcribeRecording(function (fraction, label) {
          job.txFraction = fraction;
          updateOverall(label);
        });
        updateOverall("잘못 들린 말을 고치는 중");
        job.transcript = await autoFix(heard, job.settings);
        steps.transcribe.set("done");
        saveJob();
      }
      var payload = { transcript: job.transcript, settings: job.settings };

      // 2) Outline
      if (!job.outline) {
        job.outlineStarted = Date.now();
        steps.outline.set("active", "읽는 중");
        updateOverall("목차를 짜고 있어요");
        var res = await withRetry(function () {
          return streamCall("/api/outline", payload, function (ev) {
            if (ev.type === "progress") steps.outline.set("active", "쓰는 중");
          });
        }, 2);
        job.outline = res.outline;
        job.chapters = new Array(job.outline.chapters.length);
        saveJob();
        renderSteps();
      }

      // 3) Chapters not written yet
      var todo = [];
      job.outline.chapters.forEach(function (c, i) { if (!job.chapters[i]) todo.push(i); });
      job.chaptersStarted = Date.now();
      job.chaptersAtStart = written();
      job.lastEta = 0;
      updateOverall("장을 쓰고 있어요");
      var failures = [];
      var next = 0;
      async function lane() {
        while (next < todo.length) {
          var i = todo[next++];
          var step = steps.chapters[i];
          step.set("active", "쓰는 중");
          try {
            var r = await withRetry(function () {
              return streamCall("/api/chapter", Object.assign({ outline: job.outline, index: i }, payload));
            }, 3);
            job.chapters[i] = r.chapter;
            saveJob();
            step.set("done");
            updateOverall("제" + (i + 1) + "장을 마쳤어요");
          } catch (err) {
            failures.push({ i: i, message: err.message });
            step.set("failed", "다시 시도 필요");
          }
        }
      }
      var lanes = [];
      for (var k = 0; k < Math.min(CHAPTER_CONCURRENCY, todo.length); k++) lanes.push(lane());
      await Promise.all(lanes);

      if (failures.length) {
        var kept = written();
        throw new Error(
          failures.map(function (f) { return "제" + (f.i + 1) + "장"; }).join(", ") + "을 쓰지 못했어요. " +
          (kept ? "이미 쓴 " + kept + "개 장은 그대로 있어요. " : "") +
          "‘이어서 쓰기’를 누르면 남은 부분만 다시 씁니다. (" + failures[0].message + ")"
        );
      }

      // 4) Assemble and save
      var book = assemble();
      if (!Library.save(book)) {
        showError("브라우저 저장 공간이 부족합니다. 책을 파일로 내려받습니다.");
        await Library.download(book);
        return;
      }
      updateOverall("완성! 책을 펼칩니다");
      dropJob();
      finished = true;
      busy = false; // the book is saved: opening it must not ask "leave this page?"
      setTimeout(function () { location.href = "/book?id=" + encodeURIComponent(book.id); }, 700);
    } catch (err) {
      job.failed = true;
      if (!job.outline) steps[job.transcript ? "outline" : "transcribe"].set("failed", "다시 시도 필요");
      showError(err.message);
      updateOverall("잠시 멈췄어요");
    } finally {
      clearInterval(ticker);
      saveJob();
      // After success the page is about to open the book: keep the controls hidden.
      if (finished) return;
      setBusyUi(false);
      if (job && job.failed) $("retry-btn").focus();
    }
  }

  function assemble() {
    var o = job.outline;
    return {
      id: job.id,
      createdAt: new Date().toISOString(),
      settings: job.settings,
      kind: o.kind,
      speakerRole: o.speakerRole,
      speaksAs: o.speaksAs,
      title: o.title,
      subtitle: o.subtitle,
      subjectName: o.subjectName || job.settings.subjectName,
      birthYear: o.birthYear,
      birthplace: o.birthplace,
      epigraph: o.epigraph,
      people: o.people,
      prologue: o.prologue,
      chapters: o.chapters.map(function (c, i) {
        var w = job.chapters[i];
        return {
          title: c.title,
          yearFrom: c.yearFrom,
          yearTo: c.yearTo,
          place: c.place,
          summary: c.summary,
          paragraphs: w.paragraphs,
          pullQuote: w.pullQuote,
          excerpt: w.excerpt,
          unverified: w.unverified || [],
          unsupported: w.unsupported || [],
          missing: w.missing || [],
        };
      }),
      frameUnsupported: o.frameUnsupported || [],
      lastWords: o.lastWords,
      timeline: o.timeline,
      epilogue: o.epilogue,
    };
  }

  $("builder").addEventListener("submit", startGeneration);
  $("retry-btn").addEventListener("click", function () { if (job && !busy) runJob(); });
  $("restart-btn").addEventListener("click", function () {
    if (busy) return;
    if (!confirm("지금까지 쓴 내용을 버리고 처음부터 다시 만들까요?")) return;
    dropJob();
    showError("");
    setBusyUi(false); // hides the progress list, now that there is no job
  });

  window.addEventListener("beforeunload", function (e) {
    if (busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- Init ----------

  function restoreSavedWork() {
    var saved = sgetJson(JOB_KEY);
    if (saved && saved.outline) {
      var done = (saved.chapters || []).filter(Boolean).length;
      $("resume-text").textContent = "만들던 책 《" + saved.outline.title + "》이 있어요 (" + done + "/" + saved.outline.chapters.length + "장 완료). 이어서 쓸까요?";
      $("resume").hidden = false;
      $("resume-go").onclick = function () {
        if (busy) return;
        $("resume").hidden = true;
        job = saved;
        job.chapters = job.chapters || [];
        runJob();
      };
      $("resume-drop").onclick = function () {
        $("resume").hidden = true;
        dropJob();
      };
    }
    sdel("chronicle:draft"); // transcripts typed in earlier versions
  }

  // Shown until the right code is entered; the code is then remembered on this device.
  function askAccessCode() {
    var gate = $("gate");
    gate.addEventListener("cancel", function (e) { e.preventDefault(); });
    gate.showModal();
    return new Promise(function (resolve) {
      $("gate-form").addEventListener("submit", async function (e) {
        e.preventDefault();
        var code = $("gate-code").value.trim();
        var btn = e.target.querySelector("button");
        btn.disabled = true;
        var c = null;
        try {
          var res = await fetch("/api/config", { headers: { "x-access-code": encodeURIComponent(code) } });
          if (res.ok) c = await res.json();
        } catch (err) {}
        btn.disabled = false;
        if (c && c.accessOk) {
          accessCode = code;
          sset(ACCESS_KEY, code);
          gate.close();
          resolve(c);
          return;
        }
        $("gate-error").textContent = !c ? "연결할 수 없어요. 다시 시도해 주세요." :
          c.accessLocked ? "여러 번 틀려서 24시간 동안 쓸 수 없어요." : "접근 코드가 올바르지 않아요.";
        $("gate-error").hidden = false;
        $("gate-code").select();
      });
    });
  }

  async function init() {
    renderLibrary();
    try {
      var unfinishedTx = sgetJson(TX_KEY);
      if (unfinishedTx && unfinishedTx.texts) {
        var n = unfinishedTx.texts.filter(function (t) { return t != null; }).length;
        $("tx-resume").textContent = "‘" + unfinishedTx.name + "’ 받아쓰기가 " + n + "/" + unfinishedTx.total + "에서 멈췄어요. 같은 파일을 고르면 이어서 받아씁니다.";
        $("tx-resume").hidden = false;
      }
    } catch (e) {}
    restoreSavedWork();

    try {
      var res = await fetch("/api/config", { headers: headers() });
      if (!res.ok) throw new Error();
      config = await res.json();
    } catch (e) {
      config = { accessCodeRequired: false, transcription: false, writing: false };
      showNotice(["지금은 책 만들기 기능에 연결할 수 없어요."]);
      console.warn("API not reachable: deploy with server functions (e.g. Vercel).");
    }
    if (config.accessOk === false) config = await askAccessCode();
    var problems = [];
    if (!config.transcription) {
      problems.push("지금은 녹음 받아쓰기를 쓸 수 없어요.");
      console.warn("Transcription disabled: set OPENROUTER_API_KEY or GROQ_API_KEY.");
    }
    if (!config.writing) {
      problems.push("지금은 책 쓰기 기능을 쓸 수 없어요.");
      console.warn("Writing disabled: set NOUS_API_KEY or OPENROUTER_API_KEY.");
    }
    if (config.mock) console.warn("MOCK_AI is on: transcripts and books are samples, not real AI output.");
    if (problems.length && $("notice").hidden) showNotice(problems);
    $("make-btn").disabled = !config.writing || !config.transcription;
  }

  init();
})();
