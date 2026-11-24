/*
 * Life-chronicle e-book renderer.
 * Shared by the web viewer (book.html) and by the standalone .html file a user downloads,
 * so it must not depend on anything outside this file and book.css.
 *
 * ChronicleBook.mount(root, book, options) builds the pages and the reader controls.
 * All book text is inserted with textContent, never as HTML.
 */
(function () {
  "use strict";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs[k] == null || attrs[k] === false) continue;
        if (k === "text") node.textContent = attrs[k];
        else if (k === "className") node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Typographer's quotes: "…" → “…”, 「…」 → “…”, '…' → ‘…’.
  function smart(s) {
    return String(s || "")
      .replace(/(\d)\s?-\s?(\d+\s?(명|회|개|살|세|분|시간|달|주|년|차시|회기))/g, "$1~$2")
      .replace(/(\S)\s+-\s+(\S)/g, "$1: $2")
      .replace(/"([^"\n]*)"/g, "“$1”")
      .replace(/[「『]([^」』\n]*)[」』]/g, "“$1”")
      .replace(/(^|[\s([“])'([^'\n]*)'/g, "$1‘$2’");
  }

  // An editable text node bound to a path inside the book object, e.g. "chapters.0.paragraphs.2".
  function txt(tag, className, value, path) {
    return el(tag, { className: className, text: smart(value), "data-path": path });
  }

  var norm = function (s) {
    return String(s || "").replace(/[^가-힣a-zA-Z0-9]/g, "");
  };

  // ---------- Dates and ages ----------

  function num(y) {
    var n = parseInt(y, 10);
    return n > 1800 && n < 2200 ? n : null;
  }
  var ageText = function (n) { return n === 0 ? "출생" : n + "세"; };
  function refYear(book) {
    var d = new Date(book.createdAt || Date.now());
    return isNaN(d) ? new Date().getFullYear() : d.getFullYear();
  }
  function yearsOf(c) {
    if (c.yearFrom || c.yearTo) {
      var to = c.yearTo === "현재" ? "지금" : c.yearTo;
      return [c.yearFrom, to].filter(Boolean).join("–");
    }
    return c.period || "";
  }
  function agesOf(book, c) {
    var born = num(book.birthYear);
    if (!born) return "";
    var from = num(c.yearFrom);
    var to = c.yearTo === "현재" ? refYear(book) : num(c.yearTo);
    if (from == null && to == null) return "";
    var a = from != null ? Math.max(0, from - born) : null;
    var b = to != null ? Math.max(0, to - born) : null;
    if (a != null && b != null && a !== b) return (a === 0 ? "출생" : a) + "–" + b + "세";
    return ageText(a != null ? a : b);
  }
  function chapterLabel(i) {
    return "제" + (i + 1) + "장";
  }

  // ---------- Pages ----------

  function coverPage(book) {
    return {
      kind: "cover",
      label: "표지",
      node: el("div", { className: "cover" }, [
        el("div", { className: "cover__main" }, [
          txt("h1", "cover__title", book.title, "title"),
          book.subtitle ? txt("p", "cover__subtitle", book.subtitle, "subtitle") : null,
        ]),
      ]),
    };
  }

  function contentsPage(layout) {
    var list = el("ol", { className: "toc" });
    layout.forEach(function (e) {
      if (!e.toc) return;
      list.appendChild(
        el("li", { className: e.chapter != null ? "toc__chapter" : "toc__extra" }, [
          el("a", { href: "#" + (e.index + 1), "data-goto": e.index, className: "toc__link" }, [
            el("span", { className: "toc__num", text: e.chapter != null ? chapterLabel(e.chapter) : "" }),
            el("span", { className: "toc__title" }, [
              el("span", { text: e.label }),
              e.years ? el("span", { className: "toc__years", text: e.years }) : null,
            ]),
            el("span", { className: "toc__page", text: String(e.index + 1) }),
          ]),
        ])
      );
    });
    return {
      kind: "contents",
      label: "차례",
      node: el("div", null, [el("h2", { className: "page__heading", text: "차례" }), list]),
    };
  }

  function peoplePage(book) {
    var list = el("ul", { className: "people" });
    book.people.forEach(function (p, i) {
      list.appendChild(
        el("li", null, [
          txt("span", "people__relation", p.relation, "people." + i + ".relation"),
          el("span", { className: "people__body" }, [
            p.name ? txt("span", "people__name", p.name, "people." + i + ".name") : null,
            p.note ? txt("span", "people__note", p.note, "people." + i + ".note") : null,
          ]),
        ])
      );
    });
    return {
      kind: "people",
      label: "이 책의 사람들",
      node: el("div", null, [el("h2", { className: "page__heading", text: "이 책의 사람들" }), list]),
    };
  }

  function prose(paragraphs, pathPrefix) {
    var body = el("div", { className: "prose" });
    (paragraphs || []).forEach(function (p, i) {
      body.appendChild(txt("p", null, p, pathPrefix + "." + i));
    });
    return body;
  }

  // Lists for the family to check against the recording, shown only while editing:
  // groups of [heading, lines].
  function verifyNote(groups) {
    var nodes = [];
    groups.forEach(function (g) {
      if (g[1] && g[1].length) nodes.push(el("p", { text: g[0] }), el("ul", null, g[1].map(function (u) { return el("li", { text: u }); })));
    });
    return nodes.length ? el("div", { className: "verify-note", role: "note" }, nodes) : null;
  }

  // Sentences in the preface/epilogue the interview doesn't support.
  function frameNote(book) {
    var frame = norm((book.prologue || []).concat(book.epilogue || []).join(" "));
    var list = (book.frameUnsupported || []).filter(function (u) { return frame.indexOf(norm(u).slice(0, 20)) >= 0; });
    return verifyNote([["확인할 문장", list]]);
  }

  function prologuePage(book) {
    var epigraphOk = book.epigraph && norm(book.epigraph) !== norm(book.title) && norm(book.title).indexOf(norm(book.epigraph)) < 0;
    var epigraph = epigraphOk
      ? el("figure", { className: "epigraph" }, [
          txt("blockquote", null, book.epigraph, "epigraph"),
          book.subjectName ? el("figcaption", { text: "— " + book.subjectName }) : null,
        ])
      : null;
    return {
      kind: "prologue",
      label: "책을 펴내며",
      node: el("div", null, [
        frameNote(book),
        el("h2", { className: "page__heading", text: "책을 펴내며" }),
        epigraph,
        prose(book.prologue, "prologue"),
      ]),
    };
  }

  function chapterPage(book, c, i) {
    var paras = c.paragraphs || [];
    var ex = c.excerpt || {};
    var q = c.pullQuote && c.pullQuote.text ? c.pullQuote : null;
    if (q && ex.a && norm(ex.a).indexOf(norm(q.text).slice(0, 20)) >= 0) q = null;

    // 구술 정리: the body already is the speaker's words, so a pull quote would print them twice,
    // and one that doesn't match them is raw transcript.
    if (book.settings && book.settings.voice === "oral") q = null;

    // Put the pull quote one paragraph after the passage it echoes; if the words are not in
    // the text, it opens the chapter instead.
    var quoteAfter = -1;
    if (q) {
      var nq = norm(q.text).slice(0, 24);
      for (var j = 0; j < paras.length; j++) {
        if (nq && norm(paras[j]).indexOf(nq) >= 0) {
          quoteAfter = Math.min(j + 1, paras.length - 1);
          break;
        }
      }
    }

    var body = el("div", { className: "prose" });
    paras.forEach(function (p, j) {
      body.appendChild(txt("p", j === 0 ? "lead" : null, p, "chapters." + i + ".paragraphs." + j));
      if (q && j === quoteAfter) body.appendChild(pullQuote(q, i));
    });

    var meta = [yearsOf(c), agesOf(book, c), c.place].filter(Boolean);
    var head = el("header", { className: "chapter__head" }, [
      el("p", { className: "chapter__num", "aria-hidden": "true", text: String(i + 1) }),
      el("p", { className: "chapter__label", text: chapterLabel(i) }),
      txt("h2", "chapter__title", c.title, "chapters." + i + ".title"),
      meta.length ? el("p", { className: "chapter__meta", text: meta.join("  ·  ") }) : null,
    ]);

    var exA = norm(ex.a);
    var excerptRepeats = exA && paras.some(function (p) { return norm(p).indexOf(exA.slice(0, 24)) >= 0; });
    var excerpt =
      ex.a && !excerptRepeats && /[.?!。요다죠까”"]\s*$/.test(ex.a)
        ? el("aside", { className: "excerpt", "aria-label": "인터뷰에서" }, [
            el("p", { className: "excerpt__label", text: "인터뷰에서" }),
            ex.q ? txt("p", "excerpt__q", ex.q, "chapters." + i + ".excerpt.q") : null,
            txt("p", "excerpt__a", ex.a, "chapters." + i + ".excerpt.a"),
          ])
        : null;

    var check = verifyNote([
      ["확인할 인용", (c.unverified || []).map(function (u) { return "“" + u + "”"; })],
      ["확인할 문장", c.unsupported],
      ["빠진 말", c.missing],
    ]);

    return {
      kind: "chapter",
      label: chapterLabel(i) + " " + c.title,
      node: el("div", null, [check, head, q && quoteAfter < 0 ? pullQuote(q, i, true) : null, body, excerpt]),
    };
  }

  function pullQuote(q, i, opening) {
    return el("figure", { className: "pullquote" + (opening ? " pullquote--opening" : "") }, [
      txt("blockquote", null, q.text, "chapters." + i + ".pullQuote.text"),
      q.context ? txt("figcaption", null, q.context, "chapters." + i + ".pullQuote.context") : null,
    ]);
  }

  function lastWordsTitle(book) {
    return book.kind === "work" ? "맺는 말" : "남기고 싶은 말";
  }

  function lastWordsPage(book) {
    // Skip a line identical to the epigraph, keeping each paragraph's real index so edits are
    // saved to the right place.
    var ep = norm(book.epigraph);
    var body = el("div", { className: "prose" });
    (book.lastWords || []).forEach(function (w, i) {
      if (ep && norm(w) === ep) return;
      body.appendChild(txt("p", null, w, "lastWords." + i));
    });
    var letter = el("div", { className: "letter" }, [
      body,
      book.subjectName ? el("p", { className: "letter__sign", text: "— " + book.subjectName }) : null,
    ]);
    return {
      kind: "lastwords",
      label: lastWordsTitle(book),
      node: el("div", null, [el("h2", { className: "page__heading", text: lastWordsTitle(book) }), letter]),
    };
  }

  function timelinePage(book, layout) {
    var born = num(book.birthYear);
    var groups = {};
    (book.timeline || []).forEach(function (t, i) {
      var key = t.chapter >= 1 && t.chapter <= book.chapters.length ? t.chapter : 0;
      (groups[key] = groups[key] || []).push({ t: t, i: i });
    });
    var wrap = el("div", { className: "timeline" });
    var keys = Object.keys(groups).map(Number).sort(function (a, b) {
      return (a || 99) - (b || 99);
    });
    keys.forEach(function (k) {
      var entry = k && layout.find(function (e) { return e.chapter === k - 1; });
      wrap.appendChild(
        entry
          ? el("h3", { className: "timeline__group" }, [
              el("a", { href: "#" + (entry.index + 1), "data-goto": entry.index }, [
                chapterLabel(k - 1) + " " + book.chapters[k - 1].title,
              ]),
            ])
          : el("h3", { className: "timeline__group", text: keys.length > 1 ? "그 밖의 일" : "" })
      );
      var list = el("ol", { className: "timeline__list" });
      groups[k].forEach(function (g) {
        var t = g.t;
        var y = t.year || t.when || "";
        var n = num(y);
        var age = born && n ? ageText(n - born) : "";
        list.appendChild(
          el("li", null, [
            el("span", { className: "timeline__when" }, [
              el("span", { text: y + (t.approx && n ? " 무렵" : "") }),
              age ? el("span", { className: "timeline__age", text: age }) : null,
            ]),
            txt("span", "timeline__event", t.event, "timeline." + g.i + ".event"),
          ])
        );
      });
      wrap.appendChild(list);
    });
    return {
      kind: "timeline",
      label: "연보",
      node: el("div", null, [
        el("h2", { className: "page__heading", text: "연보" }),
        (book.timeline || []).some(function (t) { return t.approx; })
          ? el("p", { className: "timeline__note", text: "‘무렵’이 붙은 연도는 기억에 기댄 어림입니다." })
          : null,
        wrap,
      ]),
    };
  }

  function epiloguePage(book) {
    return {
      kind: "epilogue",
      label: "에필로그",
      node: el("div", null, [el("h2", { className: "page__heading", text: "에필로그" }), prose(book.epilogue, "epilogue")]),
    };
  }

  function buildPages(book) {
    // First lay out which pages exist, so the contents and timeline can link to them.
    var layout = [];
    var push = function (e) {
      e.index = layout.length;
      layout.push(e);
    };
    push({ kind: "cover" });
    push({ kind: "contents" });
    if (book.people && book.people.length) push({ kind: "people", toc: true, label: "이 책의 사람들" });
    if (book.prologue && book.prologue.length) push({ kind: "prologue", toc: true, label: "책을 펴내며" });
    book.chapters.forEach(function (c, i) {
      push({ kind: "chapter", toc: true, chapter: i, label: c.title, years: yearsOf(c) });
    });
    if (book.lastWords && book.lastWords.length) push({ kind: "lastwords", toc: true, label: lastWordsTitle(book) });
    var dated = (book.timeline || []).some(function (t) { return t.year || t.when; });
    if (dated) push({ kind: "timeline", toc: true, label: "연보" });
    push({ kind: "epilogue", toc: true, label: "에필로그" });

    return layout.map(function (e) {
      switch (e.kind) {
        case "cover": return coverPage(book);
        case "contents": return contentsPage(layout);
        case "people": return peoplePage(book);
        case "prologue": return prologuePage(book);
        case "chapter": return chapterPage(book, book.chapters[e.chapter], e.chapter);
        case "lastwords": return lastWordsPage(book);
        case "timeline": return timelinePage(book, layout);
        default: return epiloguePage(book);
      }
    });
  }

  // ---------- Editing ----------

  function setPath(obj, path, value) {
    var keys = path.split(".");
    var target = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      target = target[keys[i]];
      if (target == null) return;
    }
    target[keys[keys.length - 1]] = value;
  }

  // ---------- Reader ----------

  function mount(root, book, options) {
    options = options || {};
    book.chapters = book.chapters || [];
    var pages = buildPages(book);
    var current = 0;
    var editing = false;

    document.title = (book.title || "인생 이야기") + (book.subtitle ? " — " + book.subtitle : "");

    // ----- Top bar: home, title, and (for the owner) 글 고치기 · 발행하기 -----
    var editBtn = options.onChange ? button("글 고치기", "본문을 직접 고칩니다", function () { setEditing(!editing); }) : null;
    var publishBtn = options.onPublish ? button("발행하기", "읽기 전용 링크를 만듭니다", publish) : null;
    var top = el("header", { className: "reader__top" }, [
      options.homeHref
        ? el("a", { className: "reader__home", href: options.homeHref, text: "← 서재" })
        : el("span", { className: "reader__home" }),
      el("p", { className: "reader__title", text: book.title || "" }),
      el("div", { className: "reader__actions" }, [editBtn, publishBtn]),
    ]);

    // ----- Published link -----
    var linkIn = el("input", { type: "text", readonly: "readonly", "aria-label": "책 링크" });
    var linkStatus = el("span", { className: "reader__replace-done", role: "status" });
    var copyBtn = button("복사", "링크를 복사합니다", function () {
      linkIn.select();
      var done = function () { linkStatus.textContent = "복사됨"; };
      if (navigator.clipboard) navigator.clipboard.writeText(linkIn.value).then(done, function () {});
      else if (document.execCommand("copy")) done();
    });
    var unpublishBtn = options.onUnpublish ? button("발행 취소", "발행한 책을 지웁니다", unpublish) : null;
    var linkBar = options.onPublish ? el("div", { className: "reader__replace", hidden: "hidden" }, [linkIn, copyBtn, unpublishBtn, linkStatus]) : null;
    if (linkBar && options.publishedUrl) {
      linkBar.hidden = false;
      linkIn.value = options.publishedUrl;
    }
    async function publish() {
      if (editing) setEditing(false); // saves what was typed
      publishBtn.disabled = true;
      linkBar.hidden = false;
      linkStatus.textContent = "발행 중";
      try {
        linkIn.value = await options.onPublish(book);
        linkStatus.textContent = "발행됨";
      } catch (e) {
        linkStatus.textContent = e.message;
      } finally {
        publishBtn.disabled = false;
      }
    }
    async function unpublish() {
      if (!confirm("발행한 책을 지울까요?")) return;
      unpublishBtn.disabled = true;
      linkStatus.textContent = "지우는 중";
      try {
        await options.onUnpublish(book);
        linkBar.hidden = true;
        linkIn.value = "";
        linkStatus.textContent = "";
      } catch (e) {
        linkStatus.textContent = e.message;
      } finally {
        unpublishBtn.disabled = false;
      }
    }

    // ----- Replace all (while editing): a misheard name usually appears in many places -----
    var findIn = el("input", { type: "text", placeholder: "찾을 말", "aria-label": "찾을 말" });
    var replaceIn = el("input", { type: "text", placeholder: "바꿀 말", "aria-label": "바꿀 말" });
    var replaceDone = el("span", { className: "reader__replace-done", role: "status" });
    var replaceBar = options.onChange
      ? el("form", { className: "reader__replace", hidden: "hidden" }, [findIn, el("span", { "aria-hidden": "true", text: "→" }), replaceIn, el("button", { type: "submit", className: "btn", text: "모두 바꾸기" }), replaceDone])
      : null;
    if (replaceBar) {
      replaceBar.addEventListener("submit", function (e) {
        e.preventDefault();
        var from = findIn.value;
        if (!from) return;
        var count = 0;
        var seen = {};
        stage.querySelectorAll("[data-path]").forEach(function (n) {
          if (n.textContent.indexOf(from) < 0) return;
          var path = n.getAttribute("data-path");
          if (!seen[path]) count += n.textContent.split(from).length - 1;
          seen[path] = true;
          n.textContent = n.textContent.split(from).join(replaceIn.value);
          setPath(book, path, n.textContent.trim());
        });
        // Fields that are not on any page still feed the saved file's plain-text version.
        ["subjectName", "speakerRole"].forEach(function (k) {
          if (book[k]) book[k] = String(book[k]).split(from).join(replaceIn.value);
        });
        top.querySelector(".reader__title").textContent = book.title || "";
        replaceDone.textContent = count + "곳";
        if (count) options.onChange(book);
      });
    }

    // ----- Pages -----
    var stage = el("main", { className: "reader__stage" });
    pages.forEach(function (p, i) {
      var section = el("section", {
        className: "page page--" + p.kind,
        id: "page-" + (i + 1),
        "aria-label": p.label,
      }, [el("div", { className: "page__inner" }, [p.node, el("p", { className: "page__folio", "aria-hidden": "true", text: i === 0 ? "" : String(i + 1) })])]);
      stage.appendChild(section);
    });

    // ----- Bottom navigation -----
    var prev = button("‹ 이전", "이전 쪽", function () { go(current - 1, true); });
    var next = button("다음 ›", "다음 쪽", function () { go(current + 1, true); });
    var whereLabel = el("span", { className: "reader__where-label" });
    var whereNum = el("span", { className: "reader__where-num" });
    var where = el("p", { className: "reader__where", "aria-live": "polite" }, [whereLabel, whereNum]);
    var bar = el("div", { className: "reader__progress", "aria-hidden": "true" }, [el("span")]);
    var bottom = el("nav", { className: "reader__nav", "aria-label": "쪽 넘기기" }, [prev, where, next]);

    root.textContent = "";
    root.className = "reader";
    [top, replaceBar, linkBar, bar, stage, bottom].forEach(function (n) { if (n) root.appendChild(n); });

    var sections = stage.querySelectorAll(".page");

    function go(i, userAction, push) {
      if (i < 0 || i >= pages.length) return;
      var dir = i >= current ? "fwd" : "back";
      current = i;
      sections.forEach(function (s, k) {
        s.classList.toggle("is-active", k === i);
        s.classList.remove("enter-fwd", "enter-back");
        if (k === i && userAction) s.classList.add("enter-" + dir);
      });
      window.scrollTo(0, 0);
      whereLabel.textContent = pages[i].label;
      whereNum.textContent = i + 1 + " / " + pages.length + "쪽";
      prev.disabled = i === 0;
      next.disabled = i === pages.length - 1;
      bar.firstChild.style.width = ((i + 1) / pages.length) * 100 + "%";
      try {
        if (push) history.pushState(null, "", "#" + (i + 1));
        else history.replaceState(null, "", "#" + (i + 1));
      } catch (e) {}
      if (userAction) {
        // Move keyboard and screen-reader focus to the new page's heading.
        var h = sections[i].querySelector("h1, h2");
        if (h) {
          h.setAttribute("tabindex", "-1");
          h.focus({ preventScroll: true });
        }
      }
    }

    function fromHash() {
      var n = parseInt(location.hash.replace(/^#(page-)?/, ""), 10);
      return n >= 1 && n <= pages.length ? n - 1 : 0;
    }

    stage.addEventListener("click", function (e) {
      var link = e.target.closest("[data-goto]");
      if (link && !editing) {
        e.preventDefault();
        go(parseInt(link.getAttribute("data-goto"), 10), true, true);
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (editing) setEditing(false);
        return;
      }
      if (editing || e.target.isContentEditable || /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") go(current + 1, true);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(current - 1, true);
      else if (e.key === "Home") go(0, true);
      else if (e.key === "End") go(pages.length - 1, true);
    });

    // Swipe to turn pages (ignored while editing or when the swipe is mostly vertical).
    var sx = null, sy = null;
    stage.addEventListener("touchstart", function (e) {
      if (editing) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (sx == null) return;
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(current + (dx < 0 ? 1 : -1), true);
    });

    window.addEventListener("hashchange", function () {
      go(fromHash(), true);
    });

    // ----- Editing -----
    var saveTimer;
    stage.addEventListener("input", function (e) {
      var path = e.target.getAttribute("data-path");
      if (!path) return;
      setPath(book, path, e.target.textContent.trim());
      if (path === "title") top.querySelector(".reader__title").textContent = book.title;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveTimer = null; options.onChange(book); }, 400);
    });
    function flushSave() {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      options.onChange(book);
    }
    window.addEventListener("pagehide", flushSave);
    document.addEventListener("visibilitychange", function () { if (document.hidden) flushSave(); });
    top.querySelector(".reader__home").addEventListener("click", flushSave);
    stage.addEventListener("paste", function (e) {
      if (!editing) return;
      e.preventDefault(); // paste as plain text only
      var text = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
    });

    function setEditing(on) {
      editing = on;
      root.classList.toggle("is-editing", on);
      editBtn.textContent = on ? "고치기 끝" : "글 고치기";
      replaceBar.hidden = !on;
      replaceDone.textContent = "";
      stage.querySelectorAll("[data-path]").forEach(function (n) {
        if (on) n.setAttribute("contenteditable", "plaintext-only");
        else n.removeAttribute("contenteditable");
      });
      if (!on) {
        clearTimeout(saveTimer);
        options.onChange(book);
      }
    }

    go(fromHash(), false);
  }

  function button(label, title, onClick) {
    var b = el("button", { type: "button", className: "btn", title: title, text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  window.ChronicleBook = { mount: mount };
})();
