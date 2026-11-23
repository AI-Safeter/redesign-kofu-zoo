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
  var DIRECT_TYPES = /\.(mp3|m4a|mp4|wav|webm|mpeg|mpga|ogg|oga|flac)$/i;

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

  function toMono(buffer) {
    var n = buffer.length;
    var channels = buffer.numberOfChannels;
    if (channels === 1) return buffer.getChannelData(0).slice();
    var out = new Float32Array(n);
    for (var c = 0; c < channels; c++) {
      var data = buffer.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += data[i] / channels;
    }
    return out;
  }

  // Index of the quietest 250 ms window between `from` and `to`.
  function quietestPoint(samples, from, to) {
    var win = Math.floor(RATE / 4);
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

  function encodeWav(samples) {
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
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
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
   * Returns { duration (seconds or null), chunks: [{ blob, name, type, start, end }] }.
   */
  async function prepare(file) {
    var direct = file.size <= DIRECT_MAX && DIRECT_TYPES.test(file.name);
    var buffer;
    try {
      buffer = await decode(await file.arrayBuffer());
    } catch (e) {
      if (direct) {
        return { duration: null, chunks: [{ blob: file, name: file.name, type: file.type || "audio/mpeg", start: 0, end: null }] };
      }
      throw new Error("이 브라우저에서 오디오 파일을 읽지 못했습니다. MP3나 M4A로 변환해서 다시 올려 주세요.");
    }

    var duration = buffer.duration;
    // Small files the API accepts as-is: send the original (better quality, fewer requests).
    if (direct) {
      return { duration: duration, chunks: [{ blob: file, name: file.name, type: file.type || "audio/mpeg", start: 0, end: duration }] };
    }

    var samples = toMono(buffer);
    buffer = null;
    var chunks = [];
    var pos = 0;
    var size = CHUNK_SEC * RATE;
    while (pos < samples.length) {
      var end = Math.min(samples.length, pos + size);
      if (end < samples.length) end = quietestPoint(samples, end - SEARCH_SEC * RATE, end);
      // Skip near-silent tails (< 1 s).
      if (end - pos >= RATE) {
        chunks.push({
          blob: encodeWav(samples.subarray(pos, end)),
          name: "chunk-" + (chunks.length + 1) + ".wav",
          type: "audio/wav",
          start: pos / RATE,
          end: end / RATE,
        });
      }
      pos = end;
    }
    return { duration: duration, chunks: chunks };
  }

  window.AudioChunker = { prepare: prepare };
})();
