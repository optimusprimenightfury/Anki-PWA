#!/usr/bin/env node
/**
 * jsdom wiring test — drives the real app.js UI against the real parser.
 *
 * Requires: `npm i -D jsdom` (not needed for the parser/worker tests).
 * Runs the full pipeline: file load → worker protocol (stubbed Worker that
 * runs the real AnkiParser) → DOM render → blob-URL media → expand → search →
 * sort → pencil buttons.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.log('SKIP — jsdom not installed (npm i -D jsdom to run this test).');
  process.exit(0);
}

// sql.js / fflate for the in-process parser (dev-only: look in local
// node_modules first, then the shared vendor dir used during development)
function devRequire(rel) {
  try { return require(path.join(ROOT, 'node_modules', rel)); } catch (e) { /* next */ }
  return require(path.join('/tmp/vendor/node_modules', rel));
}
const initSqlJs = devRequire('sql.js/dist/sql-wasm.js');
const fflate = devRequire('fflate');
const fzstd = devRequire('fzstd');

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:8080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  // ---- polyfills jsdom lacks ------------------------------------------------
  window.URL.createObjectURL = () => 'blob:mock-' + Math.random().toString(36).slice(2);
  window.URL.revokeObjectURL = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (typeof window.TextDecoder === 'undefined' && typeof TextDecoder !== 'undefined') {
    window.TextDecoder = TextDecoder; // Node's — jsdom doesn't ship one
  }
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));

  window.fflate = fflate;
  window.initSqlJs = initSqlJs;
  window.fzstd = fzstd;

  // ---- load parser.js + app.js into the window --------------------------------
  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'parser.js'), 'utf8'));
  assert.ok(window.AnkiParser, 'AnkiParser global installed');

  // ---- stub Worker: run the real parser, speak the same protocol ---------------
  class FakeWorker {
    constructor() { this.listeners = {}; }
    addEventListener(type, cb) { (this.listeners[type] = this.listeners[type] || []).push(cb); }
    emit(m) { (this.listeners.message || []).forEach((cb) => cb({ data: m })); }
    postMessage(msg) {
      (async () => {
        try {
          const res = await window.AnkiParser.parseApkg(msg.buffer, {
            wasmBase: '/tmp/vendor/node_modules/sql.js/dist/',
            onProgress: (p, t) => this.emit({ type: 'progress', id: msg.id, progress: p, text: t })
          });
          this.emit({ type: 'result', id: msg.id, elapsed: 12, data: res });
        } catch (e) {
          this.emit({ type: 'error', id: msg.id, message: e.message });
        }
      })();
    }
  }
  window.Worker = FakeWorker;

  window.eval(fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8'));
  assert.ok(window.AnkiInspector, 'AnkiInspector API exposed');

  // ---- 1) load the sample like the file picker does ----------------------------
  const buf = fs.readFileSync(path.join(ROOT, 'test', 'sample.apkg'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  await window.AnkiInspector.loadApkg(ab, 'sample.apkg', ab.byteLength);
  await new Promise((r) => setTimeout(r, 50));
  const doc = window.document;

  const notes = doc.querySelectorAll('.note');
  assert.strictEqual(notes.length, 3, '3 notes rendered');
  assert.strictEqual(doc.querySelector('.model-badge').textContent, 'Basic+', 'model badge');
  assert.ok(!doc.querySelector('#main').hidden, 'main visible');

  // media lives in the Back field (extra): expand and check <img> → blob
  doc.querySelector('.note .expand-btn').click();
  await new Promise((r) => setTimeout(r, 20));
  const img = doc.querySelector('.note-extra img');
  assert.ok(img && img.src.startsWith('blob:'), 'img → blob URL, got: ' + (img && img.src));

  // second note: [sound:note.mp3] → <audio> blob
  doc.querySelectorAll('.note')[1].querySelector('.expand-btn').click();
  await new Promise((r) => setTimeout(r, 20));
  const audio = doc.querySelectorAll('.note')[1].querySelector('.note-extra audio');
  assert.ok(audio && audio.src.startsWith('blob:'), 'audio → blob URL');

  // stats
  const stats = doc.querySelector('#stats').textContent;
  assert.ok(stats.includes('3 notes'), 'stats: ' + stats);
  assert.ok(stats.includes('2 media'), 'stats counts media');

  // search filter
  const search = doc.querySelector('#search');
  search.value = 'mitosis';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.strictEqual(doc.querySelectorAll('.note').length, 1, 'search narrows to 1');

  // clear search, then sort by model
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const sort = doc.querySelector('#sort');
  sort.value = 'model';
  sort.dispatchEvent(new window.Event('change', { bubbles: true }));
  const badges = [...doc.querySelectorAll('.model-badge')].map((b) => b.textContent);
  assert.deepStrictEqual(badges, ['Basic+', 'Basic+', 'Cloze'], 'sorted by model');

  // pencil buttons exist
  assert.strictEqual(doc.querySelectorAll('.edit-btn').length, 3, '3 pencil buttons');

  // ---- 2) modern (2022+) package end-to-end: zstd DB + protobuf media --------
  const mbuf = fs.readFileSync(path.join(ROOT, 'test', 'sample-modern.apkg'));
  const mab = mbuf.buffer.slice(mbuf.byteOffset, mbuf.byteOffset + mbuf.byteLength);
  await window.AnkiInspector.loadApkg(mab, 'modern.apkg', mab.byteLength);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(doc.querySelectorAll('.note').length, 3, 'modern: 3 notes rendered');
  assert.ok(doc.querySelector('.model-badge').textContent === 'Basic+', 'modern: notetype from schema-18 tables');
  const mstats = doc.querySelector('#stats').textContent;
  assert.ok(mstats.includes('2022+'), 'modern: format label in stats: ' + mstats);

  // version surfaced (self-update transparency)
  assert.ok(window.AnkiInspector.version, 'app version exposed');

  console.log('PASS — DOM wiring: render, blob-URL media, expand, search, sort, edit buttons + modern zstd/protobuf package');
  process.exit(0);
})().catch((e) => { console.error('DOM TEST FAIL:', e); process.exit(1); });
