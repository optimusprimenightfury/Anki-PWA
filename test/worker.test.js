#!/usr/bin/env node
/**
 * Simulates the Web Worker pipeline in Node: importScripts-style loading of the
 * same files the browser worker loads (fflate, sql.js, parser.js), then runs
 * the identical message protocol and asserts the responses.
 *
 * Usage: node test/worker.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');

// Host the exact files the browser serves so paths match (worker.js is a
// classic worker script: importScripts + self.postMessage).
const src = fs.readFileSync(path.join(ROOT, 'js', 'worker.js'), 'utf8');

// A tiny classic-worker shim: it runs in a worker_thread, which provides
// `self`, `importScripts` (we polyfill), and `postMessage`-like API.
const shim = `
const path = require('path');
const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const { parentPort } = require('worker_threads');
self = globalThis;
self.location = { href: 'file://' + path.join(ROOT, 'js', 'worker.js'), pathname: path.join(ROOT, 'js', 'worker.js') };
self.importScripts = function (...urls) {
  // The fflate/sql.js UMD builds sniff for CommonJS first; in a real browser
  // worker there is no module object, so hide it here to force the global export.
  const saved = { module: globalThis.module, exports: globalThis.exports };
  delete globalThis.module;
  delete globalThis.exports;
  try {
    for (const u of urls) {
      const file = path.join(ROOT, 'js', u);
      const code = fs.readFileSync(file, 'utf8');
      (0, eval)(code); // eslint-disable-line no-eval
    }
  } finally {
    globalThis.module = saved.module;
    globalThis.exports = saved.exports;
  }
};
self.postMessage = (data) => parentPort.postMessage(data);
self.addEventListener = (type, cb) => {
  if (type === 'message') parentPort.on('message', (data) => cb({ data }));
  else if (type === 'error') parentPort.on('error', cb);
};
parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));
`;

const workerCode = shim + '\n' + src;

(async () => {
  const buffer = fs.readFileSync(path.join(__dirname, 'sample.apkg'));
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  const w = new Worker(workerCode, { eval: true, workerData: null });

  const messages = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timed out')), 30000);
    w.on('message', (m) => {
      messages.push(m);
      if (m.type === 'result') { clearTimeout(timer); resolve(m); }
      if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  w.postMessage({ type: 'parse', id: 42, buffer: ab }, [ab]);
  const res = await done;

  assert.strictEqual(res.id, 42, 'echoes request id');
  assert.ok(messages.some((m) => m.type === 'progress' && m.progress > 0), 'progress events');
  assert.strictEqual(res.data.notes.length, 4, '4 notes');
  assert.strictEqual(res.data.cards.length, 5, '5 cards');
  assert.strictEqual(res.data.media.length, 3, '3 media');
  assert.strictEqual(res.data.media[0].bytes.constructor.name, 'Uint8Array', 'bytes transferred');
  assert.strictEqual(res.data.format.version, 1, 'legacy1 format reported');
  assert.ok(res.elapsed >= 0, 'elapsed ms reported');

  // second pass: the modern (2022+) package through the same worker pipeline —
  // exercises fzstd.min.js via importScripts + zstd DB + protobuf media index
  const done2 = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timed out (modern)')), 30000);
    const onMsg = (m) => {
      if (m.type === 'result' && m.id === 43) { clearTimeout(timer); resolve(m); }
      if (m.type === 'error' && m.id === 43) { clearTimeout(timer); reject(new Error(m.message)); }
    };
    w.on('message', onMsg);
  });
  const modernBuf = fs.readFileSync(path.join(__dirname, 'sample-modern.apkg'));
  const modernAb = modernBuf.buffer.slice(modernBuf.byteOffset, modernBuf.byteOffset + modernBuf.byteLength);
  w.postMessage({ type: 'parse', id: 43, buffer: modernAb }, [modernAb]);
  const res2 = await done2;

  assert.strictEqual(res2.id, 43, 'modern: echoes request id');
  assert.strictEqual(res2.data.notes.length, 4, 'modern: 4 notes (dummy anki2 skipped)');
  assert.strictEqual(res2.data.notes[0].modelName, 'Basic+', 'modern: notetype names from schema-18 tables');
  assert.strictEqual(res2.data.notes[0].cards[0].deckName, 'Biology::Cell Division', 'modern: deck names from decks table');
  assert.strictEqual(res2.data.media.length, 3, 'modern: 3 media via protobuf+zstd index');
  assert.strictEqual(res2.data.media.find((m) => m.name === 'note.mp3').bytes.length, 18, 'modern: media zstd-decompressed');
  assert.strictEqual(res2.data.format.version, 3, 'modern: format version 3');
  assert.strictEqual(res2.data.format.compression, 'zstd', 'modern: zstd DB decoded');

  await w.terminate();
  console.log('PASS — worker pipeline (legacy + modern zstd/protobuf, importScripts + transferables) OK in %d ms', Math.round(res.elapsed));
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
