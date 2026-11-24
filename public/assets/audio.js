/*
 * Prepares an interview recording for transcription in the browser:
 * decodes it at 16 kHz mono, then cuts it into ~100-second WAV chunks
 * (each under Vercel's 4.5 MB request limit), cutting at a quiet moment
 * so words are not split between chunks.
 */
(function () {
  "use strict";

  var RATE = 16000;
  var CHUNK_SEC = 100;
  var SEARCH_SEC = 8; // look for a quiet spot within the last 8 s of each chunk
  var DIRECT_MAX = 4 * 1024 * 1024;
  // Small files are sent as they are only in formats every engine accepts (the audio models
  // take WAV and MP3); anything else is decoded and sent as WAV pieces.
  var DIRECT_TYPES = /\.(mp3|wav)$/i;

  function decode(arrayBuffer) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx({ sampleRate: RATE });
    return new Promise(function (resolve, reject) {
      var done = false;
      var p = ctx.decodeAudioData(
        arrayBuffer,
        function (b) { done = true; resolve(b); },
        function (e) { done = true; reject(e || new Error("decode failed")); }
      );
      if (p && p.then) p.then(function (b) { if (!done) resolve(b); }, function (e) { if (!done) reject(e); });
    }).finally(function () {
      if (ctx.close) ctx.close();
    });
  }

  // Mixes down to one channel without copying when the recording is already mono.
  function toMono(buffer) {
    var channels = buffer.numberOfChannels;
    if (channels === 1) return buffer.getChannelData(0);
    var out = new Float32Array(buffer.length);
    for (var c = 0; c < channels; c++) {
      var data = buffer.getChannelData(c);
      for (var i = 0; i < out.length; i++) out[i] += data[i] / channels;
    }
    return out;
  }

  // Index of the quietest 250 ms window between `from` and `to`.
  function quietestPoint(samples, from, to, rate) {
    var win = Math.floor(rate / 4);
    var best = to, bestEnergy = Infinity;
    for (var start = from; start + win <= to; start += Math.floor(win / 2)) {
      var e = 0;
      for (var i = start; i < start + win; i += 4) e += samples[i] * samples[i];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = start + Math.floor(win / 2);
      }
    }
    return best;
  }

  function encodeWav(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, samples.length * 2, true);
    var off = 44;
    for (var i = 0; i < samples.length; i++, off += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  /**
   * Returns { duration (seconds or null), chunks: [{ getBlob(), name, type, start, end }] }.
   * WAV data for a chunk is only built when getBlob() is called, so a long recording
   * never holds every encoded chunk in memory at once.
   */
  // Reads the duration from the file's metadata without decoding it.
  function metadataSeconds(file) {
    return new Promise(function (resolve) {
      var a = document.createElement("audio");
      var url = URL.createObjectURL(file);
      var done = function (v) { URL.revokeObjectURL(url); resolve(v); };
      a.preload = "metadata";
      a.onloadedmetadata = function () { done(isFinite(a.duration) ? a.duration : null); };
      a.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 5000);
      a.src = url;
    });
  }

  async function prepare(file) {
    // Refuse very long recordings before decoding them, which could crash a phone's browser.
    var known = await metadataSeconds(file);
    if (known && known > 3 * 3600) {
      throw new Error("녹음이 3시간보다 깁니다. 휴대폰이나 브라우저가 멈출 수 있으니 2시간 이하로 나눠서 올려 주세요.");
    }
    var direct = file.size <= DIRECT_MAX && DIRECT_TYPES.test(file.name);
    var buffer;
    try {
      buffer = await decode(await file.arrayBuffer());
    } catch (e) {
      // A file the browser can't decode is not sent anyway: it is usually not audio at all.
      throw new Error("녹음 파일을 읽지 못했습니다. 파일이 손상됐거나 녹음 파일이 아닐 수 있어요. MP3나 M4A 파일로 다시 올려 주세요.");
    }

    var duration = buffer.duration;
    if (duration > 3 * 3600) {
      throw new Error("녹음이 3시간보다 깁니다. 휴대폰이나 브라우저가 멈출 수 있으니 2시간 이하로 나눠서 올려 주세요.");
    }
    // Small files the API accepts as-is: send the original (better quality, fewer requests).
    if (direct) {
      return { duration: duration, chunks: [whole(file, duration)] };
    }

    var rate = buffer.sampleRate || RATE;
    var samples = toMono(buffer);
    buffer = null;
    var chunks = [];
    var pos = 0;
    // At most ~4.2 MB of 16-bit WAV per piece, whatever rate the browser decoded at
    // (older Safari ignores the 16 kHz request and decodes at 44.1/48 kHz).
    var size = Math.min(CHUNK_SEC * rate, Math.floor(4.2e6 / 2));
    while (pos < samples.length) {
      var end = Math.min(samples.length, pos + size);
      if (end < samples.length) end = quietestPoint(samples, end - SEARCH_SEC * rate, end, rate);
      // Skip near-silent tails (< 1 s).
      if (end - pos >= rate) chunks.push(piece(samples, pos, end, rate, chunks.length + 1));
      pos = end;
    }
    return { duration: duration, chunks: chunks };
  }

  function whole(file, duration) {
    return { getBlob: function () { return file; }, name: file.name, type: file.type || "audio/mpeg", start: 0, end: duration };
  }

  function piece(samples, from, to, rate, n) {
    return {
      getBlob: function () { return encodeWav(samples.subarray(from, to), rate); },
      name: "chunk-" + n + ".wav",
      type: "audio/wav",
      start: from / rate,
      end: to / rate,
    };
  }

  window.AudioChunker = { prepare: prepare, duration: metadataSeconds };
})();
