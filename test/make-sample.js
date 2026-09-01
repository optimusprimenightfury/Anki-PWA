#!/usr/bin/env node
/**
 * Builds small but realistic sample packages for local testing — ONE per
 * supported Anki export generation, all carrying the SAME logical content
 * (3 notes, 3 cards, 2 note types, 2 decks, 2 media files):
 *
 *   sample.apkg          Legacy 1 — Anki 2.0:  collection.anki2 (schema 11,
 *                        JSON col.models/decks) + JSON media map +
 *                        collection.media/<name> entries.
 *   sample-legacy2.apkg  Legacy 2 — Anki 2.1:  collection.anki21 (schema 11,
 *                        JSON col) + DUMMY collection.anki2 whose only note
 *                        says "Please update to the latest Anki version…" +
 *                        meta {"version":2}.
 *   sample-modern.apkg   Latest — Anki 2.1.50+/23.x+: collection.anki21b =
 *                        zstd-compressed SQLite schema 18 (real notetypes /
 *                        fields / decks tables) + the same dummy anki2 +
 *                        meta = zstd(protobuf PackageMetadata{version:3}) +
 *                        media = zstd(protobuf MediaEntries) with numbered,
 *                        individually zstd-compressed media payloads.
 *
 * Usage: node test/make-sample.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const initSqlJs = require('/tmp/vendor/node_modules/sql.js/dist/sql-wasm.js');
const { zipSync, strToU8 } = require('/tmp/vendor/node_modules/fflate');

const DIR = __dirname;
const FIELD_SEP = '\u001f';
const DUMMY_MSG = 'Please update to the latest Anki version, then import the .colpkg/.apkg file again';

const zstd = (u8) => new Uint8Array(zlib.zstdCompressSync(Buffer.from(u8)));

/* --------------------------- shared logical content -------------------------- */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="120" height="72">
  <rect width="100" height="60" rx="10" fill="#1b2233"/>
  <circle cx="30" cy="30" r="14" fill="#5b8cff"/>
  <path d="M48 44l8-8 8 8M56 36v14M70 30l6-6 6 6M76 24v16" stroke="#7ef0c8" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const MP3 = new Uint8Array([
  0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x54, 0x41, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00
]);

const MODELS_JSON = {
  '1700000000000': {
    id: 1700000000000, name: 'Basic+',
    flds: [
      { name: 'Front', ord: 0 },
      { name: 'Back', ord: 1 },
      { name: 'Notes', ord: 2 }
    ],
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' }]
  },
  '1700000000001': {
    id: 1700000000001, name: 'Cloze',
    flds: [
      { name: 'Text', ord: 0 },
      { name: 'Extra', ord: 1 }
    ],
    tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<hr>{{Extra}}' }]
  }
};
const DECKS_JSON = {
  '1': { id: 1, name: 'Default', mod: 0, usn: 0, conf: 1 },
  '1700000000002': { id: 1700000000002, name: 'Biology::Cell Division', mod: 0, usn: 0, conf: 1 }
};

const NOTES = [
  { id: 1001, guid: 'a1b2c3d4', mid: 1700000000000, tags: 'physics vector', flds: ['What is the formula for force?', '<b>F = m × a</b><br><img src="einstein.svg">', 'Extra context here.'], mod: 1690000000 },
  { id: 1002, guid: 'e5f6a7b8', mid: 1700000000000, tags: 'physics audio', flds: ['Pronunciation of "mass"', '[sound:note.mp3]', ''], mod: 1689996400 },
  { id: 1003, guid: 'c9d0e1f2', mid: 1700000000001, tags: 'biology', flds: ['Mitosis produces {{c1::two}} daughter {{c2::cells}}', 'Cloze deletion note.'], mod: 1690001800 }
];
const CARDS = [
  { id: 2001, nid: 1001, did: 1700000000002, ord: 0, type: 2, queue: 2, due: 1893456000, ivl: 3, factor: 2500, reps: 3, lapses: 0 },
  { id: 2002, nid: 1002, did: 1700000000002, ord: 0, type: 0, queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0 },
  { id: 2003, nid: 1003, did: 1, ord: 0, type: 1, queue: 1, due: 10, ivl: 0, factor: 0, reps: 0, lapses: 0 }
];

/* ------------------------------ protobuf helpers ----------------------------- */
/* Only what the tests need: anki.import_export.PackageMetadata{version=1 varint}
 * and MediaEntries{entries=1 repeated MediaEntry{name=1 string}}. */

