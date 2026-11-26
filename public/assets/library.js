/*
 * Books are kept in this browser's localStorage, and their photos in its IndexedDB, which has
 * room for them (nothing is stored on the server).
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

  // The list of books; anything else stored there (damaged or from another version) counts as empty.
  function index() {
    var x = read(INDEX);
    return Array.isArray(x) ? x : [];
  }

  function list() {
    return index().sort(function (a, b) {
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });
  }

  function save(book) {
    book.updatedAt = new Date().toISOString();
    var current = index();
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
    var book = get(id);
    if (book) photoIds(book).forEach(function (p) { removePhoto(p).catch(function () {}); });
    remove(BOOK + id);
    remove(TRANSCRIPT + id); // transcripts saved by earlier versions
    write(INDEX, (index()).filter(function (e) {
      return e.id !== id;
    }));
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- Photos: JPEG Blobs in IndexedDB, keyed by photo id ----------

  var db = null;
  function photos(mode, work) {
    db = db || new Promise(function (resolve, reject) {
      var req = indexedDB.open("chronicle", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("photos"); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return db.then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction("photos", mode);
        var req = work(tx.objectStore("photos"));
        tx.oncomplete = function () { resolve(req.result); };
        tx.onabort = function () { reject(tx.error); };
      });
    }).catch(function (e) {
      db = null; // e.g. Safari closed the connection while the page was in the background
      throw e;
    });
  }

  function photoIds(book) {
    var ids = [];
    (book.chapters || []).forEach(function (c) {
      (c.photos || []).forEach(function (p) { ids.push(p.id); });
    });
    return ids;
  }

  // Scales the picture down to 1600px on its longest side and stores it as a JPEG. Drawing an
  // image onto a canvas follows its EXIF rotation, and the JPEG made from it keeps no EXIF
  // (so no place or date) at all.
  function addPhoto(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.src = url;
    return img.decode().then(function () {
      var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // transparent parts of a PNG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) { if (b) resolve(b); else reject(); }, "image/jpeg", 0.82);
      });
    }).then(function (blob) {
      var id = newId();
      return photos("readwrite", function (s) { return s.put(blob, id); }).then(function () { return id; }, function () {
        throw new Error("사진을 저장하지 못했어요.");
      });
    }, function () {
      throw new Error("이 사진은 열 수 없어요. JPG나 PNG로 골라 주세요.");
    }).finally(function () {
      URL.revokeObjectURL(url);
    });
  }

  /** The photo's JPEG Blob, or undefined when this browser doesn't have it. */
  function photo(id) {
    return photos("readonly", function (s) { return s.get(id); });
  }

  function removePhoto(id) {
    return photos("readwrite", function (s) { return s.delete(id); });
  }

  function dataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
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
      '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600;700&display=swap" rel="stylesheet">\n' +
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">\n' +
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
    // Photos go inside the file, so it needs nothing else to show them.
    copy.chapters = [];
    for (var i = 0; i < (book.chapters || []).length; i++) {
      var c = book.chapters[i];
      if (c.photos && c.photos.length) {
        var inFile = [];
        for (var j = 0; j < c.photos.length; j++) {
          var p = c.photos[j];
          var blob = await photo(p.id).catch(function () { return null; });
          if (blob) inFile.push({ id: p.id, after: p.after, caption: p.caption, size: p.size, src: await dataUrl(blob) });
        }
        c = Object.assign({}, c, { photos: inFile });
      }
      copy.chapters.push(c);
    }
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
    addPhoto: addPhoto,
    photo: photo,
    removePhoto: removePhoto,
  };
})();
