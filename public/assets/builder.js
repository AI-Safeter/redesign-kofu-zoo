/*
 * Builder page: audio → transcript (reviewed by the user) → outline → chapters → saved book.
 * A book in progress is saved after every step, so a reload or a failed chapter never
 * throws away work that is already done.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var DRAFT_KEY = "chronicle:draft";
  var JOB_KEY = "chronicle:job";
  var ACCESS_KEY = "chronicle:access";
  var CHAPTER_CONCURRENCY = 3;
  // Pieces are transcribed one at a time: each gets the previous piece's text as context.

  var config = { accessCodeRequired: false, transcription: true, writing: true };
  var audioFile = null;
  var busy = false;
  var tx = null; // the current transcription: { file, prepared, texts }
  var job = null; // the current book: { id, transcript, settings, outline, chapters, models, startedAt }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- Small helpers ----------

  function sget(store, key) { try { return store.getItem(key); } catch (e) { return null; } }
  function sset(store, key, v) { try { store.setItem(key, v); return true; } catch (e) { return false; } }
  function sdel(store, key) { try { store.removeItem(key); } catch (e) {} }

  function headers(extra) {
    var h = Object.assign({}, extra || {});
    var code = $("access").value.trim();
    if (code) h["x-access-code"] = encodeURIComponent(code); // header values must be ASCII
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
    if (!sec && sec !== 0) return "";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
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

  /**
   * Runs `worker(item, index)` over items with limited parallelism. After the first
   * failure no new items start; items already running finish. Rejects with that failure.
   */
  async function pool(items, limit, worker) {
    var next = 0;
    var failure = null;
    async function lane() {
      while (next < items.length && !failure) {
        var i = next++;
        try {
          await worker(items[i], i);
        } catch (e) {
          failure = failure || e;
        }
      }
    }
    var lanes = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) lanes.push(lane());
    await Promise.all(lanes);
    if (failure) throw failure;
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

      var actions = document.createElement("div");
      actions.className = "library__actions";
      var dl = document.createElement("button");
      dl.type = "button";
      dl.className = "btn";
      dl.textContent = "파일로 저장";
      dl.addEventListener("click", function () {
        var book = Library.get(b.id);
        if (book) Library.download(book).catch(function (e) { showNotice([e.message]); });
      });
      var del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn--danger";
      del.textContent = "삭제";
      del.setAttribute("aria-label", b.title + " 삭제");
      del.addEventListener("click", function () {
        if (confirm("‘" + b.title + "’ 책을 삭제할까요? 되돌릴 수 없습니다.")) {
          Library.remove(b.id);
          renderLibrary();
        }
      });
      actions.append(dl, del);
      li.append(a, actions);
      ul.appendChild(li);
    });
  }

  // ---------- Step 1: audio ----------

  function setFile(file) {
    if (!file) return;
    if (busy) {
      $("file-info").textContent = "받아쓰기가 끝난 뒤에 다른 파일을 고를 수 있어요.";
      $("file-info").hidden = false;
      return;
    }
    audioFile = file;
    tx = null;
    var mb = (file.size / 1024 / 1024).toFixed(1);
    $("file-info").textContent = "선택한 파일: " + file.name + " (" + mb + "MB)";
    $("file-info").hidden = false;
    $("transcribe-progress").hidden = true;
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
  if (window.matchMedia && matchMedia("(pointer: coarse)").matches) {
    $("dropzone-main").textContent = "눌러서 녹음 파일 고르기";
  }

  function setTranscribeProgress(fraction, label, isError) {
    var box = $("transcribe-progress");
    box.hidden = false;
    box.classList.toggle("is-error", !!isError);
    var bar = box.querySelector(".progress__bar");
    bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    bar.querySelector("span").style.width = Math.round(fraction * 100) + "%";
    box.querySelector(".progress__label").textContent = label;
  }

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
        if (data.engine && tx) (tx.engines = tx.engines || {})[data.engine] = true;
        if (tx) (tx.alts = tx.alts || [])[i] = data.alt || "";
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

  async function transcribe() {
    if (!audioFile || busy) return;
    busy = true;
    $("audio-file").disabled = true;
    $("transcribe-btn").disabled = true;
    $("transcribe-retry").hidden = true;
    $("make-btn").disabled = true;
    try {
      if (!tx || tx.file !== audioFile) {
        setTranscribeProgress(0.02, "녹음 파일을 준비하는 중… (긴 녹음은 1분 정도 걸릴 수 있어요)");
        tx = { file: audioFile, prepared: await AudioChunker.prepare(audioFile), texts: [] };
      }
      var chunks = tx.prepared.chunks;
      var hint = $("hint").value.trim();
      var lengthNote = tx.prepared.duration ? " · 녹음 길이 " + formatDuration(tx.prepared.duration) : "";
      var done = tx.texts.filter(function (t) { return t != null; }).length;
      var todo = [];
      chunks.forEach(function (c, i) { if (tx.texts[i] == null) todo.push(i); });
      var progress = function (extra) {
        setTranscribeProgress(0.05 + 0.95 * (done / chunks.length), (extra || "음성을 글로 옮기는 중… ") + done + "/" + chunks.length + lengthNote);
      };
      progress();

      // One piece at a time, so each piece gets the end of the previous one as context.
      await pool(todo, 1, async function (i) {
        tx.texts[i] = await transcribeChunk(chunks[i], i, hint, function (sec) {
          progress("사용량 한도로 " + sec + "초 기다리는 중… ");
        }, i > 0 ? tx.texts[i - 1] : "");
        done++;
        progress();
      });

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
      var text = join(tx.texts);
      tx.altText = tx.alts ? join(tx.alts) : "";
      setTranscribeProgress(1, "받아쓰기 완료 · " + text.length.toLocaleString() + "자. 아래 2단계에서 확인해 주세요.");
      tx.done = true; // before delivering: proofreading starts right away and needs the second transcription
      tx.prepared = { duration: tx.prepared.duration, chunks: [] }; // release the decoded audio
      deliverTranscript(text);
    } catch (e) {
      var got = tx ? tx.texts.filter(function (t) { return t != null; }).length : 0;
      setTranscribeProgress(0, "받아쓰기를 마치지 못했습니다: " + e.message + (got ? " (" + got + "개 부분은 받아 두었어요)" : ""), true);
      $("transcribe-retry").hidden = !tx;
    } finally {
      busy = false;
      $("audio-file").disabled = false;
      $("transcribe-btn").disabled = !audioFile || !config.transcription;
      $("make-btn").disabled = !config.writing;
    }
  }
  $("transcribe-btn").addEventListener("click", transcribe);
  $("transcribe-retry").addEventListener("click", transcribe);

  // ---------- Step 2: transcript ----------

  var pendingText = null;
  function deliverTranscript(text) {
    var box = $("transcript");
    if (box.value.trim()) {
      pendingText = text;
      $("merge-choice").hidden = false;
      $("merge-choice").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    box.value = text;
    afterTranscript();
  }
  function afterTranscript() {
    onTranscriptInput();
    $("merge-choice").hidden = true;
    $("step2-title").scrollIntoView({ behavior: "smooth", block: "start" });
    if (config.writing) findFixes();
  }

  // ----- AI proofreading: suggestions the user accepts one by one -----

  var fixesBusy = false;
  async function findFixes() {
    var transcript = $("transcript").value.trim();
    if (fixesBusy) return;
    if (transcript.length < 200) {
      $("fixes-status").textContent = "녹취록이 200자 이상이어야 찾을 수 있어요.";
      return;
    }
    fixesBusy = true;
    forgetUndo();
    $("fixes-find").disabled = true;
    $("fixes-list").textContent = "";
    $("fixes-apply").hidden = true;
    $("fixes-status").textContent = "AI가 녹취록을 읽으며 잘못 들린 말을 찾는 중… (1분 안팎)";
    try {
      var res = await withRetry(function () {
        return streamCall("/api/fixes", {
          transcript: transcript,
          alt: tx && tx.altText && tx.done ? tx.altText : "",
          settings: settingsFromForm(),
        });
      }, 2);
      renderFixes(res.fixes || []);
    } catch (e) {
      $("fixes-status").textContent = "찾지 못했어요: " + e.message + " 직접 훑어보고 고쳐도 됩니다.";
    } finally {
      fixesBusy = false;
      $("fixes-find").disabled = false;
    }
  }

  function renderFixes(fixes) {
    var list = $("fixes-list");
    list.textContent = "";
    var current = $("transcript").value;
    fixes = fixes.filter(function (f) { return current.indexOf(f.heard) >= 0; });
    if (!fixes.length) {
      $("fixes-status").textContent = "AI가 확실히 잘못 들린 말을 찾지 못했어요. 그래도 이름과 숫자는 한 번 훑어봐 주세요.";
      return;
    }
    var places = fixes.reduce(function (n, f) { return n + (f.heard.length <= 2 ? 1 : current.split(f.heard).length - 1); }, 0);
    $("fixes-status").textContent = "고칠 만한 말 " + fixes.length + "개(모두 " + places + "곳)를 찾았어요. AI가 확실하다고 본 것만 미리 체크해 두었어요. 녹음을 떠올리며 맞는 것만 체크하고 ‘체크한 것 고치기’를 누르세요.";
    fixes.forEach(function (f, i) {
      var li = document.createElement("li");
      var label = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      var unknown = f.meant === "?";
      box.checked = f.checked !== false && !unknown;
      box.disabled = unknown;
      box.dataset.heard = f.heard;
      // Short, common words (e.g. "이젠") change only at the place shown, not everywhere.
      box.dataset.at = f.heard.length <= 2 ? String(current.indexOf(f.heard)) : "";
      box.dataset.meant = f.meant;
      var change = document.createElement("span");
      change.className = "fixes__change";
      var del = document.createElement("del");
      del.textContent = f.heard;
      var ins = document.createElement("ins");
      ins.textContent = unknown ? "? (녹음을 듣고 직접 고쳐 주세요)" : f.meant;
      change.append(del, " → ", ins);
      var count = f.heard.length <= 2 ? 1 : current.split(f.heard).length - 1;
      var at = current.indexOf(f.heard);
      var ctx = document.createElement("span");
      ctx.className = "fixes__why";
      var mark = document.createElement("mark");
      mark.textContent = f.heard;
      ctx.append(
        "…" + current.slice(Math.max(0, at - 18), at).replace(/\s+/g, " "),
        mark,
        current.slice(at + f.heard.length, at + f.heard.length + 18).replace(/\s+/g, " ") + "…" + (count > 1 ? " (" + count + "곳)" : "")
      );
      var why = document.createElement("span");
      why.className = "fixes__why";
      why.textContent = (f.kind === "number" ? "숫자 · 꼭 확인 — " : f.kind === "term" ? "이름·용어 — " : "") + f.why;
      box.addEventListener("change", syncApply);
      label.append(box, change, ctx, why);
      li.appendChild(label);
      list.appendChild(li);
    });
    $("fixes-apply").hidden = false;
    syncApply();
  }

  function syncApply() {
    var any = $("fixes-list").querySelectorAll("input:checked:not(:disabled)").length > 0;
    $("fixes-apply").disabled = !any;
  }

  $("fixes-find").addEventListener("click", findFixes);
  // Undo restores the transcript as it was before the last "고치기", and re-enables only that
  // batch's items. Any later change to the transcript ends the chance to undo.
  var beforeFixes = null;
  var lastBatch = [];
  function forgetUndo() {
    beforeFixes = null;
    lastBatch = [];
    $("fixes-undo").hidden = true;
  }
  $("fixes-apply").addEventListener("click", function () {
    var box = $("transcript");
    beforeFixes = box.value;
    lastBatch = [];
    var applied = 0;
    var words = 0;
    $("fixes-list").querySelectorAll("input:checked:not(:disabled)").forEach(function (c) {
      var heard = c.dataset.heard;
      var at = c.dataset.at ? box.value.indexOf(heard, Math.max(0, parseInt(c.dataset.at, 10) - 40)) : -1;
      if (c.dataset.at && at >= 0) {
        box.value = box.value.slice(0, at) + c.dataset.meant + box.value.slice(at + heard.length);
        applied += 1;
        words++;
      } else if (!c.dataset.at) {
        var n = box.value.split(heard).length - 1;
        if (n) {
          box.value = box.value.split(heard).join(c.dataset.meant);
          applied += n;
          words++;
        }
      }
      // Keep the list visible: applied items are greyed out, unticked ones can still be applied.
      lastBatch.push(c);
      c.disabled = true;
      c.closest("li").classList.add("is-applied");
    });
    onTranscriptInput(true);
    syncApply();
    $("fixes-status").textContent = words + "개 말을 " + applied + "곳에서 고쳤어요. 나머지도 한 번 훑어봐 주세요.";
    $("fixes-undo").hidden = false;
  });
  $("fixes-undo").addEventListener("click", function () {
    if (beforeFixes == null) return;
    $("transcript").value = beforeFixes;
    onTranscriptInput(true);
    lastBatch.forEach(function (c) {
      c.closest("li").classList.remove("is-applied");
      if (c.dataset.meant !== "?") c.disabled = false;
    });
    forgetUndo();
    syncApply();
    $("fixes-status").textContent = "고치기 전으로 되돌렸어요.";
  });
  $("merge-replace").addEventListener("click", function () {
    $("transcript").value = pendingText || "";
    pendingText = null;
    afterTranscript();
  });
  $("merge-append").addEventListener("click", function () {
    $("transcript").value = $("transcript").value.trim() + "\n\n" + (pendingText || "");
    pendingText = null;
    afterTranscript();
  });

  var draftTimer;
  function onTranscriptInput(fromFixes) {
    if (fromFixes !== true) forgetUndo(); // typing, replacing or a new transcript ends undo
    var v = $("transcript").value;
    $("transcript-count").textContent = v.length.toLocaleString() + "자" + (v.length && v.length < 200 ? " · 책을 만들려면 200자 이상 필요해요" : "");
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { sset(localStorage, DRAFT_KEY, v); }, 500);
  }
  $("transcript").addEventListener("input", function () { onTranscriptInput(); });

  $("replace-btn").addEventListener("click", function () {
    var from = $("replace-from").value;
    var to = $("replace-to").value;
    var box = $("transcript");
    if (!from) {
      $("replace-result").textContent = "바꿀 말을 먼저 적어 주세요.";
      return;
    }
    var count = box.value.split(from).length - 1;
    if (!count) {
      $("replace-result").textContent = "‘" + from + "’을(를) 찾지 못했어요.";
      return;
    }
    box.value = box.value.split(from).join(to);
    onTranscriptInput();
    $("replace-result").textContent = "‘" + from + "’ " + count + "곳을 ‘" + to + "’(으)로 바꿨어요.";
    $("replace-from").value = "";
    $("replace-to").value = "";
  });

  // ---------- Step 3 → generation ----------

  function settingsFromForm() {
    return {
      subjectName: $("subject").value.trim(),
      interviewer: $("interviewer").value.trim(),
      subjectRole: $("role").value.trim(),
      interviewDate: $("date").value.trim(),
      interviewPlace: $("place").value.trim(),
      voice: document.querySelector('input[name="voice"]:checked').value,
      terms: $("hint").value.trim(),
      chapters: parseInt($("chapters").value, 10),
      notes: $("notes").value.trim(),
    };
  }

  function showError(msg) {
    $("make-error").textContent = msg || "";
    $("make-error").hidden = !msg;
  }

  function saveJob() {
    if (!job) return;
    var copy = Object.assign({}, job);
    delete copy.steps;
    if (!sset(localStorage, JOB_KEY, JSON.stringify(copy))) {
      // Storage full: keep going without the safety copy.
    }
  }
  function dropJob() {
    job = null;
    sdel(localStorage, JOB_KEY);
  }

  async function startGeneration(e) {
    e.preventDefault();
    if (busy) return;
    showError("");
    var transcript = $("transcript").value.trim();
    if (transcript.length < 200) {
      showError("2단계의 녹취록이 필요합니다. 녹음을 글로 옮기거나 녹취록을 붙여넣어 주세요 (200자 이상).");
      $("transcript").setAttribute("aria-invalid", "true");
      $("transcript").focus();
      return;
    }
    $("transcript").removeAttribute("aria-invalid");
    if (config.accessCodeRequired && !$("access").value.trim()) {
      showError("접근 코드를 입력해 주세요.");
      $("access").focus();
      return;
    }
    sset(sessionStorage, ACCESS_KEY, $("access").value.trim());

    var unfinished = null;
    try { unfinished = JSON.parse(sget(localStorage, JOB_KEY) || "null"); } catch (err) {}
    if (unfinished && unfinished.outline && (!job || job.id !== unfinished.id)) {
      if (!confirm("만들다 만 책 《" + unfinished.outline.title + "》이 있어요. 새 책을 만들면 그 책은 사라집니다. 계속할까요?")) return;
    }
    $("resume").hidden = true;

    job = {
      id: Library.newId(),
      transcript: transcript,
      settings: settingsFromForm(),
      outline: null,
      chapters: [],
      models: [],
      audioSeconds: tx && tx.done && tx.prepared.duration ? Math.round(tx.prepared.duration) : null,
      transcribers: tx && tx.done && tx.engines ? Object.keys(tx.engines) : [],
      startedAt: Date.now(),
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
        li.className = state ? "is-" + state : "";
        if (meta !== undefined) li.querySelector(".meta").textContent = meta;
      },
      label: function (t) { li.querySelector(".label").textContent = t; },
    };
  }

  function renderSteps() {
    $("make-steps").textContent = "";
    job.steps = { outline: stepItem("이야기의 흐름을 읽고 목차를 짜는 중"), chapters: [] };
    if (job.outline) {
      job.steps.outline.set("done", "");
      job.steps.outline.label(
        "목차 완성: 《" + job.outline.title + "》" +
        (job.outline.chapters.length < job.settings.chapters ? " · 녹음 분량에 맞춰 " + job.outline.chapters.length + "장으로 지었어요" : "")
      );
      job.steps.chapters = job.outline.chapters.map(function (c, i) {
        var s = stepItem("제" + (i + 1) + "장 " + c.title);
        if (job.chapters[i]) s.set("done", "");
        return s;
      });
    }
  }

  function updateOverall(status) {
    // The outline is a fixed 20% of the bar and the chapters share the rest, so the bar never
    // goes backwards when the outline turns out to have more chapters than guessed.
    var total = 1 + (job.outline ? job.outline.chapters.length : 3);
    var done = (job.outline ? 1 : 0) + job.chapters.filter(Boolean).length;
    var pct;
    if (!job.outline) {
      pct = Math.round(20 * Math.min(0.9, job.runStarted ? (Date.now() - job.runStarted) / 120000 : 0));
    } else {
      var n = job.outline.chapters.length;
      pct = Math.round(20 + (80 * job.chapters.filter(Boolean).length) / Math.max(1, n));
    }
    $("overall-bar").style.width = pct + "%";
    $("overall-bar").parentNode.setAttribute("aria-valuenow", String(pct));
    if (status) $("overall-status").textContent = status;
    var eta = "";
    if (job.outline && done < total) {
      var left = job.chapters.filter(Boolean).length < job.outline.chapters.length ? estimateLeft() : 0;
      if (left > 0) {
        // Never let the estimate go up: a growing countdown worries people more than a vague one.
        job.lastEta = job.lastEta ? Math.min(job.lastEta, left) : left;
        var remaining = job.outline.chapters.length - job.chapters.filter(Boolean).length;
        eta = job.lastEta <= 1 ? (remaining <= 1 ? " · 거의 다 됐어요" : " · 1분 안팎 남음") : " · 약 " + job.lastEta + "분 남음";
      }
    }
    $("overall-eta").textContent = eta;
  }

  // Minutes left for the chapters: measured speed once a chapter is done, else ~2 minutes per round.
  function estimateLeft() {
    var remaining = job.outline.chapters.length - job.chapters.filter(Boolean).length;
    var rounds = Math.ceil(remaining / CHAPTER_CONCURRENCY);
    var written = job.chapters.filter(Boolean).length - (job.chaptersAtStart || 0);
    var perRound = written > 0 && job.chaptersStarted ? (Date.now() - job.chaptersStarted) / Math.ceil(written / CHAPTER_CONCURRENCY) : 120000;
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
    $("make-btn").hidden = on || (job && job.failed);
    $("make-hint").hidden = on || (job && job.failed);
    $("retry-btn").hidden = on || !(job && job.failed);
    $("restart-btn").hidden = on || !(job && job.failed);
    $("make-progress").hidden = !job;
    keepAwake(on);
  }

  async function runJob() {
    var finished = false;
    job.failed = false;
    setBusyUi(true);
    showError("");
    renderSteps();
    job.runStarted = Date.now();
    job.doneAtStart = (job.outline ? 1 : 0) + job.chapters.filter(Boolean).length;
    $("make-progress").scrollIntoView({ behavior: "smooth", block: "start" });
    var ticker = setInterval(function () { updateOverall(); }, 5000);

    var payload = { transcript: job.transcript, settings: job.settings };
    try {
      // 1) Outline
      if (!job.outline) {
        job.steps.outline.set("active", "읽는 중");
        updateOverall("목차를 짜고 있어요");
        var res = await withRetry(function () {
          return streamCall("/api/outline", payload, function (ev) {
            if (ev.type === "progress") job.steps.outline.set("active", "쓰는 중");
          });
        }, 2);
        job.outline = res.outline;
        if (res.model) job.models.push(res.model);
        job.chapters = new Array(job.outline.chapters.length);
        saveJob();
        renderSteps();
      }

      // 2) Chapters not written yet
      var todo = [];
      job.outline.chapters.forEach(function (c, i) { if (!job.chapters[i]) todo.push(i); });
      job.chaptersStarted = Date.now();
      job.chaptersAtStart = job.chapters.filter(Boolean).length;
      job.lastEta = 0;
      updateOverall("장을 쓰고 있어요");
      var failures = [];
      var next = 0;
      async function lane() {
        while (next < todo.length) {
          var i = todo[next++];
          var step = job.steps.chapters[i];
          step.set("active", "쓰는 중");
          try {
            var r = await withRetry(function () {
              return streamCall("/api/chapter", Object.assign({ outline: job.outline, index: i }, payload));
            }, 3);
            job.chapters[i] = r.chapter;
            if (r.model) job.models.push(r.model);
            saveJob();
            step.set("done", "");
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
        job.failed = true;
        var written = job.chapters.filter(Boolean).length;
        showError(
          failures.map(function (f) { return "제" + (f.i + 1) + "장"; }).join(", ") + "을 쓰지 못했어요. " +
          (written ? "이미 쓴 " + written + "개 장은 그대로 있어요. " : "") +
          "‘이어서 쓰기’를 누르면 남은 부분만 다시 씁니다. (" + failures[0].message + ")"
        );
        updateOverall("잠시 멈췄어요");
        return;
      }

      // 3) Assemble and save
      var book = assemble();
      if (!Library.save(book)) {
        showError("브라우저 저장 공간이 부족합니다. 책을 파일로 내려받습니다.");
        await Library.download(book);
        return;
      }
      if (job.transcript.length < 150000) Library.saveTranscript(book.id, job.transcript);
      sset(localStorage, DRAFT_KEY, "");
      updateOverall("완성! 책을 펼칩니다");
      $("overall-bar").style.width = "100%";
      dropJob();
      finished = true;
      setTimeout(function () { location.href = "/book?id=" + encodeURIComponent(book.id); }, 700);
    } catch (err) {
      job.failed = true;
      if (!job.outline) job.steps.outline.set("failed", "다시 시도 필요");
      showError(err.message);
      updateOverall("잠시 멈췄어요");
    } finally {
      clearInterval(ticker);
      if (job) saveJob();
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
      meta: {
        audioSeconds: job.audioSeconds,
        models: job.models.filter(function (m, i, a) { return m && a.indexOf(m) === i; }),
        transcribers: job.transcribers || [],
      },
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
    $("make-progress").hidden = true;
    showError("");
    setBusyUi(false);
  });

  window.addEventListener("beforeunload", function (e) {
    if (busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- Init ----------

  function restoreSavedWork() {
    var saved = null;
    try { saved = JSON.parse(sget(localStorage, JOB_KEY) || "null"); } catch (e) {}
    if (saved && saved.outline) {
      var done = (saved.chapters || []).filter(Boolean).length;
      $("resume-text").textContent = "만들던 책 《" + saved.outline.title + "》이 있어요 (" + done + "/" + saved.outline.chapters.length + "장 완료). 이어서 쓸까요?";
      $("resume").hidden = false;
      $("resume-go").onclick = function () {
        if (busy) return;
        $("resume").hidden = true;
        job = saved;
        job.chapters = job.chapters || [];
        job.models = job.models || [];
        $("transcript").value = job.transcript;
        onTranscriptInput();
        runJob();
      };
      $("resume-drop").onclick = function () {
        $("resume").hidden = true;
        dropJob();
      };
      return;
    }
    var draft = sget(localStorage, DRAFT_KEY);
    if (draft && draft.trim()) {
      $("resume-text").textContent = "작성 중이던 녹취록(" + draft.length.toLocaleString() + "자)이 있어요. 이어서 할까요?";
      $("resume-go").textContent = "이어서 하기";
      $("resume-drop").textContent = "지우기";
      $("resume").hidden = false;
      $("resume-go").onclick = function () {
        $("resume").hidden = true;
        $("transcript").value = draft;
        onTranscriptInput();
        $("step2-title").scrollIntoView({ behavior: "smooth", block: "start" });
      };
      $("resume-drop").onclick = function () {
        $("resume").hidden = true;
        sdel(localStorage, DRAFT_KEY);
      };
    }
  }

  async function init() {
    renderLibrary();
    restoreSavedWork();
    $("access").value = sget(sessionStorage, ACCESS_KEY) || "";

    try {
      var res = await fetch("/api/config");
      if (!res.ok) throw new Error();
      config = await res.json();
    } catch (e) {
      config = { accessCodeRequired: false, transcription: false, writing: false };
      showNotice(["지금은 책 만들기 기능에 연결할 수 없어요. 샘플 책은 볼 수 있습니다."]);
      console.warn("API not reachable: deploy with server functions (e.g. Vercel).");
    }
    $("access-field").hidden = !config.accessCodeRequired;
    var problems = [];
    if (!config.transcription) {
      problems.push("지금은 녹음 받아쓰기를 쓸 수 없어요. 2단계에 녹취록을 직접 붙여넣어 주세요.");
      console.warn("Transcription disabled: set GROQ_API_KEY (or OPENAI_API_KEY).");
    }
    if (!config.writing) {
      problems.push("지금은 책 쓰기 기능을 쓸 수 없어요.");
      console.warn("Writing disabled: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.");
    }
    if (config.mock) problems.push("시험 모드입니다. 실제 AI 대신 샘플 내용으로 동작합니다.");
    if (problems.length && $("notice").hidden) showNotice(problems);
    $("make-btn").disabled = !config.writing;
  }

  init();
})();