function pbVarint(v) {
  const out = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b += 128;
    out.push(b);
  } while (v > 0);
  return out;
}
function pbTag(field, wt) { return pbVarint(field * 8 + wt); }
function pbLenDelim(field, bytes) {
  return [...pbTag(field, 2), ...pbVarint(bytes.length), ...bytes];
}
function pbVarintField(field, v) {
  return [...pbTag(field, 0), ...pbVarint(v)];
}
function pbStr(s) { return [...strToU8(s)]; }

function packageMetadata(version) {
  return new Uint8Array(pbVarintField(1, version));
}
function mediaEntriesProto(names) {
  const out = [];
  names.forEach((name) => {
    out.push(...pbLenDelim(1, pbLenDelim(1, pbStr(name))));
  });
  return new Uint8Array(out);
}

/* ------------------------------ database builders ---------------------------- */

const NOTES_TABLES = `
CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT NOT NULL, mid INTEGER NOT NULL, mod INTEGER NOT NULL, usn INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL, sfld INTEGER NOT NULL, csum INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL, mod INTEGER NOT NULL, usn INTEGER NOT NULL, type INTEGER NOT NULL, queue INTEGER NOT NULL, due INTEGER NOT NULL, ivl INTEGER NOT NULL, factor INTEGER NOT NULL, reps INTEGER NOT NULL, lapses INTEGER NOT NULL, left INTEGER NOT NULL, odue INTEGER NOT NULL, odid INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE revlog (id INTEGER PRIMARY KEY, cid INTEGER NOT NULL, usn INTEGER NOT NULL, ease INTEGER NOT NULL, ivl INTEGER NOT NULL, lastIvl INTEGER NOT NULL, factor INTEGER NOT NULL, time INTEGER NOT NULL, type INTEGER NOT NULL);
`;

function insertNotesAndCards(db) {
  const stmt = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const n of NOTES) {
    stmt.run([n.id, n.guid, n.mid, n.mod, 0, ' ' + n.tags + ' ', n.flds.join(FIELD_SEP), 0, 0, 0, '']);
  }
  stmt.free();
  const cstmt = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const c of CARDS) {
    cstmt.run([c.id, c.nid, c.did, c.ord, 1690000000, 0, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, 0, 0, 0, 0, '']);
  }
  cstmt.free();
}

/** Legacy schema 11 collection with JSON col.models / col.decks. */
function buildLegacyDb(SQL) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL, scm INTEGER NOT NULL, ver INTEGER NOT NULL, dty INTEGER NOT NULL, usn INTEGER NOT NULL, ls INTEGER NOT NULL, conf TEXT NOT NULL, models TEXT NOT NULL, decks TEXT NOT NULL, dconf TEXT NOT NULL, tags TEXT NOT NULL); ${NOTES_TABLES}`);
  const now = 1690000000;
  db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
    now, now, now,
    JSON.stringify({ activeDecks: [1] }),
    JSON.stringify(MODELS_JSON),
    JSON.stringify(DECKS_JSON),
    JSON.stringify({ 1: {} }),
    '{}'
  ]);
  insertNotesAndCards(db);
  return db;
}

/** The decoy DB modern exports ship for old clients — one warning note only. */
function buildDummyDb(SQL) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL, scm INTEGER NOT NULL, ver INTEGER NOT NULL, dty INTEGER NOT NULL, usn INTEGER NOT NULL, ls INTEGER NOT NULL, conf TEXT NOT NULL, models TEXT NOT NULL, decks TEXT NOT NULL, dconf TEXT NOT NULL, tags TEXT NOT NULL); ${NOTES_TABLES}`);
  const now = 1690000000;
  db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
    now, now, now, '{}',
    JSON.stringify({}),
    JSON.stringify({ 1: { id: 1, name: 'Default' } }),
    '{}', '{}'
  ]);
  const stmt = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  stmt.run([42, 'deadbeef', 1, now, 0, ' ', DUMMY_MSG + '\u001f' + DUMMY_MSG, 0, 0, 0, '']);
  stmt.free();
  const cstmt = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  cstmt.run([43, 42, 1, 0, now, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '']);
  cstmt.free();
  return db;
}

