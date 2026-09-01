/*!
 * Anki Inspector — Web Worker entry.
 *
 * All heavy lifting (unzip + WASM SQLite + media extraction) happens here so the
 * main thread stays at 0% CPU and the UI never blocks or OOMs on tablets.
 *
 * Protocol:
 *   in : { type:'parse', id:number, buffer:ArrayBuffer }   (buffer is transferred)
 *   out: { type:'progress', id, progress:0..1, text }
 *        { type:'result',   id, elapsed, data }            (media bytes transferred)
 *        { type:'error',    id, message }
 */
'use strict';

importScripts('fflate.min.js', 'fzstd.min.js', 'sql-wasm.js', 'parser.js');

// Resolve to this worker's own directory so the WASM binary is found
// regardless of where the app is mounted (e.g. /, /anki/, sub-path deploys).
var SCRIPT_DIR = (function () {
  var p = self.location ? self.location.pathname : '';
  return p.substring(0, p.lastIndexOf('/') + 1);
})();

self.addEventListener('message', function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== 'parse') return;

  var id = msg.id;
  var report = function (progress, text) {
    self.postMessage({ type: 'progress', id: id, progress: progress, text: text });
  };

  (async function () {
    var t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    var result = await AnkiParser.parseApkg(msg.buffer, {
      onProgress: report,
      wasmBase: SCRIPT_DIR
    });

    // Transfer the raw media bytes to the main thread (zero-copy).
    var transfers = result.media.map(function (m) { return m.bytes.buffer; });
    self.postMessage(
      {
        type: 'result',
        id: id,
        elapsed: ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0,
        data: result
      },
      transfers
    );
  })().catch(function (err) {
    self.postMessage({
      type: 'error',
      id: id,
      message: (err && err.message) ? err.message : String(err)
    });
  });
});
