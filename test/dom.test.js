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
  // jsdom lacks scroll APIs
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
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
  assert.strictEqual(notes.length, 4, '4 notes rendered');
  assert.strictEqual(doc.querySelector('.model-badge').textContent, 'Basic+', 'model badge');
  assert.ok(!doc.querySelector('#main').hidden, 'main visible');
  // the landing screen must fully step aside once a deck is loaded
  assert.ok(doc.querySelector('#dropzone').hidden, 'dropzone hidden after load');
  assert.ok(doc.querySelector('#help-card').hidden, 'help card hidden after load');

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
  assert.ok(stats.includes('4 notes'), 'stats: ' + stats);
  assert.ok(stats.includes('3 media'), 'stats counts media');

  // ---- image occlusion note: masked image preview instead of raw mask text -----
  const ioNote = doc.querySelector('.note[data-id="1004"]');
  assert.ok(ioNote, 'IO note rendered');
  const ioImg = ioNote.querySelector('.io-frame img');
  assert.ok(ioImg && ioImg.src.startsWith('blob:'), 'IO base image → blob URL');
  const ioShapes = ioNote.querySelectorAll('.io-shape');
  assert.strictEqual(ioShapes.length, 4, 'IO: 4 mask shapes drawn');
  assert.ok(ioNote.querySelector('.io-shape.io-rect'), 'IO: rect mask');
  assert.ok(ioNote.querySelector('.io-shape.io-ellipse'), 'IO: ellipse mask');
  assert.ok(ioNote.querySelector('.io-shape.io-polygon'), 'IO: polygon mask');
  assert.ok(ioNote.querySelector('.io-shape.io-text'), 'IO: text mask');
  assert.strictEqual(ioNote.querySelector('.io-overlay').getAttribute('viewBox'), '0 0 640 480', 'IO: placeholder viewBox');
  // real Anki grammar: normalized text fs (.05 of image height) must become a
  // readable pixel font size in the placeholder pass (.05 × 480 = 24)
  const ioLabel = ioNote.querySelector('.io-text-label');
  assert.strictEqual(ioLabel.getAttribute('font-size'), '24', 'IO: text fs denormalized');
  assert.strictEqual(ioLabel.textContent, 'Nucleus', 'IO: text label content');
  // stored angle (2500/10000 turn = 90°) becomes a rotate transform
  assert.ok(/rotate\(90/.test(ioNote.querySelector('.io-shape.io-ellipse').getAttribute('transform') || ''), 'IO: stored angle → rotate');
  // reveal toggle flips masked ↔ transparent state
  ioNote.querySelector('.io-toggle').click();
  assert.ok(ioNote.querySelector('.io-preview').classList.contains('revealed'), 'IO: reveal toggles');
  // raw occlusions field must NOT render as machine text in the extras
  ioNote.querySelector('.expand-btn').click();
  await new Promise((r) => setTimeout(r, 20));
  const occlValue = ioNote.querySelector('.extra-value .io-summary');
  assert.ok(occlValue && /mask/.test(occlValue.textContent), 'IO: occlusions field summarized, not dumped');

  // ---- card-type filter chips (must sit ABOVE the sort mechanism) --------------
  const chips = [...doc.querySelectorAll('.type-chip')];
  assert.strictEqual(chips.length, 6, 'six card-type chips');
  assert.ok(doc.querySelector('#type-bar') && !doc.querySelector('#type-bar').hidden, 'type bar visible');
  const typeBar = doc.querySelector('#type-bar');
  const sortSel = doc.querySelector('#sort');
  assert.ok(
    typeBar.compareDocumentPosition(sortSel) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'type chips sit above the sort control'
  );
  const chipById = (id) => chips.find((c) => c.dataset.type === id);
  assert.strictEqual(chipById('new').querySelector('.chip-count').textContent, '1', 'new chip count');
  assert.strictEqual(chipById('suspended').querySelector('.chip-count').textContent, '1', 'suspended chip count');
  // toggling "New" off hides the only new-card note
  chipById('new').click();
  assert.strictEqual(doc.querySelectorAll('.note').length, 3, 'new filtered out');
  assert.strictEqual(chipById('new').getAttribute('aria-pressed'), 'false', 'chip pressed state');
  assert.ok(!doc.querySelector('#type-reset').hidden, 'reset appears when filtering');
  // reset restores everything
  doc.querySelector('#type-reset').click();
  assert.strictEqual(doc.querySelectorAll('.note').length, 4, 'reset restores notes');
  assert.strictEqual(chipById('new').getAttribute('aria-pressed'), 'true', 'chip reset state');

  // card chips carry their type class
  assert.ok(doc.querySelector('.note[data-id="1004"] .card-chip.k-due'), 'card chip class due');
  assert.ok(doc.querySelector('.note[data-id="1004"] .card-chip.k-suspended'), 'card chip class suspended');

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
  assert.deepStrictEqual(badges, ['Basic+', 'Basic+', 'Cloze', 'Image Occlusion'], 'sorted by model');

  // direction toggle flips whichever sort is active
  const sortDir = doc.querySelector('#sort-dir');
  assert.ok(sortDir, 'sort direction button present');
  sortDir.click();
  assert.deepStrictEqual(
    [...doc.querySelectorAll('.model-badge')].map((b) => b.textContent),
    ['Image Occlusion', 'Cloze', 'Basic+', 'Basic+'],
    'descending sort reverses the order'
  );
  assert.strictEqual(sortDir.textContent, '↓', 'direction button shows ↓');
  sortDir.click();
  assert.deepStrictEqual(
    [...doc.querySelectorAll('.model-badge')].map((b) => b.textContent),
    ['Basic+', 'Basic+', 'Cloze', 'Image Occlusion'],
    'ascending sort restores the order'
  );

  // pencil buttons exist
  assert.strictEqual(doc.querySelectorAll('.edit-btn').length, 4, '4 pencil buttons');

  // deep links: AnkiDroid browser search by nid — never the Play Store
  const link = window.AnkiInspector.ankiDeepLink({ id: 12345 }, 'Mozilla/5.0 (Linux; Android 14) Chrome');
  assert.strictEqual(link, 'anki://x-callback-url/browser?search=nid%3A12345', 'AnkiDroid deep link');
  const iosLink = window.AnkiInspector.ankiDeepLink({ id: 7 }, 'iPhone Safari');
  assert.strictEqual(iosLink, 'anki://x-callback-url/search?query=nid%3A7', 'AnkiMobile deep link');
  assert.ok(!/play\.google/.test(link), 'no Play Store fallback anywhere');

  // card classification used by chips + card chips
  assert.strictEqual(window.AnkiInspector.cardClass({ type: 0, queue: 0 }), 'new', 'class new');
  assert.strictEqual(window.AnkiInspector.cardClass({ type: 1, queue: 1 }), 'learn', 'class learn');
  assert.strictEqual(window.AnkiInspector.cardClass({ type: 2, queue: 2 }), 'due', 'class due');
  assert.strictEqual(window.AnkiInspector.cardClass({ type: 2, queue: -1 }), 'suspended', 'class suspended');
  assert.strictEqual(window.AnkiInspector.cardClass({ type: 2, queue: -3 }), 'buried', 'class buried');

  // error banner really dismisses (hidden attribute, not just opacity)
  const errBox = doc.querySelector('#error-box');
  assert.ok(errBox.hidden, 'error box hidden initially');
  // a failed load raises the banner; Dismiss (and only that) takes it down
  await window.AnkiInspector.loadApkg(new ArrayBuffer(16), 'garbage.apkg', 16);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!errBox.hidden, 'error box visible after a failed parse');
  doc.querySelector('#error-close').click();
  assert.ok(errBox.hidden, 'error box dismissed by the Dismiss button');

  // ---- 2) modern (2022+) package end-to-end: zstd DB + protobuf media --------
  const mbuf = fs.readFileSync(path.join(ROOT, 'test', 'sample-modern.apkg'));
  const mab = mbuf.buffer.slice(mbuf.byteOffset, mbuf.byteOffset + mbuf.byteLength);
  await window.AnkiInspector.loadApkg(mab, 'modern.apkg', mab.byteLength);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(doc.querySelectorAll('.note').length, 4, 'modern: 4 notes rendered');
  assert.ok(doc.querySelector('.model-badge').textContent === 'Basic+', 'modern: notetype from schema-18 tables');
  const mstats = doc.querySelector('#stats').textContent;
  assert.ok(mstats.includes('2022+'), 'modern: format label in stats: ' + mstats);

  // version surfaced (self-update transparency)
  assert.ok(window.AnkiInspector.version, 'app version exposed');

  // ---- deploy alignment: HTML ?v=, sw.js ASSET_VER and APP_VERSION in lockstep --
  // (this is what prevents a fresh page from pairing with yesterday's JS/CSS)
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const v = window.AnkiInspector.version;
    const assetVer = (swSrc.match(/ASSET_VER\s*=\s*'([^']+)'/) || [])[1];
    assert.strictEqual(assetVer, v, 'sw.js ASSET_VER matches APP_VERSION (' + v + ')');
    for (const file of ['css/app.css', 'js/parser.js', 'js/app.js']) {
      assert.ok(
        html.includes(file + '?v=' + v),
        'index.html pins ' + file + ' to ?v=' + v
      );
    }
    assert.ok(/VERSION = 'anki-inspector-v5'/.test(swSrc), 'service worker cache generation bumped');
    assert.strictEqual(doc.querySelectorAll('main').length, 1, 'exactly one <main> (dropzone is a section)');
  }

  // ---- occlusion geometry: normalized vs pre-release pixel coordinates -------
  {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(SVG_NS, 'svg');
    const size = { width: 64, height: 40 };
    window.AnkiInspector.drawIoShapes(svg, [
      { shape: 'rect', ordinal: 1, props: { left: '.2', top: '.25', width: '.35', height: '.15' } },
      // pre-release pixel grammar: values > 1 must be used as-is, not scaled
      { shape: 'rect', ordinal: 2, props: { left: '19.54', top: '8', width: '126.13', height: '33.78' } }
    ], size);
    const rects = svg.querySelectorAll('rect');
    assert.strictEqual(rects.length, 2, 'two rect masks drawn');
    assert.strictEqual(rects[0].getAttribute('x'), String(0.2 * 64), 'normalized left × width');
    assert.strictEqual(rects[0].getAttribute('width'), String(0.35 * 64), 'normalized width × width');
    assert.strictEqual(rects[1].getAttribute('x'), '19.54', 'pixel left used as-is');
    assert.strictEqual(rects[1].getAttribute('width'), '126.13', 'pixel width used as-is');
    assert.strictEqual(svg.getAttribute('viewBox'), '0 0 64 40', 'viewBox = natural image size');

    // normalized text fs (.05) is denormalized against the real image height
    const svg2 = doc.createElementNS(SVG_NS, 'svg');
    window.AnkiInspector.drawIoShapes(svg2, [
      { shape: 'text', ordinal: 0, props: { left: '.05', top: '.05', text: 'Hi', fs: '.05', scale: '1.' } }
    ], { width: 640, height: 480 });
    const label = svg2.querySelector('.io-text-label');
    assert.strictEqual(label.getAttribute('font-size'), String(0.05 * 480), 'fs denormalized to pixels');
  }

  console.log('PASS — DOM wiring: render, blob-URL media, expand, search, sort, type chips, image occlusion, deep links + modern zstd/protobuf package');
  process.exit(0);
})().catch((e) => { console.error('DOM TEST FAIL:', e); process.exit(1); });
