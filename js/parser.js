/*!
 * AnkiParser — pure parsing core for .apkg / .colpkg inspection.
 *
 * Environment-agnostic: it runs inside a Web Worker (via importScripts) and in
 * Node.js (for tests). It depends on these globals:
 *   - `fflate`     (UMD build, https://github.com/101arrowz/fflate) — required
 *   - `initSqlJs`  (sql.js / WASM SQLite, https://sql.js.org)        — required
 *   - `fzstd`      (UMD build, https://github.com/101arrowz/fzstd)  — only
 *                   needed for modern (2022+) packages; a clear error is
 *                   thrown if one shows up without it
 *
 * SUPPORTED PACKAGE GENERATIONS (all fully read, no Anki re-export needed):
 *   1. Legacy 1  — Anki 2.0:    collection.anki2   (schema 11, JSON col,
 *                                deflate zip, JSON media map)
 *   2. Legacy 2  — Anki 2.1:    collection.anki21  (schema 11, JSON col) plus
 *                                a DUMMY collection.anki2 whose only note says
 *                                "Please update to the latest Anki version…"
 *                                (we skip the dummy automatically)
 *   3. Latest    — Anki 2.1.50+ / 23.x+: collection.anki21b — a zstd-
 *                                compressed SQLite DB with schema 18 (real
 *                                notetypes/fields/decks tables, protobuf
 *                                blobs we don't need), a zstd+protobuf
 *                                MediaEntries media map and zstd-compressed
 *                                media payloads.
 * The parse pipeline:
 *   1. fflate.unzipSync  -> decompress the archive in memory
 *   2. pick + decode DB  -> newest collection.* member, zstd-decode if needed
 *   3. sql.js WASM       -> open the collection, read notes/cards/notetypes
 *   4. media             -> JSON map (legacy) or protobuf+zstd map (modern),
 *                           map archive entries to real filenames + bytes
 */