/** Modern schema 18 collection: notetypes/fields/templates/decks tables. */
function buildModernDb(SQL) {
  const db = new SQL.Database();
  db.run(`
CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL, scm INTEGER NOT NULL, ver INTEGER NOT NULL, dty INTEGER NOT NULL, usn INTEGER NOT NULL, ls INTEGER NOT NULL, conf BLOB NOT NULL, models BLOB NOT NULL, decks BLOB NOT NULL, dconf BLOB NOT NULL, tags BLOB NOT NULL);
${NOTES_TABLES}
CREATE TABLE graves (oid INTEGER NOT NULL, type INTEGER NOT NULL, usn INTEGER NOT NULL, PRIMARY KEY (oid, type)) WITHOUT ROWID;
CREATE TABLE notetypes (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, config BLOB NOT NULL);
CREATE TABLE fields (ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL, config BLOB NOT NULL, PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
CREATE TABLE templates (ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL, mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, config BLOB NOT NULL, PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
CREATE TABLE decks (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, common BLOB NOT NULL, kind BLOB NOT NULL);
`);
  const now = 1690000000;
  // protobuf blobs are opaque to the inspector — empty messages are valid
  db.run('INSERT INTO col VALUES (1, ?, ?, ?, 18, 0, 0, 0, ?, ?, ?, ?, ?)', [now, now, now, new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)]);

  Object.keys(MODELS_JSON).forEach((k) => {
    const m = MODELS_JSON[k];
    db.run('INSERT INTO notetypes VALUES (?,?,?,?,?)', [m.id, m.name, now, 0, new Uint8Array(0)]);
    m.tmpls.forEach((t, ti) => {
      db.run('INSERT INTO templates VALUES (?,?,?,?,?,?)', [m.id, ti, t.name, now, 0, new Uint8Array(0)]);
    });
    m.flds.forEach((f, fi) => {
      db.run('INSERT INTO fields VALUES (?,?,?,?)', [m.id, fi, f.name, new Uint8Array(0)]);
    });
  });
  Object.keys(DECKS_JSON).forEach((k) => {
    const d = DECKS_JSON[k];
    db.run('INSERT INTO decks VALUES (?,?,?,?,?,?)', [d.id, d.name, now, 0, new Uint8Array(0), new Uint8Array(0)]);
  });
  insertNotesAndCards(db);
  return db;
}

/* --------------------------------- packages ---------------------------------- */

async function main() {
  const SQL = await initSqlJs();

  // 1) Legacy 1 — Anki 2.0
  const legacyDb = buildLegacyDb(SQL);
  const legacyU8 = legacyDb.export();
  legacyDb.close();
  fs.writeFileSync(path.join(DIR, 'sample.apkg'), zipSync({
    'collection.anki2': legacyU8,
    'media': strToU8(JSON.stringify({ 0: 'einstein.svg', 1: 'note.mp3' })),
    'collection.media/einstein.svg': strToU8(SVG),
    'collection.media/note.mp3': MP3
  }, { level: 6 }));
  console.log('Wrote sample.apkg (legacy 1 — Anki 2.0)');

  // 2) Legacy 2 — Anki 2.1: anki21 + dummy anki2 + meta {"version":2}
  const l2real = buildLegacyDb(SQL);
  const l2bytes = l2real.export();
  l2real.close();
  const l2dummy = buildDummyDb(SQL);
  const l2dummyBytes = l2dummy.export();
  l2dummy.close();
  fs.writeFileSync(path.join(DIR, 'sample-legacy2.apkg'), zipSync({
    'collection.anki21': l2bytes,
    'collection.anki2': l2dummyBytes,
    'meta': strToU8(JSON.stringify({ version: 2 })),
    'media': strToU8(JSON.stringify({ 0: 'einstein.svg', 1: 'note.mp3' })),
    '0': strToU8(SVG),
    '1': MP3
  }, { level: 6 }));
  console.log('Wrote sample-legacy2.apkg (legacy 2 — Anki 2.1, numbered media)');

  // 3) Latest — Anki 2.1.50+: zstd(anki21b) + dummy + zstd(proto meta) +
  //    zstd(proto media index) + individually zstd-compressed media payloads
  const modReal = buildModernDb(SQL);
  const modBytes = modReal.export();
  modReal.close();
  const modDummy = buildDummyDb(SQL);
  const modDummyBytes = modDummy.export();
  modDummy.close();
  fs.writeFileSync(path.join(DIR, 'sample-modern.apkg'), zipSync({
    'collection.anki21b': zstd(modBytes),
    'collection.anki2': modDummyBytes,
    'meta': zstd(packageMetadata(3)),
    'media': zstd(mediaEntriesProto(['einstein.svg', 'note.mp3'])),
    '0': zstd(strToU8(SVG)),
    '1': zstd(MP3)
  }, { level: 0 })); // modern exports store entries (payloads carry compression)
  console.log('Wrote sample-modern.apkg (latest — Anki 2022+, zstd + protobuf)');
}

main().catch((e) => { console.error(e); process.exit(1); });
