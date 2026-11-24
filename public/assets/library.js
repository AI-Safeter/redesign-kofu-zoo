/*
 * Books are kept in this browser's localStorage (nothing is stored on the server).
 * Also builds the standalone .html file a user can download and share.
 */
(function () {
  "use strict";

  var INDEX = "chronicle:index";
  var BOOK = "chronicle:book:";
  var TRANSCRIPT = "chronicle:transcript:";

  function read(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  function remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  function list() {
    return (read(INDEX) || []).sort(function (a, b) {
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });
  }

  function save(book) {
    book.updatedAt = new Date().toISOString();
    var current = read(INDEX) || [];
    var wasListed = current.some(function (e) { return e.id === book.id; });
    if (!write(BOOK + book.id, book)) return false;
    var idx = current.filter(function (e) { return e.id !== book.id; });
    idx.push({ id: book.id, title: book.title, subtitle: book.subtitle, updatedAt: book.updatedAt, chapters: book.chapters.length });
    if (write(INDEX, idx)) return true;
    // A new book that is not in the index could never be listed or deleted: take it out again.
    if (!wasListed) remove(BOOK + book.id);
    return wasListed;
  }

  function get(id) {
    return read(BOOK + id);
  }

  function del(id) {
    remove(BOOK + id);
    remove(TRANSCRIPT + id); // transcripts saved by earlier versions
    write(INDEX, (read(INDEX) || []).filter(function (e) {
      return e.id !== id;
    }));
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- Standalone export ----------

  function fileName(book) {
    var base = [book.title, book.subtitle].filter(Boolean).join(" - ") || "인생 이야기";
    return base.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) + ".html";
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // The whole book as plain HTML, shown when scripts don't run (e.g. some mail or messenger previews).
  function plainHtml(book) {
    var h = function (tag, text) { return text ? "<" + tag + ">" + esc(text) + "</" + tag + ">" : ""; };
    var paras = function (list) { return (list || []).map(function (p) { return h("p", p); }).join(""); };
    var out = h("h1", book.title) + h("p", book.subtitle) + h("p", [book.subjectName, book.speakerRole].filter(Boolean).join(" · ")) + h("blockquote", book.epigraph);
    if (book.prologue && book.prologue.length) out += h("h2", "책을 펴내며") + paras(book.prologue);
    (book.chapters || []).forEach(function (c, i) {
      out += h("h2", "제" + (i + 1) + "장 " + c.title) + paras(c.paragraphs);
    });
    if (book.lastWords && book.lastWords.length) out += h("h2", book.kind === "work" ? "맺는 말" : "남기고 싶은 말") + paras(book.lastWords);
    if (book.epilogue && book.epilogue.length) out += h("h2", "에필로그") + paras(book.epilogue);
    return out;
  }

  async function standaloneHtml(book) {
    var res = await Promise.all([fetch("/assets/book.css"), fetch("/assets/book-render.js")]);
    if (!res[0].ok || !res[1].ok) throw new Error("파일을 불러오지 못했습니다.");
    var css = await res[0].text();
    var js = await res[1].text();
    var data = JSON.stringify(book).replace(/</g, "\\u003c");
    return (
      '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
      "<title>" + esc(book.title) + (book.subtitle ? " — " + esc(book.subtitle) : "") + "</title>\n" +
      '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
      '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600&family=Noto+Serif+KR:wght@400;600;700&display=swap" rel="stylesheet">\n' +
      "<style>\n" + css.replace(/<\/style/gi, "<\\/style") + "\n</style>\n</head>\n<body>\n" +
      '<div id="book"></div>\n' +
      '<noscript><div style="max-width:40em;margin:0 auto;padding:24px 16px;font-family:serif;line-height:1.8;word-break:keep-all">' +
      "<p><b>이 화면에서는 책 넘기기 기능이 동작하지 않아 글만 보여 드려요. 크롬이나 사파리 같은 브라우저로 열면 책처럼 볼 수 있어요.</b></p>" +
      plainHtml(book) + "</div></noscript>\n" +
      '<script id="book-data" type="application/json">' + data + "</script>\n" +
      "<script>\n" + js.replace(/<\/script/gi, "<\\/script") + "\n" +
      'ChronicleBook.mount(document.getElementById("book"), JSON.parse(document.getElementById("book-data").textContent));\n' +
      "</script>\n</body>\n</html>\n"
    );
  }

  async function download(book) {
    var copy = Object.assign({}, book);
    delete copy.updatedAt;
    delete copy.published; // the key that updates the published page stays in this browser
    var html = await standaloneHtml(copy);
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName(book);
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  window.Library = {
    list: list,
    get: get,
    save: save,
    remove: del,
    newId: newId,
    download: download,
  };
})();
