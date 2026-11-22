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

  // An editable text node bound to a path inside the book object, e.g. "chapters.0.paragraphs.2".
  function txt(tag, className, value, path) {
    return el(tag, { className: className, text: value || "", "data-path": path });
  }

  function chapterLabel(i) {
    return "제" + (i + 1) + "장";
  }

  // ---------- Pages ----------

  function coverPage(book) {
    var inner = el("div", { className: "cover" }, [
      book.sample ? el("p", { className: "cover__badge", text: "샘플 · 가상의 인물" }) : null,
      el("div", { className: "cover__ornament", "aria-hidden": "true" }),
      txt("h1", "cover__title", book.title, "title"),
      txt("p", "cover__subtitle", book.subtitle, "subtitle"),
      el("div", { className: "cover__rule", "aria-hidden": "true" }),
      book.born ? txt("p", "cover__born", book.born, "born") : null,
      book.settings && book.settings.interviewDate
        ? el("p", { className: "cover__date", text: book.settings.interviewDate + " 인터뷰를 바탕으로" })
        : null,
    ]);
    return { kind: "cover", label: "표지", node: inner };
  }

  function contentsPage(book) {
    var list = el("ol", { className: "toc" });
    var entries = [{ label: "프롤로그", page: 2 }];
    book.chapters.forEach(function (c, i) {
      entries.push({ num: chapterLabel(i), label: c.title, period: c.period, page: 3 + i });
    });
    entries.push({ label: "연보", page: 3 + book.chapters.length });
    entries.push({ label: "에필로그", page: 4 + book.chapters.length });
    entries.forEach(function (e) {
      list.appendChild(
        el("li", null, [
          el("a", { href: "#" + (e.page + 1), "data-goto": e.page, className: "toc__link" }, [
            e.num ? el("span", { className: "toc__num", text: e.num }) : null,
            el("span", { className: "toc__title", text: e.label }),
            e.period ? el("span", { className: "toc__period", text: e.period }) : null,
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

  function prosePage(kind, heading, paragraphs, pathPrefix, before) {
    var body = el("div", { className: "prose" });
    (paragraphs || []).forEach(function (p, i) {
      body.appendChild(txt("p", null, p, pathPrefix + "." + i));
    });
    return {
      kind: kind,
      label: heading,
      node: el("div", null, [before || null, el("h2", { className: "page__heading", text: heading }), body]),
    };
  }

  function chapterPage(book, c, i) {
    var body = el("div", { className: "prose" });
    var paras = c.paragraphs || [];
    var quoteAt = Math.max(1, Math.floor(paras.length / 2));
    paras.forEach(function (p, j) {
      if (j === quoteAt && c.pullQuote && c.pullQuote.text) body.appendChild(pullQuote(c.pullQuote, i));
      body.appendChild(txt("p", null, p, "chapters." + i + ".paragraphs." + j));
    });
    if (paras.length <= 1 && c.pullQuote && c.pullQuote.text) body.appendChild(pullQuote(c.pullQuote, i));

    var head = el("header", { className: "chapter__head" }, [
      el("p", { className: "chapter__num", text: chapterLabel(i) }),
      txt("h2", "chapter__title", c.title, "chapters." + i + ".title"),
      c.period ? txt("p", "chapter__period", c.period, "chapters." + i + ".period") : null,
    ]);
    return { kind: "chapter", label: chapterLabel(i) + " " + c.title, node: el("div", null, [head, body]) };
  }

  function pullQuote(q, i) {
    return el("figure", { className: "pullquote" }, [
      txt("blockquote", null, q.text, "chapters." + i + ".pullQuote.text"),
      q.context ? txt("figcaption", null, q.context, "chapters." + i + ".pullQuote.context") : null,
    ]);
  }

  function timelinePage(book) {
    var list = el("ol", { className: "timeline" });
    (book.timeline || []).forEach(function (t, i) {
      list.appendChild(
        el("li", null, [
          txt("span", "timeline__when", t.when, "timeline." + i + ".when"),
          txt("span", "timeline__event", t.event, "timeline." + i + ".event"),
        ])
      );
    });
    return {
      kind: "timeline",
      label: "연보",
      node: el("div", null, [el("h2", { className: "page__heading", text: "연보" }), list]),
    };
  }

  function epiloguePage(book) {
    var page = prosePage("epilogue", "에필로그", book.epilogue, "epilogue");
    var date = book.settings && book.settings.interviewDate;
    page.node.appendChild(
      el("footer", { className: "colophon" }, [
        el("p", { className: "colophon__title", text: book.title }),
        el("p", {
          text:
            (date ? date + "에 " : "") +
            "녹음한 인터뷰를 바탕으로 엮은 책입니다." +
            (book.sample ? " 이 책은 앱 시연을 위한 샘플이며, 등장인물은 가상의 인물입니다." : ""),
        }),
      ])
    );
    return page;
  }

  function buildPages(book) {
    var epigraph = book.epigraph
      ? el("figure", { className: "epigraph" }, [
          txt("blockquote", null, book.epigraph, "epigraph"),
          book.subjectName ? el("figcaption", { text: "— " + book.subjectName }) : null,
        ])
      : null;
    var pages = [coverPage(book), contentsPage(book), prosePage("prologue", "프롤로그", book.prologue, "prologue", epigraph)];
    book.chapters.forEach(function (c, i) {
      pages.push(chapterPage(book, c, i));
    });
    pages.push(timelinePage(book), epiloguePage(book));
    return pages;
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

    // Top bar
    var actions = el("div", { className: "reader__actions" });
    var tocBtn = button("차례", "목차로 이동", function () {
      go(1);
    });
    var sizeBtn = button("가", "글자 크기 바꾸기", function () {
      var now = document.documentElement.getAttribute("data-size") || "m";
      var next = SIZES[(SIZES.indexOf(now) + 1) % SIZES.length];
      applySize(next);
      store(SIZE_KEY, next);
    });
    sizeBtn.classList.add("btn--size");
    var themeBtn = button("◐", "밝게/어둡게", function () {
      var dark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
      var next = dark ? "light" : "dark";
      applyTheme(next);
      store(THEME_KEY, next);
    });
    var printBtn = button("PDF", "인쇄하거나 PDF로 저장", function () {
      window.print();
    });
    actions.appendChild(tocBtn);
    actions.appendChild(sizeBtn);
    actions.appendChild(themeBtn);

    var editBtn;
    if (options.onChange) {
      editBtn = button("편집", "본문 직접 고치기", function () {
        setEditing(!editing);
      });
      actions.appendChild(editBtn);
    }
    (options.extraActions || []).forEach(function (a) {
      actions.appendChild(button(a.label, a.title, a.onClick));
    });
    actions.appendChild(printBtn);

    var top = el("header", { className: "reader__top" }, [
      options.homeHref
        ? el("a", { className: "reader__home", href: options.homeHref, title: "처음으로", text: "← 서재" })
        : el("span"),
      el("p", { className: "reader__title", text: book.title || "" }),
      actions,
    ]);

    var editNote = el("div", { className: "reader__editnote", role: "status", hidden: "hidden" }, [
      "편집 중입니다. 글자를 눌러 바로 고칠 수 있어요. 고친 내용은 자동으로 저장됩니다.",
    ]);

    // Pages
    var stage = el("main", { className: "reader__stage" });
    pages.forEach(function (p, i) {
      var section = el("section", {
        className: "page page--" + p.kind,
        id: "page-" + (i + 1),
        "aria-label": p.label,
        "data-index": i,
      }, [el("div", { className: "page__inner" }, [p.node, el("p", { className: "page__folio", text: i === 0 ? "" : String(i + 1) })])]);
      stage.appendChild(section);
    });

    // Bottom navigation
    var prev = button("‹ 이전", "이전 쪽", function () {
      go(current - 1);
    });
    var next = button("다음 ›", "다음 쪽", function () {
      go(current + 1);
    });
    var where = el("span", { className: "reader__where", "aria-live": "polite" });
    var bar = el("div", { className: "reader__progress" }, [el("span")]);
    var bottom = el("nav", { className: "reader__nav", "aria-label": "쪽 넘기기" }, [prev, where, next]);

    root.textContent = "";
    root.className = "reader";
    root.appendChild(top);
    root.appendChild(editNote);
    root.appendChild(bar);
    root.appendChild(stage);
    root.appendChild(bottom);

    var sections = stage.querySelectorAll(".page");

    function go(i, fromHash) {
      if (i < 0 || i >= pages.length) return;
      var dir = i > current ? "fwd" : "back";
      current = i;
      sections.forEach(function (s, k) {
        s.classList.toggle("is-active", k === i);
        s.classList.remove("enter-fwd", "enter-back");
        if (k === i) s.classList.add("enter-" + dir);
      });
      var inner = sections[i].querySelector(".page__inner");
      if (inner) inner.scrollTop = 0;
      window.scrollTo(0, 0);
      where.textContent = (i + 1) + " / " + pages.length + " · " + pages[i].label;
      prev.disabled = i === 0;
      next.disabled = i === pages.length - 1;
      bar.firstChild.style.width = ((i + 1) / pages.length) * 100 + "%";
      if (!fromHash) {
        try {
          history.replaceState(null, "", "#" + (i + 1));
        } catch (e) {}
      }
    }

    function fromHash() {
      var n = parseInt((location.hash || "").slice(1), 10);
      return n >= 1 && n <= pages.length ? n - 1 : 0;
    }

    stage.addEventListener("click", function (e) {
      var link = e.target.closest("[data-goto]");
      if (link) {
        e.preventDefault();
        go(parseInt(link.getAttribute("data-goto"), 10));
      }
    });

    document.addEventListener("keydown", function (e) {
      if (editing || e.target.isContentEditable || /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") go(current + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(current - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(pages.length - 1);
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
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(current + (dx < 0 ? 1 : -1));
    });

    window.addEventListener("hashchange", function () {
      go(fromHash(), true);
    });

    // Editing
    var saveTimer;
    stage.addEventListener("input", function (e) {
      var path = e.target.getAttribute && e.target.getAttribute("data-path");
      if (!path) return;
      setPath(book, path, e.target.textContent.trim());
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        options.onChange(book);
      }, 400);
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
      if (editBtn) {
        editBtn.textContent = on ? "편집 끝" : "편집";
        editBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      stage.querySelectorAll("[data-path]").forEach(function (n) {
        if (on) n.setAttribute("contenteditable", "plaintext-only");
        else n.removeAttribute("contenteditable");
      });
      if (!on && options.onChange) options.onChange(book);
    }

    go(fromHash(), true);
    return { go: go, book: book };
  }

  function button(label, title, onClick) {
    var b = el("button", { type: "button", className: "btn", title: title, "aria-label": title, text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
  }
  function applySize(size) {
    document.documentElement.setAttribute("data-size", SIZES.indexOf(size) >= 0 ? size : "m");
  }

  window.ChronicleBook = { mount: mount };
})();
