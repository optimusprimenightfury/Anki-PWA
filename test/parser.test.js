#!/usr/bin/env node
/**
 * Node.js test for the parser core (the exact same code the Web Worker runs).
 * Covers ALL supported package generations and asserts they yield the same
 * logical content:
 *   sample.apkg          legacy 1 (Anki 2.0,   collection.anki2,  JSON col)
 *   sample-legacy2.apkg  legacy 2 (Anki 2.1,   collection.anki21 + dummy anki2)
 *   sample-modern.apkg   latest   (Anki 2022+, zstd collection.anki21b,
 *                                  schema 18 tables + protobuf media index)
 *
 * Usage: node test/parser.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const initSqlJs = require('/tmp/vendor/node_modules/sql.js/dist/sql-wasm.js');
const fflate = require('/tmp/vendor/node_modules/fflate');
const fzstd = require('/tmp/vendor/node_modules/fzstd');

// Give the parser its dependencies as globals, then load parser.js.
global.fflate = fflate;
global.initSqlJs = initSqlJs;
global.fzstd = fzstd;
require(path.join(__dirname, '..', 'js', 'parser.js'));

const OPTS = { wasmBase: '/tmp/vendor/node_modules/sql.js/dist/' };

function load(name) {
  const buffer = fs.readFileSync(path.join(__dirname, name));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** Assertions shared by every generation — the same deck, three formats. */
function assertSameDeck(res, label) {
  assert.strictEqual(res.notes.length, 3, label + ': 3 notes (dummy anki2 skipped)');
  res.notes.forEach((n) => {
    assert.ok(!/please update to the latest anki version/i.test(n.fields.join(' ')),
      label + ': dummy warning note must not leak through');
  });

  const n1 = res.notes.find((n) => n.id === 1001);
  assert.ok(n1, label + ': note 1001 present');
  assert.strictEqual(n1.modelName, 'Basic+', label + ': model name resolved');
  assert.deepStrictEqual(n1.fieldNames, ['Front', 'Back', 'Notes'], label + ': field names');
  assert.strictEqual(n1.fields.length, 3, label + ': fields split by \\u001f');
  assert.ok(n1.fields[1].includes('einstein.svg'), label + ': field contains img ref');
  assert.deepStrictEqual(n1.tags, ['physics', 'vector'], label + ': tags');
  assert.strictEqual(n1.cards.length, 1, label + ': note has 1 card');
  assert.strictEqual(n1.cards[0].deckName, 'Biology::Cell Division', label + ': deck name resolved');

  const cloze = res.notes.find((n) => n.id === 1003);
  assert.strictEqual(cloze.modelName, 'Cloze', label + ': cloze model');

  assert.strictEqual(res.cards.length, 3, label + ': 3 cards');
  assert.strictEqual(res.media.length, 2, label + ': 2 media files');

  const svg = res.media.find((m) => m.name === 'einstein.svg');
  assert.ok(svg, label + ': einstein.svg extracted');
  assert.ok(svg.bytes.length > 50, label + ': svg bytes present (decompressed if zstd)');
  const mp3 = res.media.find((m) => m.name === 'note.mp3');
  assert.ok(mp3, label + ': note.mp3 extracted');
  assert.strictEqual(mp3.bytes.length, 18, label + ': mp3 byte length exact');
  assert.strictEqual(mp3.bytes[0], 0x49, label + ': mp3 magic byte');
  return { svg, mp3 };
}

