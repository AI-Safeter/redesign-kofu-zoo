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

  var THEME_KEY = "chronicle:theme";
  var SIZE_KEY = "chronicle:size";
  var SIZES = ["s", "m", "l", "xl"];
  var SIZE_NAMES = { s: "작게", m: "보통", l: "크게", xl: "아주 크게" };

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
  }

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
      .replace(/"([^"\n]*)"/g, "“$1”")
      .replace(/[「『]([^」』\n]*)[」』]/g, "“$1”")
      .replace(/(^|[\s(\[“])'([^'\n]*)'/g, "$1‘$2’");
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
    var age = function (n) { return n === 0 ? "출생" : n + "세"; };
    if (a != null && b != null && a !== b) return (a === 0 ? "출생" : a) + "–" + b + "세";
    return age(a != null ? a : b);
  }
  function chapterLabel(i) {
    return "제" + (i + 1) + "장";
  }

  // ---------- Pages ----------

  function coverPage(book) {
    var created = refYear(book);
    var work = book.kind === "work";
    var teller = book.subjectName ? "이야기한 사람 · " + book.subjectName : book.speakerRole || "";
    var origin = [book.birthYear ? book.birthYear + "년" : "", book.birthplace || book.born || ""].filter(Boolean).join(" ");
    return {
      kind: "cover",
      label: "표지",
      node: el("div", { className: "cover" }, [
        el("div", { className: "cover__top" }, [
          book.sample ? el("p", { className: "cover__badge", text: "샘플 · 가상의 인물" }) : null,
          el("p", { className: "cover__kicker", text: work ? "인터뷰 기록" : book.kind === "mixed" ? "한 사람의 삶과 일" : "한 사람의 생애 기록" }),
        ]),
        el("div", { className: "cover__main" }, [
          txt("h1", "cover__title", book.title, "title"),
          book.subtitle ? txt("p", "cover__subtitle", book.subtitle, "subtitle") : null,
        ]),
        el("div", { className: "cover__bottom" }, [
          teller ? el("p", { className: "cover__teller", text: teller }) : null,
          book.subjectName && book.speakerRole ? el("p", { className: "cover__origin", text: book.speakerRole }) : null,
          origin ? el("p", { className: "cover__origin", text: origin + " 출생" }) : null,
          el("p", { className: "cover__imprint", text: (book.kind === "life" || !book.kind ? "가족이 엮은 책 · " : "엮은 해 · ") + created }),
        ]),
      ]),
    };
  }

  function contentsPage(book, layout) {
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

  // Sentences in the preface/epilogue the interview doesn't support, shown only while editing.
  function frameNote(book) {
    var list = book.frameUnsupported || [];
    if (!list.length) return null;
    return el("div", { className: "verify-note", role: "note" }, [
      el("p", { text: "녹취록에 근거가 약한 문장입니다. 사실인지 확인하고 아니면 고쳐 주세요:" }),
      el("ul", null, list.map(function (u) { return el("li", { text: u }); })),
    ]);
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
    var q = c.pullQuote && c.pullQuote.text ? c.pullQuote : null;
    if (q && c.excerpt && c.excerpt.a && norm(c.excerpt.a).indexOf(norm(q.text).slice(0, 20)) >= 0) q = null;

    // Put the pull quote one paragraph after the passage it echoes; if the words are not in
    // the text, it opens the chapter instead.
    var quoteAfter = -1;
    var quoteOpens = false;
    if (q) {
      var nq = norm(q.text).slice(0, 24);
      for (var j = 0; j < paras.length; j++) {
        if (nq && norm(paras[j]).indexOf(nq) >= 0) {
          quoteAfter = Math.min(j + 1, paras.length - 1);
          break;
        }
      }
      if (quoteAfter < 0) quoteOpens = true;
      // In 구술 정리 the body already is the speaker's words: don't print them twice.
      if (quoteAfter >= 0 && book.settings && book.settings.voice === "oral") {
        q = null;
        quoteAfter = -1;
      }
    }

    var body = el("div", { className: "prose" });
    paras.forEach(function (p, j) {
      body.appendChild(txt("p", j === 0 ? "lead" : null, p, "chapters." + i + ".paragraphs." + j));
      if (q && j === quoteAfter && j < paras.length - 1) body.appendChild(pullQuote(q, i));
    });
    if (q && quoteAfter === paras.length - 1 && paras.length > 0) body.appendChild(pullQuote(q, i));

    var meta = [yearsOf(c), agesOf(book, c), c.place].filter(Boolean);
    var head = el("header", { className: "chapter__head" }, [
      el("p", { className: "chapter__num", "aria-hidden": "true", text: String(i + 1) }),
      el("p", { className: "chapter__label", text: chapterLabel(i) }),
      txt("h2", "chapter__title", c.title, "chapters." + i + ".title"),
      meta.length ? el("p", { className: "chapter__meta", text: meta.join("  ·  ") }) : null,
    ]);

    var exA = c.excerpt && c.excerpt.a ? norm(c.excerpt.a) : "";
    var excerptRepeats = exA && paras.some(function (p) { return norm(p).indexOf(exA.slice(0, 24)) >= 0; });
    var excerptComplete = c.excerpt && /[.?!。요다죠까”"]\s*$/.test(c.excerpt.a || "");
    var excerpt =
      c.excerpt && c.excerpt.a && !excerptRepeats && excerptComplete
        ? el("aside", { className: "excerpt", "aria-label": "인터뷰에서" }, [
            el("p", { className: "excerpt__label", text: "인터뷰에서" }),
            c.excerpt.q ? txt("p", "excerpt__q", c.excerpt.q, "chapters." + i + ".excerpt.q") : null,
            txt("p", "excerpt__a", c.excerpt.a, "chapters." + i + ".excerpt.a"),
          ])
        : null;

    var unv = c.unverified || [];
    var uns = c.unsupported || [];
    var mis = c.missing || [];
    var check =
      unv.length || uns.length || mis.length
        ? el("div", { className: "verify-note", role: "note" }, [
            unv.length ? el("p", { text: "녹취록에서 찾지 못한 인용입니다. 실제로 하신 말씀인지 확인해 주세요:" }) : null,
            unv.length ? el("ul", null, unv.map(function (u) { return el("li", { text: "“" + u + "”" }); })) : null,
            uns.length ? el("p", { text: "녹취록에 근거가 약한 서술입니다. 사실인지 확인하고 아니면 고쳐 주세요:" }) : null,
            uns.length ? el("ul", null, uns.map(function (u) { return el("li", { text: u }); })) : null,
            mis.length ? el("p", { text: "녹음에서 이 장에 해당하는 말 가운데 책에 빠진 부분입니다. 필요하면 넣어 주세요:" }) : null,
            mis.length ? el("ul", null, mis.map(function (u) { return el("li", { text: u }); })) : null,
          ])
        : null;

    return {
      kind: "chapter",
      label: chapterLabel(i) + " " + c.title,
      node: el("div", null, [check, head, q && quoteOpens ? pullQuote(q, i, true) : null, body, excerpt]),
    };
  }

  function pullQuote(q, i, opening) {
    return el("figure", { className: "pullquote" + (opening ? " pullquote--opening" : "") }, [
      txt("blockquote", null, q.text, "chapters." + i + ".pullQuote.text"),
      q.context ? txt("figcaption", null, q.context, "chapters." + i + ".pullQuote.context") : null,
    ]);
  }

  function keyTermsPage(book) {
    var dl = el("dl", { className: "terms" });
    book.keyTerms.forEach(function (k, i) {
      dl.appendChild(txt("dt", null, k.term, "keyTerms." + i + ".term"));
      dl.appendChild(txt("dd", null, k.note, "keyTerms." + i + ".note"));
    });
    return {
      kind: "terms",
      label: "한눈에 보기",
      node: el("div", null, [el("h2", { className: "page__heading", text: "한눈에 보기" }), dl]),
    };
  }

  function lastWordsTitle(book) {
    return book.kind === "work" ? "맺는 말" : "남기고 싶은 말";
  }

  function lastWordsPage(book) {
    var letter = el("div", { className: "letter" }, [
      prose(book.lastWords, "lastWords"),
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
      var chapterEntry = k ? layout.filter(function (e) { return e.chapter === k - 1; })[0] : null;
      wrap.appendChild(
        k && chapterEntry
          ? el("h3", { className: "timeline__group" }, [
              el("a", { href: "#" + (chapterEntry.index + 1), "data-goto": chapterEntry.index }, [
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
        var age = born && n ? (n - born === 0 ? "출생" : n - born + "세") : "";
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
      node: el("div", null, [el("h2", { className: "page__heading", text: "연보" }), wrap]),
    };
  }

  function epiloguePage(book) {
    var s = book.settings || {};
    var m = book.meta || {};
    var rows = [
      ["이야기한 사람", [book.subjectName, book.birthYear ? book.birthYear + "년생" : ""].filter(Boolean).join(", ")],
      ["들은 사람", s.interviewer],
      ["인터뷰", [s.interviewDate, s.interviewPlace].filter(Boolean).join(", ")],
      ["녹음", m.audioSeconds ? Math.round(m.audioSeconds / 60) + "분" : ""],
      ["녹취록", m.transcriptChars ? m.transcriptChars.toLocaleString("ko-KR") + "자" : ""],
      ["만든 날", book.createdAt && !m.origin ? new Date(book.createdAt).toLocaleDateString("ko-KR") : ""],
      ["글쓴 AI", (m.models || []).map(modelName).join(", ")],
    ].filter(function (r) { return r[1]; });

    var dl = el("dl", { className: "colophon__facts" });
    rows.forEach(function (r) {
      dl.appendChild(el("dt", { text: r[0] }));
      dl.appendChild(el("dd", { text: r[1] }));
    });

    var colophon = el("footer", { className: "colophon" }, [
      txt("p", "colophon__title", book.title, null),
      dl,
      // How the book was made: the sample says so itself; generated books get the standard line.
      el("p", { text: m.origin || "인터뷰 녹음을 글로 옮긴 뒤 AI가 초안을 썼습니다. 인용은 녹취록과 대조했지만, 받아쓰기 오류가 남아 있을 수 있습니다." }),
      (book.timeline || []).some(function (t) { return t.approx; }) ? el("p", { text: "‘무렵’이 붙은 연도는 기억에 기댄 어림입니다." }) : null,
    ]);
    colophon.firstChild.removeAttribute("data-path");

    return {
      kind: "epilogue",
      label: "에필로그",
      node: el("div", null, [el("h2", { className: "page__heading", text: "에필로그" }), prose(book.epilogue, "epilogue"), colophon]),
    };
  }

  // "nvidia/nemotron-3-ultra-550b-a55b:free" → "Nemotron 3 Ultra (무료)"
  function modelName(id) {
    var known = { claude: "Claude", nemotron: "NVIDIA Nemotron", ernie: "Baidu ERNIE", gemma: "Google Gemma", mock: "시험 모드" };
    var base = String(id).split("/").pop();
    var free = /:free$/.test(base);
    base = base.replace(/:free$/, "");
    var key = Object.keys(known).filter(function (k) { return base.indexOf(k) === 0; })[0];
    var name = key ? known[key] : base;
    return name + (free ? " (무료 모델)" : "");
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
    if (book.keyTerms && book.keyTerms.length) push({ kind: "terms", toc: true, label: "한눈에 보기" });
    if (book.lastWords && book.lastWords.length) push({ kind: "lastwords", toc: true, label: lastWordsTitle(book) });
    var dated = (book.timeline || []).some(function (t) { return t.year || t.when; });
    if (dated) push({ kind: "timeline", toc: true, label: "연보" });
    push({ kind: "epilogue", toc: true, label: "에필로그" });

    return layout.map(function (e) {
      switch (e.kind) {
        case "cover": return coverPage(book);
        case "contents": return contentsPage(book, layout);
        case "people": return peoplePage(book);
        case "prologue": return prologuePage(book);
        case "chapter": return chapterPage(book, book.chapters[e.chapter], e.chapter);
        case "terms": return keyTermsPage(book);
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
    applyTheme(store(THEME_KEY));
    applySize(store(SIZE_KEY) || "m");

    // ----- Top bar: home, title, contents, view settings -----
    var viewBtn = button("보기 설정", "글자 크기, 밤 모드, 저장과 인쇄", null);
    viewBtn.setAttribute("aria-expanded", "false");
    viewBtn.setAttribute("aria-controls", "reader-panel");
    var top = el("header", { className: "reader__top" }, [
      options.homeHref
        ? el("a", { className: "reader__home", href: options.homeHref, text: "← 서재" })
        : el("span", { className: "reader__home" }),
      el("p", { className: "reader__title", text: book.title || "" }),
      el("div", { className: "reader__actions" }, [
        button("차례", "차례로 가기", function () { go(1, true); }),
        viewBtn,
      ]),
    ]);

    // ----- View settings panel -----
    var sizeDown = button("가−", "글자 작게", function () { stepSize(-1); });
    var sizeUp = button("가+", "글자 크게", function () { stepSize(1); });
    var sizeNow = el("span", { className: "panel__value", "aria-live": "polite" });
    var dayBtn = button("낮", "밝은 화면", function () { setTheme("light"); });
    var nightBtn = button("밤", "어두운 화면", function () { setTheme("dark"); });
    var panelRows = [
      el("div", { className: "panel__row" }, [el("span", { className: "panel__label", text: "글자 크기" }), sizeDown, sizeNow, sizeUp]),
      el("div", { className: "panel__row" }, [el("span", { className: "panel__label", text: "화면" }), dayBtn, nightBtn]),
    ];
    var actionRow = el("div", { className: "panel__row panel__row--actions" });
    var editBtn;
    if (options.onChange) {
      editBtn = button("글 고치기", "본문을 직접 고칩니다", function () {
        setEditing(!editing);
        closePanel();
      });
      actionRow.appendChild(editBtn);
    }
    (options.extraActions || []).forEach(function (a) {
      actionRow.appendChild(button(a.label, a.title, a.onClick));
    });
    if (!options.noPrint) {
      actionRow.appendChild(button("인쇄 · PDF", "인쇄하거나 PDF로 저장", function () {
        closePanel();
        window.print();
      }));
    }
    if (actionRow.childNodes.length) panelRows.push(actionRow);
    var panel = el("div", { className: "reader__panel", id: "reader-panel", role: "dialog", "aria-label": "보기 설정", hidden: "hidden" }, panelRows);
    viewBtn.addEventListener("click", function () {
      panel.hidden ? openPanel() : closePanel();
    });
    function openPanel() {
      panel.hidden = false;
      viewBtn.setAttribute("aria-expanded", "true");
      var first = panel.querySelector("button:not([disabled])");
      if (first) first.focus();
    }
    function closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      viewBtn.setAttribute("aria-expanded", "false");
    }
    document.addEventListener("click", function (e) {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== viewBtn) closePanel();
    });

    function stepSize(d) {
      var now = document.documentElement.getAttribute("data-size") || "m";
      var next = SIZES[Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(now) + d))];
      applySize(next);
      store(SIZE_KEY, next);
      syncPanel();
    }
    function setTheme(t) {
      applyTheme(t);
      store(THEME_KEY, t);
      syncPanel();
    }
    function syncPanel() {
      var size = document.documentElement.getAttribute("data-size") || "m";
      sizeNow.textContent = SIZE_NAMES[size];
      sizeDown.disabled = size === SIZES[0];
      sizeUp.disabled = size === SIZES[SIZES.length - 1];
      var dark = isDark();
      dayBtn.setAttribute("aria-pressed", dark ? "false" : "true");
      nightBtn.setAttribute("aria-pressed", dark ? "true" : "false");
    }

    var editNote = el("div", { className: "reader__editnote", role: "status", hidden: "hidden" }, [
      el("span", { text: "글 고치는 중입니다. 고칠 글자를 눌러 바로 고치세요. 자동으로 저장됩니다." }),
    ]);
    var doneBtn = button("고치기 끝", "고치기를 마칩니다", function () { setEditing(false); });
    editNote.appendChild(doneBtn);

    // ----- Pages -----
    var stage = el("main", { className: "reader__stage" });
    pages.forEach(function (p, i) {
      var section = el("section", {
        className: "page page--" + p.kind,
        id: "page-" + (i + 1),
        "aria-label": p.label,
        "data-index": i,
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
    [top, panel, editNote, bar, stage, bottom].forEach(function (n) { root.appendChild(n); });

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
      var n = parseInt((location.hash || "").replace(/^#(page-)?/, ""), 10);
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
        if (!panel.hidden) {
          closePanel();
          viewBtn.focus();
        } else if (editing) setEditing(false);
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
      var path = e.target.getAttribute && e.target.getAttribute("data-path");
      if (!path) return;
      setPath(book, path, e.target.textContent.trim());
      if (path === "title") top.querySelector(".reader__title").textContent = book.title;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { options.onChange(book); }, 400);
    });
    stage.addEventListener("paste", function (e) {
      if (!editing) return;
      e.preventDefault(); // paste as plain text only
      var text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
    });

    function setEditing(on) {
      editing = on;
      root.classList.toggle("is-editing", on);
      editNote.hidden = !on;
      if (editBtn) editBtn.textContent = on ? "고치기 끝" : "글 고치기";
      stage.querySelectorAll("[data-path]").forEach(function (n) {
        if (on) n.setAttribute("contenteditable", "plaintext-only");
        else n.removeAttribute("contenteditable");
      });
      if (!on && options.onChange) {
        clearTimeout(saveTimer);
        options.onChange(book);
      }
    }

    syncPanel();
    go(fromHash(), false);
    return { go: go, book: book };
  }

  function button(label, title, onClick) {
    var b = el("button", { type: "button", className: "btn", title: title, text: label });
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function isDark() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
  }
  function applySize(size) {
    document.documentElement.setAttribute("data-size", SIZES.indexOf(size) >= 0 ? size : "m");
  }

  window.ChronicleBook = { mount: mount };
})();
