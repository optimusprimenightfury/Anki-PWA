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
  assert.strictEqual(res.data.notes.length, 3, '3 notes');
  assert.strictEqual(res.data.cards.length, 3, '3 cards');
  assert.strictEqual(res.data.media.length, 2, '2 media');
  assert.strictEqual(res.data.media[0].bytes.constructor.name, 'Uint8Array', 'bytes transferred');
  assert.ok(res.elapsed >= 0, 'elapsed ms reported');
  await w.terminate();
  console.log('PASS — worker pipeline (importScripts + transferables) OK in %d ms', Math.round(res.elapsed));
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
