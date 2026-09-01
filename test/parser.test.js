#!/usr/bin/env node
/**
 * Node.js test for the parser core (the exact same code the Web Worker runs).
 * Usage: node test/parser.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const initSqlJs = require('/tmp/vendor/node_modules/sql.js/dist/sql-wasm.js');
const fflate = require('/tmp/vendor/node_modules/fflate');

// Give the parser its two dependencies as globals, then load parser.js.
global.fflate = fflate;
global.initSqlJs = initSqlJs;
require(path.join(__dirname, '..', 'js', 'parser.js'));

(async () => {
  const buffer = fs.readFileSync(path.join(__dirname, 'sample.apkg'));
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  const t0 = Date.now();
  const res = await AnkiParser.parseApkg(ab, { wasmBase: '/tmp/vendor/node_modules/sql.js/dist/' });
  const ms = Date.now() - t0;

  // --- notes -------------------------------------------------------------
  assert.strictEqual(res.notes.length, 3, '3 notes');
  const n1 = res.notes.find((n) => n.id === 1001);
  assert.ok(n1, 'note 1001 present');
  assert.strictEqual(n1.modelName, 'Basic+', 'model name');
  assert.deepStrictEqual(n1.fieldNames, ['Front', 'Back', 'Notes'], 'field names');
  assert.strictEqual(n1.fields.length, 3, 'fields split by \\u001f');
  assert.ok(n1.fields[1].includes('einstein.svg'), 'field contains img ref');
  assert.deepStrictEqual(n1.tags, ['physics', 'vector'], 'tags');
  assert.strictEqual(n1.cards.length, 1, 'note has 1 card');
  assert.strictEqual(n1.cards[0].deckName, 'Biology::Cell Division', 'deck name resolved');

  const cloze = res.notes.find((n) => n.id === 1003);
  assert.strictEqual(cloze.modelName, 'Cloze', 'cloze model');
  assert.strictEqual(cloze.cards[0].deckName, 'Default', 'deck 1 -> Default');

  // --- cards -------------------------------------------------------------
  assert.strictEqual(res.cards.length, 3, '3 cards');

  // --- media -------------------------------------------------------------
  assert.strictEqual(res.media.length, 2, '2 media files');
  const svg = res.media.find((m) => m.name === 'einstein.svg');
  assert.ok(svg, 'einstein.svg extracted');
  assert.strictEqual(svg.key, '0', 'media key mapping');
  assert.ok(svg.bytes.length > 50, 'svg bytes present');
  const mp3 = res.media.find((m) => m.name === 'note.mp3');
  assert.ok(mp3 && mp3.key === '1', 'note.mp3 extracted + key');

  // --- helpers -----------------------------------------------------------
  const compact = AnkiParser.compactHtml('<p>Hello <b>world</b></p><br><br><p><img src="x.jpg"></p>');
  assert.strictEqual(compact, 'Hello <b>world</b> <img src="x.jpg">', 'compactHtml collapses tags');
  assert.ok(AnkiParser.compactHtml('<script>alert(1)</script>ok').indexOf('script') === -1, 'scripts stripped');
  assert.strictEqual(AnkiParser.htmlToText('<p>a<b>b</b> c</p>'), 'ab c', 'htmlToText');

  console.log('PASS — parsed %d notes, %d cards, %d media in %d ms',
    res.notes.length, res.cards.length, res.media.length, ms);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