(function (global) {
  'use strict';

  var FIELD_SEP = '\u001f'; // Anki separates note fields with the Unit Separator
  var MEDIA_PREFIX = 'collection.media/'; // Anki 2.1+ stores media under this zip dir

  /* Newer generation first — a modern export also contains a dummy
   * collection.anki2 whose single note just says "Please update to the latest
   * Anki version…", so anki2 must only be used when nothing newer exists. */
  var DB_CANDIDATES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];
  var DUMMY_NOTE_RE = /please update to the latest anki version/i;

  /* ---------------------------------- utils --------------------------------- */

  var textDecoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;

  /** Decode UTF-8 bytes; manual fallback where TextDecoder is unavailable. */
  function utf8(bytes) {
    if (textDecoder) return textDecoder.decode(bytes);
    var out = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i];
      if (b < 0x80) {
        out += String.fromCharCode(b); i += 1;
      } else if (b < 0xe0) {
        out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2;
      } else if (b < 0xf0) {
        out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3;
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4;
      }
    }
    return out;
  }

  function isSQLite(u8) {
    // every SQLite 3 file starts with the 15-byte string "SQLite format 3"
    // followed by a NUL terminator
    return u8 && u8.length > 16 && utf8(u8.subarray(0, 15)) === 'SQLite format 3';
  }

  function isZstd(u8) {
    return u8 && u8.length > 4 &&
      u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd;
  }

  /** Decompress a zstd frame; throws a helpful error when fzstd is absent. */
  function zstdDecompress(u8, what) {
    if (typeof fzstd === 'undefined' || !fzstd.decompress) {
      throw new Error(
        'This package uses zstd compression (' + what + ') but the decoder ' +
        'is not loaded. Reload the app once — the update that adds it may ' +
        'still be arriving.');
    }
    return fzstd.decompress(u8);
  }

  function findKey(map, filename) {
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (map[keys[i]] === filename) return keys[i];
    }
    return null;
  }

  function report(onProgress, progress, text) {
    if (onProgress) {
      try { onProgress(progress, text); } catch (e) { /* ignore */ }
    }
  }

  /* --------------------- minimal protobuf reader (wire format) --------------- */

  /**
   * Iterate the fields of one protobuf message.
   * cb(fieldNumber, wireType, value) where value is a Number (varint),
   * Uint8Array (length-delimited) or fixed 32/64-bit Number.
   */
  function pbFields(u8, from, to, cb) {
    var pos = from;
    function varint() {
      var result = 0, shift = 0, b;
      do {
        if (pos >= to) throw new Error('protobuf truncated');
        b = u8[pos++];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
      } while (b & 0x80);
      return result;
    }
    while (pos < to) {
      var tag = varint();
      var field = Math.floor(tag / 8);
      var wt = tag % 8;
      if (wt === 0) {
        cb(field, wt, varint());
      } else if (wt === 1) {
        pos += 8;
      } else if (wt === 2) {
        var len = varint();
        if (pos + len > to) throw new Error('protobuf truncated');
        cb(field, wt, u8.subarray(pos, pos + len));
        pos += len;
      } else if (wt === 5) {
        pos += 4;
      } else {
        throw new Error('protobuf: unsupported wire type ' + wt);
      }
    }
  }

  /**
   * anki.import_export.MediaEntries:
   *   message MediaEntries { repeated MediaEntry entries = 1; }
   *   message MediaEntry {
   *     string name = 1; uint32 size = 2; bytes sha1 = 3;
   *     optional uint32 legacy_zip_filename = 255; }
   * Returns { zipEntryName -> realFilename }.
   */
  function parseMediaEntries(u8) {
    var map = {};
    var index = 0;
    pbFields(u8, 0, u8.length, function (field, wt, value) {
      if (field !== 1 || wt !== 2) return; // entries
      var name = null;
      var legacyZip = null;
      pbFields(value, 0, value.length, function (f, w, v) {
        if (f === 1 && w === 2) name = utf8(v);
        else if (f === 255 && w === 0) legacyZip = v;
      });
      if (name != null) {
        map[String(legacyZip != null ? legacyZip : index)] = name;
      }
      index++;
    });
    return map;
  }

  /* ------------------------------- HTML helpers ------------------------------ */

  var SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/>|<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<object\b[^>]*>[\s\S]*?<\/object\s*>|<embed\b[^>]*\/?>/gi;
  var EVENT_RE = /\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  var JSURL_RE = /\b(?:href|src)\s*=\s*(["'])\s*javascript:[^"']*\1/gi;
  var BR_RE = /<br\s*\/?>/gi;
  var P_RE = /<\/?p[^>]*>/gi;
  var DIV_RE = /<\/?div[^>]*>/gi;
  var LI_RE = /<\/li\s*>/gi;
  var WS_RE = /\s+/g;

  /** Remove active content (scripts, iframes, event handlers, javascript: URLs). */
  function sanitizeHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(SCRIPT_RE, '')
      .replace(EVENT_RE, '')
      .replace(JSURL_RE, '');
  }

  /**
   * Compact single-line view: strips excessive <br> / <p> / <div> noise into
   * inline spaces but preserves formatting tags and inline SVGs.
   */
  function compactHtml(html) {
    return sanitizeHtml(html)
      .replace(BR_RE, ' ')
      .replace(P_RE, ' ')
      .replace(DIV_RE, ' ')
      .replace(LI_RE, ' · ')
      .replace(WS_RE, ' ')
      .trim();
  }

  /** Expanded view: collapse runs of <br> into one, keep paragraph rhythm. */
  function richHtml(html) {
    return sanitizeHtml(html)
      .replace(/(<br\s*\/?>\s*){2,}/gi, '<br>')
      .replace(P_RE, '<br>')
      .replace(DIV_RE, '<br>')
      .replace(WS_RE, ' ')
      .trim();
  }

  /** Plain searchable text of an HTML fragment. */
  function htmlToText(html) {
    if (typeof DOMParser !== 'undefined') {
      var doc = new DOMParser().parseFromString(String(html), 'text/html');
      return (doc.body.textContent || '').replace(WS_RE, ' ').trim();
    }
    return String(html).replace(/<[^>]+>/g, '').replace(WS_RE, ' ').trim();
  }

  /* ------------------------ image occlusion notes ---------------------------- */

  /*
   * Anki 23.10+/AnkiDroid 2.20+ "Image Occlusion" notes keep the base image in
   * one field and the masks in an "Occlusions" field as CLOZE-WRAPPED text
   * tokens (this is the exact grammar of Anki's own imageocclusion.rs):
   *
   *   {{c1::rect:left=.2325:top=.3261:width=.202:height=.0975:oi=1}}
   *   {{c2::ellipse:left=.55:top=.5:rx=.12:ry=.18}}
   *   {{c1::polygon:points=.1,.8 .35,.95 .15,1}}
   *   {{c3::text:text=Label\:x:left=.05:top=.05:fs=24}}
   *
   * All coordinates are NORMALIZED (0..1) fractions of the image size, so they
   * can be drawn over the image at any rendered size. `angle` is stored in
   * 1/10000-of-a-turn steps (360deg = 10000). The legacy "Image Occlusion
   * Enhanced" add-on instead stores literal <svg> markup with pixel geometry.
   */

  var OCCLUSION_CLOZE_RE = /\{\{c(\d+)::\s*([^\}]*(?:\}(?!\})[^\}]*)*)\}\}/gi;
  var OCCLUSION_BARE_RE = /(?:^|[\s>])((?:rect|ellipse|polygon|text):(?:[^\s<>]|\\ )*)/gi;
  var OCCLUSION_SHAPE_KINDS = { rect: 1, ellipse: 1, polygon: 1, text: 1 };

  /** Split "a:1:b:2" on ':' honouring Anki's `\:` and `\\` escapes. */
  function splitEscaped(str) {
    var parts = [], cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === '\\' && (str.charAt(i + 1) === ':' || str.charAt(i + 1) === '\\')) {
        cur += str.charAt(i + 1);
        i += 1;
      } else if (ch === ':') {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    return parts;
  }

  /** "rect:left=.2:top=.3" -> { shape:'rect', props:{left:'.2', top:'.3'} } */
  function parseOcclusionToken(token) {
    var idx = token.indexOf(':');
    if (idx < 1) return null;
    var shape = token.slice(0, idx).trim().toLowerCase();
    if (!OCCLUSION_SHAPE_KINDS[shape]) return null;
    var props = {};
    splitEscaped(token.slice(idx + 1)).forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq < 1) return;
      props[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    });
    return { shape: shape, props: props };
  }

  /**
   * Parse an Occlusions field into shape records:
   *   [{ shape:'rect'|'ellipse'|'polygon'|'text', ordinal:<cloze n>, props:{} }]
   * Tokens wrapped in {{cN::…}} carry that cloze ordinal; bare tokens get 0.
   */
  function parseOcclusionShapes(text) {
    if (!text) return [];
    var src = String(text)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    var shapes = [];
    var rest = src.replace(OCCLUSION_CLOZE_RE, function (whole, ord, body) {
      var rec = parseOcclusionToken(String(body).trim());
      if (rec) { rec.ordinal = parseInt(ord, 10) || 0; shapes.push(rec); }
      return ' ';
    });
    rest.replace(OCCLUSION_BARE_RE, function (whole, token) {
      var rec = parseOcclusionToken(token);
      if (rec) { rec.ordinal = 0; shapes.push(rec); }
      return ' ';
    });
    return shapes;
  }

  /** Is this bare text distinctive enough to be an Occlusions field? */
  function looksLikeOcclusionText(field) {
    var f = String(field || '');
    if (/\{\{c\d+::\s*(?:rect|ellipse|polygon|text):/i.test(f)) return true;
    OCCLUSION_BARE_RE.lastIndex = 0;
    var bare = f.replace(/<[^>]+>/g, ' ').match(OCCLUSION_BARE_RE);
    return !!(bare && bare.length >= 2);
  }

  /**
   * Detect an image-occlusion note and locate its fields.
   * Returns null, or:
   *   { kind:'cloze', image:<field idx>, occlusions:<field idx> }   (modern)
   *   { kind:'svg',   image:<field idx>, occlusions:<field idx> }   (IO Enhanced)
   *   { kind:'cloze', image:<field idx>, occlusions:-1 }            (name says IO
   *    but the mask field is empty/unrecognised — still worth the preview)
   */
  function detectImageOcclusion(fields, fieldNames, modelName) {
    if (!fields || !fields.length) return null;
    var occlIdx = -1, imgIdx = -1, svgIdx = -1;
    for (var i = 0; i < fields.length; i++) {
      var f = String(fields[i] == null ? '' : fields[i]);
      if (imgIdx === -1 && /<img\b/i.test(f)) imgIdx = i;
      if (svgIdx === -1 && /<svg\b/i.test(f)) svgIdx = i;
      if (occlIdx === -1 && looksLikeOcclusionText(f)) occlIdx = i;
    }
    var names = fieldNames || [];
    var nameHint = /occlusion/i.test(modelName || '') ||
      names.some(function (n) { return /occlusion/i.test(n || ''); });

    if (occlIdx !== -1 && imgIdx !== -1 && occlIdx !== imgIdx) {
      return { kind: 'cloze', image: imgIdx, occlusions: occlIdx };
    }
    if (svgIdx !== -1 && imgIdx !== -1 && svgIdx !== imgIdx) {
      return { kind: 'svg', image: imgIdx, occlusions: svgIdx };
    }
    if (nameHint && imgIdx !== -1) {
      var byName = -1;
      for (var j = 0; j < names.length; j++) {
        if (/occlusion/i.test(names[j] || '')) { byName = j; break; }
      }
      return { kind: 'cloze', image: imgIdx, occlusions: byName };
    }
    return null;
  }

  /* --------------------------- collection detection -------------------------- */

  /**
   * Pick the best collection member: newest generation present wins, so the
   * dummy anki2 shipped inside modern exports is never accidentally used.
   */
  function pickCollection(files) {
    for (var i = 0; i < DB_CANDIDATES.length; i++) {
      if (files[DB_CANDIDATES[i]]) {
        return { name: DB_CANDIDATES[i], bytes: files[DB_CANDIDATES[i]] };
      }
    }
    // Belt & braces: some exporters rename the DB (e.g. "collection.anki2_bak").
    var names = Object.keys(files);
    for (var j = 0; j < names.length; j++) {
      if (/^collection\./i.test(names[j]) && !/\.media\b/i.test(names[j])) {
        return { name: names[j], bytes: files[names[j]] };
      }
    }
    var sample = names.slice(0, 8).join(', ') || '(empty archive)';
    throw new Error(
      'No Anki collection database found — this does not look like an ' +
      '.apkg / .colpkg package. Archive contains: ' + sample);
  }

  /** Decode the DB member: plain SQLite, or zstd frame -> SQLite. */
  function decodeCollection(coll) {
    if (isSQLite(coll.bytes)) {
      return { bytes: coll.bytes, compression: 'none' };
    }
    if (isZstd(coll.bytes)) {
      var plain = zstdDecompress(coll.bytes, coll.name);
      if (!isSQLite(plain)) {
        throw new Error(coll.name + ' did not decompress to a SQLite database.');
      }
      return { bytes: plain, compression: 'zstd' };
    }
    throw new Error(
      coll.name + ' is neither a SQLite database nor zstd-compressed data — ' +
      'the package may be corrupted.');
  }

  /**
   * Optional `meta` member (legacy 2+: JSON {"version":2}, latest: zstd +
   * protobuf PackageMetadata{version=3}). Used for labelling only.
   */
  function readMetaVersion(files) {
    var raw = files['meta'];
    if (!raw) return null;
    try {
      var text = utf8(raw).trim();
      if (text.charAt(0) === '{') {
        var m = JSON.parse(text);
        return m && m.version != null ? m.version : null;
      }
    } catch (e) { /* not JSON — probably protobuf */ }
    try {
      var bytes = isZstd(raw) ? zstdDecompress(raw, 'meta') : raw;
      var version = null;
      pbFields(bytes, 0, bytes.length, function (f, w, v) {
        if (f === 1 && w === 0 && version == null) version = v;
      });
      return version;
    } catch (e) { return null; }
  }

  /* ------------------------------ the DB readers ----------------------------- */

  function tableNames(db) {
    var out = [];
    try {
      var res = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
      if (res.length) {
        res[0].values.forEach(function (r) { out.push(String(r[0])); });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /**
   * Note types (models) + decks, across both layouts:
   *  - schema 11 (legacy): JSON blobs in the `col` table
   *  - schema 15+ (modern): real `notetypes` / `fields` / `decks` tables
   *    (names are plain columns — the protobuf config blobs hold styling we
   *    don't need for inspection)
   */
  function readModelsAndDecks(db) {
    var models = {};
    var decks = {};
    var layout = 'col-json';

    var tables = tableNames(db);

    if (tables.indexOf('notetypes') !== -1 && tables.indexOf('fields') !== -1) {
      try {
        var ntRes = db.exec('SELECT id, name FROM notetypes');
        var fldRes = db.exec('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord');
        var byMid = {};
        if (fldRes.length) {
          fldRes[0].values.forEach(function (r) {
            var mid = String(r[0]);
            (byMid[mid] = byMid[mid] || []).push({ name: String(r[2]), ord: r[1] });
          });
        }
        if (ntRes.length && ntRes[0].values.length) {
          ntRes[0].values.forEach(function (r) {
            var mid = String(r[0]);
            models[mid] = { id: r[0], name: String(r[1] || ('Note type ' + r[0])), flds: byMid[mid] || [] };
          });
          layout = 'tables';
        }
      } catch (e) { /* fall back to col JSON below */ }
    }

    if (tables.indexOf('decks') !== -1) {
      try {
        var dkRes = db.exec('SELECT id, name FROM decks');
        if (dkRes.length && dkRes[0].values.length) {
          decks = {};
          dkRes[0].values.forEach(function (r) {
            decks[String(r[0])] = { id: r[0], name: String(r[1] || 'Default') };
          });
        }
      } catch (e) { /* keep col decks */ }
    }

    if (!Object.keys(models).length || !Object.keys(decks).length) {
      // legacy schema 11: models/decks are JSON strings inside col
      try {
        var colRes = db.exec('SELECT models, decks FROM col LIMIT 1');
        if (colRes.length && colRes[0].values.length) {
          if (!Object.keys(models).length) {
            models = JSON.parse(colRes[0].values[0][0] || '{}') || {};
            if (Object.keys(models).length) layout = 'col-json';
          }
          if (!Object.keys(decks).length) {
            decks = JSON.parse(colRes[0].values[0][1] || '{}') || {};
          }
        }
      } catch (e) { /* corrupt metadata — degrade gracefully */ }
    }

    return { models: models, decks: decks, layout: layout };
  }

  /* -------------------------------- the parser -------------------------------- */

  /**
   * @param {ArrayBuffer} arrayBuffer - raw .apkg / .colpkg bytes
   * @param {Object} [opts]
   * @param {Function} [opts.onProgress]  (progress:0..1, text)
   * @param {string} [opts.wasmBase]      URL prefix for sql-wasm.wasm (default 'js/')
   * @returns {Promise<{notes:Array, cards:Array, models:Object, decks:Object,
   *                    media:Array, mediaMap:Object, format:Object}>}
   */
  async function parseApkg(arrayBuffer, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || null;
    var wasmBase = opts.wasmBase != null ? opts.wasmBase : 'js/';

    report(onProgress, 0.03, 'Decompressing archive…');

    // 1) in-memory unzip (fastest option; runs on the worker thread)
    var files = fflate.unzipSync(new Uint8Array(arrayBuffer));
    report(onProgress, 0.25, 'Archive decompressed — locating collection…');

    // 2) pick the newest collection member + decode (zstd if needed)
    var coll = pickCollection(files);
    var decoded = decodeCollection(coll);
    var metaVersion = readMetaVersion(files);

    var format = {
      dbMember: coll.name,
      compression: decoded.compression,
      metaVersion: metaVersion,
      // label resolved after reading the schema; Anki's own naming:
      // 1 = legacy 1 (anki2), 2 = legacy 2 (anki21), 3 = latest (anki21b)
      version: coll.name === 'collection.anki21b' ? 3
        : (coll.name === 'collection.anki21' ? 2 : 1)
    };

    // 3) WASM SQLite
    var SQL = await initSqlJs({ locateFile: function (f) { return wasmBase + f; } });
    var db = new SQL.Database(decoded.bytes);
    report(onProgress, 0.5, 'Querying notes & cards…');

    // 3a) collection metadata: note types (models) and decks
    var md = readModelsAndDecks(db);
    var models = md.models;
    var decks = md.decks;
    format.layout = md.layout;
    format.label = format.version === 3 ? 'Anki 2022+ (anki21b)'
      : format.version === 2 ? 'Anki 2.1 (anki21)'
        : 'Anki 2.0 legacy (anki2)';

    var noteRes = db.exec(
      'SELECT id, mid, flds, sfld, tags, mod FROM notes ORDER BY id'
    );
    var cardRes = db.exec(
      'SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses ' +
      'FROM cards ORDER BY nid, ord'
    );

    // 3b) notes
    var notes = [];
    var noteMap = {};
    var rows = noteRes.length ? noteRes[0].values : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var mid = r[1];
      var model = models[String(mid)] || {};
      var fieldNames = (model.flds || []).map(function (f) { return f.name; });
      var rawFields = String(r[2] == null ? '' : r[2]).split(FIELD_SEP);
      // pad names for notes whose model metadata is unavailable
      while (fieldNames.length < rawFields.length) {
        fieldNames.push('Field ' + (fieldNames.length + 1));
      }
      var note = {
        id: r[0],
        mid: mid,
        modelName: model.name || ('Note type ' + mid),
        fieldNames: fieldNames,
        fields: rawFields,
        sfld: String(r[3] == null ? '' : r[3]),
        tags: String(r[4] == null ? '' : r[4]).split(/\s+/).filter(Boolean),
        mod: r[5],
        cards: []
      };
      notes.push(note);
      noteMap[note.id] = note;
    }

    // 3c) cards + deck names
    var cards = [];
    var crows = cardRes.length ? cardRes[0].values : [];
    for (var j = 0; j < crows.length; j++) {
      var c = crows[j];
      var deck = decks[String(c[2])] || {};
      var card = {
        id: c[0], nid: c[1], did: c[2],
        deckName: deck.name || 'Default',
        ord: c[3], type: c[4], queue: c[5], due: c[6], ivl: c[7],
        factor: c[8], reps: c[9], lapses: c[10]
      };
      cards.push(card);
      var owner = noteMap[card.nid];
      if (owner) owner.cards.push(card);
    }

    db.close();

    // 3d) guard: a lone dummy note means we somehow read the placeholder DB
    // inside a modern export (should not happen — newest member wins — but the
    // error must be actionable if it ever does).
    if (notes.length === 1 && DUMMY_NOTE_RE.test(notes[0].fields.join(' '))) {
      throw new Error(
        'This package only contains Anki\'s placeholder note ' +
        '("Please update to the latest Anki version…"). It was exported in a ' +
        'newer format that this copy of the app cannot read — reload the app ' +
        'to pick up the latest version and share the file again.');
    }

    // 4) media mapping
    //    legacy: `media` JSON  {"0": "einstein.svg", ...}
    //    latest: `media` = zstd + protobuf MediaEntries; entries themselves
    //            are zstd-compressed payloads under numbered zip members
    report(onProgress, 0.74, 'Mapping media files…');
    var mediaMap = {};
    var mediaKind = 'none';
    var rawMedia = files['media'] || files['_media'] || files['media.json'];
    if (rawMedia) {
      var asJson = null;
      try {
        var text = utf8(rawMedia);
        if (text.trim().charAt(0) === '{') asJson = JSON.parse(text);
      } catch (e) { /* protobuf then */ }
      if (asJson && typeof asJson === 'object') {
        mediaMap = asJson;
        mediaKind = 'json';
      } else {
        try {
          var pbBytes = isZstd(rawMedia) ? zstdDecompress(rawMedia, 'media index') : rawMedia;
          mediaMap = parseMediaEntries(pbBytes);
          mediaKind = 'protobuf';
        } catch (e) {
          mediaMap = {};
        }
      }
    }
    format.mediaKind = mediaKind;

    var referenced = {};
    Object.keys(mediaMap).forEach(function (k) { referenced[mediaMap[k]] = true; });

    var media = [];
    var seen = {};
    Object.keys(files).forEach(function (name) {
      var base = name;
      if (base.indexOf(MEDIA_PREFIX) === 0) base = base.slice(MEDIA_PREFIX.length);
      if (base === 'collection.anki2' || base === 'collection.anki21' ||
        base === 'collection.anki21b' || base === 'media' ||
        base === 'media.json' || base === 'meta' || base === '_media') return;
      if (name.charAt(0) === '_' && name !== '_media') return;      // zip metadata junk

      // When a mapping exists, only include mapped entries; otherwise (no
      // media index at all) keep any real-looking file.
      var mappedName = null;
      if (Object.keys(mediaMap).length) {
        if (mediaMap[base]) mappedName = mediaMap[base];            // "0" -> real name
        else if (referenced[base] && !Object.keys(mediaMap).some(function (k) { return k === base; })) {
          mappedName = base;                                        // already a real name
        } else {
          return;                                                   // unreferenced junk
        }
      } else {
        if (/\.(jpe?g|png|gif|webp|svg|bmp|avif|mp3|ogg|opus|wav|m4a|aac|flac|webm|mp4|m4v|pdf)$/i.test(base)) {
          mappedName = base;
        } else {
          return;
        }
      }
      if (seen[mappedName]) return;
      seen[mappedName] = true;

      var bytes = files[name];
      if (isZstd(bytes)) bytes = zstdDecompress(bytes, 'media ' + base);
      media.push({ name: mappedName, key: findKey(mediaMap, mappedName) || base, bytes: bytes });
    });

    report(onProgress, 0.88, 'Assembling note list…');
    report(onProgress, 1, 'Done');

    return {
      notes: notes, cards: cards, models: models, decks: decks,
      media: media, mediaMap: mediaMap, format: format
    };
  }

  /* --------------------------------- exports -------------------------------- */

  global.AnkiParser = {
    parseApkg: parseApkg,
    sanitizeHtml: sanitizeHtml,
    compactHtml: compactHtml,
    richHtml: richHtml,
    htmlToText: htmlToText,
    parseMediaEntries: parseMediaEntries,
    parseOcclusionShapes: parseOcclusionShapes,
    detectImageOcclusion: detectImageOcclusion,
    FIELD_SEP: FIELD_SEP,
    MEDIA_PREFIX: MEDIA_PREFIX
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