(async () => {
  // --- 1) legacy 1 — Anki 2.0 ------------------------------------------------
  const t0 = Date.now();
  const legacy1 = await AnkiParser.parseApkg(load('sample.apkg'), OPTS);
  const ms = Date.now() - t0;
  assertSameDeck(legacy1, 'legacy1');
  assert.strictEqual(legacy1.format.version, 1, 'legacy1: format version');
  assert.strictEqual(legacy1.format.compression, 'none', 'legacy1: no zstd');
  assert.strictEqual(legacy1.format.mediaKind, 'json', 'legacy1: JSON media map');
  assert.strictEqual(legacy1.media['0'] !== undefined || legacy1.mediaMap['0'] === 'einstein.svg', true, 'legacy1: media map keys');

  // --- 2) legacy 2 — Anki 2.1 (anki21 + dummy anki2) ---------------------------
  const legacy2 = await AnkiParser.parseApkg(load('sample-legacy2.apkg'), OPTS);
  assertSameDeck(legacy2, 'legacy2');
  assert.strictEqual(legacy2.format.version, 2, 'legacy2: format version');
  assert.strictEqual(legacy2.format.metaVersion, 2, 'legacy2: meta {version:2}');
  assert.strictEqual(legacy2.format.dbMember, 'collection.anki21', 'legacy2: anki21 wins over dummy anki2');

  // --- 3) latest — Anki 2022+ (zstd anki21b, schema 18, protobuf media) -------
  const modern = await AnkiParser.parseApkg(load('sample-modern.apkg'), OPTS);
  const modernMedia = assertSameDeck(modern, 'modern');
  assert.strictEqual(modern.format.version, 3, 'modern: format version');
  assert.strictEqual(modern.format.dbMember, 'collection.anki21b', 'modern: anki21b wins');
  assert.strictEqual(modern.format.compression, 'zstd', 'modern: DB zstd-decompressed');
  assert.strictEqual(modern.format.metaVersion, 3, 'modern: protobuf meta version 3');
  assert.strictEqual(modern.format.mediaKind, 'protobuf', 'modern: protobuf media index');
  assert.strictEqual(modern.format.layout, 'tables', 'modern: schema-18 notetypes/fields tables');

  // media bytes must be IDENTICAL across generations
  const legacy1Media = assertSameDeck(legacy1, 'legacy1(recheck)');
  assert.deepStrictEqual(
    Buffer.from(modernMedia.svg.bytes).toString('utf8'),
    Buffer.from(legacy1Media.svg.bytes).toString('utf8'),
    'svg bytes identical across formats'
  );
  assert.deepStrictEqual(Array.from(modernMedia.mp3.bytes), Array.from(legacy1Media.mp3.bytes),
    'mp3 bytes identical across formats');

  // --- 4) protobuf MediaEntries unit test ---------------------------------------
  const pb = fflate.strToU8;
  // hand-built: entries=[{name:"a.jpg"},{name:"b.mp3", legacy_zip_filename:7}]
  function varint(v) { const o = []; do { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b += 128; o.push(b); } while (v > 0); return o; }
  const entry1 = [...varint(1 << 3 | 2), ...varint(5), 97, 46, 106, 112, 103];         // name="a.jpg"
  const nameB = [...pb('b.mp3')];
  const entry2 = [...varint(1 << 3 | 2), ...varint(nameB.length), ...nameB,            // name="b.mp3"
    ...varint(255 << 3 | 0), ...varint(7)];                                            // legacy_zip_filename=7
  const msg = [...varint(1 << 3 | 2), ...varint(entry1.length), ...entry1,
    ...varint(1 << 3 | 2), ...varint(entry2.length), ...entry2];
  const parsed = AnkiParser.parseMediaEntries(new Uint8Array(msg));
  assert.deepStrictEqual(parsed, { '0': 'a.jpg', '7': 'b.mp3' }, 'MediaEntries protobuf decode');

  // --- 5) not-a-package error is friendly ---------------------------------------
  await assert.rejects(
    () => AnkiParser.parseApkg(pb('definitely not a zip file').buffer, OPTS),
    /not look like an Anki package|No Anki collection database found|invalid/i,
    'garbage input rejected with a helpful error'
  );

  console.log('PASS — legacy1 + legacy2 + modern(zstd/protobuf) parsed, byte-identical media, in %d ms', ms);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
