#!/usr/bin/env node
/**
 * Builds a small but realistic .apkg file for local testing:
 *   - collection.anki2 (SQLite via sql.js) with notes, cards, col models/decks
 *   - media JSON mapping "0" -> "einstein.svg", "1" -> "note.mp3"
 *   - collection.media/einstein.svg, collection.media/note.mp3
 *
 * Usage: node test/make-sample.js [out.apkg]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('/tmp/vendor/node_modules/sql.js/dist/sql-wasm.js');
const { zipSync, strToU8 } = require('/tmp/vendor/node_modules/fflate');

const OUT = process.argv[2] || path.join(__dirname, 'sample.apkg');
const FIELD_SEP = '\u001f';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="120" height="72">
  <rect width="100" height="60" rx="10" fill="#1b2233"/>
  <circle cx="30" cy="30" r="14" fill="#5b8cff"/>
  <path d="M48 44l8-8 8 8M56 36v14M70 30l6-6 6 6M76 24v16" stroke="#7ef0c8" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run('CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL, scm INTEGER NOT NULL, ver INTEGER NOT NULL, dty INTEGER NOT NULL, usn INTEGER NOT NULL, ls INTEGER NOT NULL, conf TEXT NOT NULL, models TEXT NOT NULL, decks TEXT NOT NULL, dconf TEXT NOT NULL, tags TEXT NOT NULL)');
  db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT NOT NULL, mid INTEGER NOT NULL, mod INTEGER NOT NULL, usn INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL, sfld INTEGER NOT NULL, csum INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL)');
  db.run('CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL, mod INTEGER NOT NULL, usn INTEGER NOT NULL, type INTEGER NOT NULL, queue INTEGER NOT NULL, due INTEGER NOT NULL, ivl INTEGER NOT NULL, factor INTEGER NOT NULL, reps INTEGER NOT NULL, lapses INTEGER NOT NULL, left INTEGER NOT NULL, odue INTEGER NOT NULL, odid INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL)');
  db.run('CREATE TABLE revlog (id INTEGER PRIMARY KEY, cid INTEGER NOT NULL, usn INTEGER NOT NULL, ease INTEGER NOT NULL, ivl INTEGER NOT NULL, lastIvl INTEGER NOT NULL, factor INTEGER NOT NULL, time INTEGER NOT NULL, type INTEGER NOT NULL)');

  const models = {
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
  const decks = {
    '1': { id: 1, name: 'Default', mod: 0, usn: 0, conf: 1 },
    '1700000000002': { id: 1700000000002, name: 'Biology::Cell Division', mod: 0, usn: 0, conf: 1 }
  };

  const now = Math.floor(Date.now() / 1000);
  db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)',
    [now, now, now, JSON.stringify({ activeDecks: [1] }), JSON.stringify(models), JSON.stringify(decks), JSON.stringify({ 1: {} }), '{}']);

  const notes = [
    { id: 1001, guid: 'a1b2c3d4', mid: 1700000000000, tags: 'physics vector', flds: ['What is the formula for force?', '<b>F = m × a</b><br><img src="einstein.svg">', 'Extra context here.'], mod: now - 3600 },
    { id: 1002, guid: 'e5f6a7b8', mid: 1700000000000, tags: 'physics audio', flds: ['Pronunciation of "mass"', '[sound:note.mp3]', ''], mod: now - 7200 },
    { id: 1003, guid: 'c9d0e1f2', mid: 1700000000001, tags: 'biology', flds: ['Mitosis produces {{c1::two}} daughter {{c2::cells}}', 'Cloze deletion note.'], mod: now - 1800 }
  ];
  const stmt = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const n of notes) {
    stmt.run([n.id, n.guid, n.mid, n.mod, 0, ' ' + n.tags + ' ', n.flds.join(FIELD_SEP), 0, 0, 0, '']);
  }
  stmt.free();

  const cards = [
    { id: 2001, nid: 1001, did: 1700000000002, ord: 0, type: 2, queue: 2, due: now + 86400, ivl: 3, factor: 2500, reps: 3, lapses: 0 },
    { id: 2002, nid: 1002, did: 1700000000002, ord: 0, type: 0, queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0 },
    { id: 2003, nid: 1003, did: 1, ord: 0, type: 1, queue: 1, due: 10, ivl: 0, factor: 0, reps: 0, lapses: 0 }
  ];
  const cstmt = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const c of cards) {
    cstmt.run([c.id, c.nid, c.did, c.ord, now, 0, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, 0, 0, 0, 0, '']);
  }
  cstmt.free();

  const collectionU8 = db.export();
  db.close();

  const media = { 0: 'einstein.svg', 1: 'note.mp3' };

  const zip = zipSync({
    'collection.anki2': collectionU8,
    'media': strToU8(JSON.stringify(media)),
    'collection.media/einstein.svg': strToU8(SVG),
    'collection.media/note.mp3': new Uint8Array([
      0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x54, 0x41, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00
    ])
  }, { level: 6 });

  fs.writeFileSync(OUT, zip);
  console.log('Wrote sample package: ' + OUT + ' (' + zip.length + ' bytes)');
}

main().catch((e) => { console.error(e); process.exit(1); });
