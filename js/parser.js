/*!
 * AnkiParser — pure parsing core for .apkg inspection.
 *
 * Environment-agnostic: it runs inside a Web Worker (via importScripts) and in
 * Node.js (for tests). It depends on two globals:
 *   - `fflate`     (UMD build, https://github.com/101arrowz/fflate)
 *   - `initSqlJs`  (sql.js / WASM SQLite, https://sql.js.org)
 *
 * The parse pipeline is fully synchronous-with-await inside the worker, so the
 * main thread never blocks:
 *   1. fflate.unzipSync  -> decompress the archive in memory
 *   2. sql.js WASM       -> open collection.anki2
 *   3. SQL               -> read notes / cards / note models / decks
 *   4. media JSON        -> map numeric keys -> real filenames, extract bytes
 */
(function (global) {
  'use strict';

  var FIELD_SEP = '\u001f'; // Anki separates note fields with the Unit Separator
  var MEDIA_PREFIX = 'collection.media/'; // Anki 2.1+ stores media under this zip dir

  /* ---------------------------------- utils --------------------------------- */

  function utf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
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

  /* ------------------------------- the parser -------------------------------- */

  /**
   * @param {ArrayBuffer} arrayBuffer - raw .apkg bytes
   * @param {Object} [opts]
   * @param {Function} [opts.onProgress]  (progress:0..1, text)
   * @param {string} [opts.wasmBase]      URL prefix for sql-wasm.wasm (default 'js/')
   * @returns {Promise<{notes:Array, cards:Array, models:Object, decks:Object,
   *                    media:Array, mediaMap:Object}>}
   */
  async function parseApkg(arrayBuffer, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || null;
    var wasmBase = opts.wasmBase != null ? opts.wasmBase : 'js/';

    report(onProgress, 0.03, 'Decompressing archive…');

    // 1) in-memory unzip (fastest option; runs on the worker thread)
    var files = fflate.unzipSync(new Uint8Array(arrayBuffer));
    report(onProgress, 0.42, 'Archive decompressed — opening collection.anki2…');

    var collection = files['collection.anki2'];
    if (!collection) {
      throw new Error('collection.anki2 not found — this is not a valid Anki package (.apkg).');
    }

    // 2) WASM SQLite
    var SQL = await initSqlJs({ locateFile: function (f) { return wasmBase + f; } });
    var db = new SQL.Database(collection);
    report(onProgress, 0.58, 'Querying notes & cards…');

    // 3a) collection metadata: note types (models) and decks are JSON blobs
    var models = {};
    var decks = {};
    try {
      var colRes = db.exec('SELECT models, decks FROM col LIMIT 1');
      if (colRes.length && colRes[0].values.length) {
        models = JSON.parse(colRes[0].values[0][0] || '{}') || {};
        decks = JSON.parse(colRes[0].values[0][1] || '{}') || {};
      }
    } catch (e) { /* corrupt metadata — degrade gracefully */ }

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
      var note = {
        id: r[0],
        mid: mid,
        modelName: model.name || ('Note Type ' + mid),
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

    // 4) media mapping: `media` JSON maps "0" -> "einstein.jpg", …
    report(onProgress, 0.74, 'Mapping media files…');
    var mediaMap = {};
    var mediaJson = files['media'] || files['_media'];
    if (mediaJson) {
      try { mediaMap = JSON.parse(utf8(mediaJson)) || {}; } catch (e) { mediaMap = {}; }
    }

    var referenced = {};
    Object.keys(mediaMap).forEach(function (k) { referenced[mediaMap[k]] = true; });

    var media = [];
    var seen = {};
    Object.keys(files).forEach(function (name) {
      var base = name;
      if (base.indexOf(MEDIA_PREFIX) === 0) base = base.slice(MEDIA_PREFIX.length);
      if (base === 'collection.anki2' || base === 'media' || base === '_media') return;
      if (name.charAt(0) === '_' && name !== '_media') return;      // zip metadata junk
      if (name.indexOf(MEDIA_PREFIX) !== 0 && !referenced[base]) return; // unreferenced junk
      if (seen[base]) return;
      seen[base] = true;
      media.push({ name: base, key: findKey(mediaMap, base), bytes: files[name] });
    });

    report(onProgress, 0.88, 'Assembling note list…');
    report(onProgress, 1, 'Done');

    return { notes: notes, cards: cards, models: models, decks: decks, media: media, mediaMap: mediaMap };
  }

  /* --------------------------------- exports -------------------------------- */

  global.AnkiParser = {
    parseApkg: parseApkg,
    sanitizeHtml: sanitizeHtml,
    compactHtml: compactHtml,
    richHtml: richHtml,
    htmlToText: htmlToText,
    FIELD_SEP: FIELD_SEP,
    MEDIA_PREFIX: MEDIA_PREFIX
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
