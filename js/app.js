/*!
 * Anki Inspector — main thread application.
 *
 * Responsibilities:
 *  - persist/open .apkg files (drag & drop, file picker, share-target POSTs)
 *  - run every heavy step inside the Web Worker (fflate unzip + WASM SQLite)
 *  - map Anki media (<img src="file.jpg">, [sound:file.mp3]) to blob URLs
 *  - render a compact, single-line note list (SVGs preserved)
 *  - "Edit in Anki" pencil -> native app deep links (anki://, intent://)
 */
(function () {
  'use strict';

  var APP_VERSION = '3.1.0';

  /* --------------------------------- state --------------------------------- */

    var state = {
    notes: [],
    cards: [],
    models: {},
    decks: {},
    mediaMap: {},
    media: [],
    files: {},            // "filename.jpg" -> { url, type, bytes } (blob URL)
    sortMode: 'deck',     // 'deck' | 'model' | 'time' | 'text'
    filter: '',           // live search text
    typeFilter: defaultTypeFilter(), // card-type visibility toggles (chips)
    expanded: {},         // noteId -> bool (shows full fields)
    fileName: '',
    fileSize: 0,
    parseMs: 0,
    format: '',           // human label of the parsed package format
    activeRequest: 0
  };

  var worker = null;
  var pending = {};   // reqId -> { resolve, reject }
  var nextReqId = 1;

  /* ---------------------------------- dom ---------------------------------- */

  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var ui = {
    dropzone: $('#dropzone'),
    fileInput: $('#file-input'),
    main: $('#main'),
    list: $('#note-list'),
    stats: $('#stats'),
    search: $('#search'),
    sort: $('#sort'),
    count: $('#count'),
    typeBar: $('#type-bar'),
    typeChips: $('#type-chips'),
    typeReset: $('#type-reset'),
    helpCard: $('#help-card'),
    bar: $('#progress-bar'),
    progText: $('#progress-text'),
    progWrap: $('#progress-wrap'),
    errBox: $('#error-box'),
    errText: $('#error-text'),
    errClose: $('#error-close'),
    fileName: $('#file-name'),
    install: $('#install'),
    spinner: $('#spinner')
  };

  /* ------------------------------ url plumbing ------------------------------ */

  // Host-relative base for the "live" (deployed) URL — used for share-target
  // POSTs when the location bar no longer carries a query string.
  function originBase() {
    var u = location.href;
    var q = u.indexOf('?');
    return q === -1 ? u : u.slice(0, q);
  }

  /* ------------------------------ media mapping ----------------------------- */

  function guessType(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
      wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
      webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', pdf: 'application/pdf'
    };
    return map[ext] || 'application/octet-stream';
  }

  /** Create one blob URL per media file; returns {name -> {url,type}}. */
  function buildMediaMap(mediaList) {
    var map = {};
    for (var i = 0; i < mediaList.length; i++) {
      var m = mediaList[i];
      var blob = new Blob([m.bytes], { type: guessType(m.name) });
      map[m.name] = { url: URL.createObjectURL(blob), type: blob.type };
      m.blobUrl = map[m.name].url;
    }
    return map;
  }

  /** Release every blob URL (important before loading another deck). */
  function revokeMedia() {
    Object.keys(state.files).forEach(function (name) {
      try { URL.revokeObjectURL(state.files[name].url); } catch (e) { /* noop */ }
    });
    state.files = {};
  }

  /** Map Anki <img src="..."> and [sound:...] references to blob URLs. */
  function rewriteMedia(html) {
    if (!html) return html;
    var files = state.files;
    var out = String(html).replace(/<img\b[^>]*>/gi, function (tag) {
      var m = /src\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!m) return tag;
      var name = decodeURIComponent(m[1]).replace(/^\.\//, '');
      if (files[name]) return tag.replace(m[0], 'src="' + files[name].url + '"');
      return tag;
    });

    out = out.replace(/\[sound:([^\]]+)\]/gi, function (whole, name) {
      name = String(name).trim().replace(/^\.\//, '');
      if (files[name]) {
        return '<audio controls preload="none" src="' + files[name].url + '"></audio>';
      }
      return '<span class="missing-sound" title="missing media: ' + name + '">🔇 ' +
             name.replace(/[<>&"']/g, '') + '</span>';
    });

    // Legacy <audio src="..."> / <video src="..."> references
    out = out.replace(/<(audio|video)\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi, function (whole, tag, pre, name, post) {
      var clean = String(name).replace(/^\.\//, '');
      if (files[clean]) {
        return '<' + tag + ' controls preload="none" ' + pre + ' src="' + files[clean].url + '"' + post + '>';
      }
      return whole;
    });
    return out;
  }

  /** Is there any media <img/audio/svg> inside this field HTML? */
  function hasMedia(html) {
    return /<img\b|<audio\b|<video\b|<svg\b|\[sound:/i.test(html);
  }

  /* --------------------------- rendering: notes ---------------------------- */

  function fieldPreview(field) {
    var compact = AnkiParser.compactHtml(field);
    if (!compact) return '<span class="empty">(empty)</span>';
    return compact;
  }

  /* ------------------------- image occlusion rendering ---------------------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v != null && v !== '') n.setAttribute(k, v);
      });
    }
    return n;
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return isNaN(n) ? (fallback || 0) : n;
  }

  /** Stored angle is 1/10000 of a turn (Anki's angleToStored). */
  function storedAngleToDeg(v) {
    if (v == null || v === '') return 0;
    var n = parseFloat(v);
    if (isNaN(n)) return 0;
    return ((n % 10000) / 10000) * 360;
  }

  /**
   * Draw parsed occlusion shapes into the overlay SVG. Coordinates in the note
   * are normalized (0..1). Initially we draw in a 0..1 viewBox that stretches
   * with the image; once the image has loaded we redraw in absolute pixels
   * (viewBox = natural size) so text masks get real font sizes.
   */
  function drawIoShapes(svg, shapes, size) {
    var W = size ? size.width : 1;
    var H = size ? size.height : 1;
    // placeholder pass (before the image loads) assumes a mid-size image
    if (!size) { W = 640; H = 480; }
    var vb = '0 0 ' + W + ' ' + H;
    svg.setAttribute('viewBox', vb);

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    shapes.forEach(function (s) {
      var p = s.props || {};
      var left = num(p.left) * W, top = num(p.top) * H;
      var node = null, cx = left, cy = top;

      if (s.shape === 'rect') {
        var w = num(p.width) * W, h = num(p.height) * H;
        node = svgEl('rect', { x: left, y: top, width: w, height: h });
        cx = left + w / 2; cy = top + h / 2;
      } else if (s.shape === 'ellipse') {
        var rx = ((p.rx != null && p.rx !== '') ? num(p.rx) : num(p.width) / 2) * W;
        var ry = ((p.ry != null && p.ry !== '') ? num(p.ry) : num(p.height) / 2) * H;
        node = svgEl('ellipse', {
          cx: left + rx, cy: top + ry,
          rx: Math.max(rx, 0), ry: Math.max(ry, 0)
        });
        cx = left + rx; cy = top + ry;
      } else if (s.shape === 'polygon') {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var pts = String(p.points || '').trim().split(/\s+/).filter(Boolean).map(function (pair) {
          var xy = pair.split(',');
          var x = num(xy[0]) * W, y = num(xy[1]) * H;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          return x.toFixed(2) + ',' + y.toFixed(2);
        });
        if (pts.length >= 3) {
          node = svgEl('polygon', { points: pts.join(' ') });
          cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
        }
      } else if (s.shape === 'text') {
        var fs = num(p.fs, 16) || 16;
        var text = String(p.text || '');
        var g = svgEl('g');
        var tw = text.length * fs * 0.62 + fs * 0.5;
        var th = fs * 1.45;
        g.appendChild(svgEl('rect', { class: 'io-text-bg', x: left, y: top, width: tw, height: th, rx: fs * 0.15 }));
        var label = svgEl('text', {
          class: 'io-text-label',
          x: left + tw / 2,
          y: top + fs * 1.08,
          'text-anchor': 'middle'
        });
        label.setAttribute('font-size', fs);
        label.textContent = text;
        g.appendChild(label);
        node = g;
        cx = left + tw / 2; cy = top + th / 2;
      }

      if (!node) return;
      var angle = storedAngleToDeg(p.angle);
      if (angle) node.setAttribute('transform', 'rotate(' + angle.toFixed(2) + ' ' + cx.toFixed(2) + ' ' + cy.toFixed(2) + ')');
      node.setAttribute('class', (node.getAttribute('class') || '') + ' io-shape io-' + s.shape);
      node.setAttribute('data-ordinal', s.ordinal || 0);
      svg.appendChild(node);
    });
  }

  function ioShapesOf(note, io) {
    if (!note._ioShapes && io.occlusions >= 0 && note.fields[io.occlusions] != null) {
      note._ioShapes = AnkiParser.parseOcclusionShapes(note.fields[io.occlusions]);
    }
    return note._ioShapes || [];
  }

  function ioSummary(shapes) {
    if (!shapes.length) return 'no masks';
    var ords = {};
    shapes.forEach(function (s) { ords[s.ordinal || 0] = true; });
    var groups = Object.keys(ords).length;
    return shapes.length + ' mask' + (shapes.length === 1 ? '' : 's') +
      (groups > 1 ? ' · ' + groups + ' cloze groups' : '');
  }

  /**
   * Image-occlusion preview: the base image with the occlusion masks drawn on
   * top (masked = question side). The 👁 button reveals what's underneath.
   */
  function buildIoPreview(note, io) {
    var wrap = el('div', 'io-preview');

    // --- base image (map src to a blob URL via the shared rewrite) ---
    var holder = document.createElement('div');
    holder.innerHTML = rewriteMedia(AnkiParser.compactHtml(note.fields[io.image]));
    var img = holder.querySelector('img');
    if (!img) {
      wrap.appendChild(el('p', 'io-missing', 'Image occlusion note — base image missing from the package.'));
      return wrap;
    }
    img.className = 'io-img';
    img.removeAttribute('width');
    img.removeAttribute('height');
    var frame = el('div', 'io-frame');
    frame.appendChild(img);

    if (io.kind === 'svg') {
      // Legacy "Image Occlusion Enhanced": the masks are literal <svg> markup.
      var occl = document.createElement('div');
      occl.innerHTML = AnkiParser.sanitizeHtml(note.fields[io.occlusions]);
      var raw = occl.querySelector('svg');
      if (raw) {
        raw.classList.add('io-overlay', 'io-overlay-svg');
        if (!raw.getAttribute('viewBox')) {
          var sw = parseFloat(raw.getAttribute('width'));
          var sh = parseFloat(raw.getAttribute('height'));
          if (sw && sh) raw.setAttribute('viewBox', '0 0 ' + sw + ' ' + sh);
        }
        raw.removeAttribute('width');
        raw.removeAttribute('height');
        raw.setAttribute('preserveAspectRatio', 'none');
        frame.appendChild(raw);
      }
    } else {
      var shapes = ioShapesOf(note, io);
      if (shapes.length) {
        var overlay = svgEl('svg', {
          class: 'io-overlay',
          viewBox: '0 0 640 480',
          preserveAspectRatio: 'none'
        });
        drawIoShapes(overlay, shapes, null);
        frame.appendChild(overlay);

        // once the image's real size is known, redraw in true pixel geometry
        var redraw = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return;
          drawIoShapes(overlay, shapes, { width: w, height: h });
        };
        if (img.complete && img.naturalWidth) redraw();
        else img.addEventListener('load', redraw, { once: true });
      }
    }

    wrap.appendChild(frame);

    // --- caption + reveal toggle ---
    var bar = el('div', 'io-bar');
    bar.appendChild(el('span', 'io-count', '🖼️ ' + ioSummary(ioShapesOf(note, io))));
    var toggle = el('button', 'io-toggle', '👁 Reveal');
    toggle.type = 'button';
    toggle.title = 'Toggle the occlusion masks';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', function () {
      var revealed = wrap.classList.toggle('revealed');
      toggle.textContent = revealed ? '🙈 Mask' : '👁 Reveal';
      toggle.setAttribute('aria-pressed', revealed ? 'true' : 'false');
    });
    bar.appendChild(toggle);
    wrap.appendChild(bar);

    return wrap;
  }

  function buildNoteNode(note) {
    var node = el('li', 'note' + (note.cards.length ? '' : ' no-cards'));
    node.dataset.id = note.id;

    // ---- image occlusion? render the masked-image preview instead of text ----
    // (cached on the note — fields are scanned only once per loaded deck)
    if (note._io === undefined) {
      note._io = AnkiParser.detectImageOcclusion(note.fields, note.fieldNames, note.modelName) || null;
    }
    var io = note._io;

    // ---- left: pencil (edit in Anki deep-link) ----
    var actions = el('div', 'note-actions');
    var pencil = el('button', 'icon-btn edit-btn', '✏️');
    pencil.type = 'button';
    pencil.title = 'Open this note in Anki';
    pencil.setAttribute('aria-label', 'Open note ' + note.id + ' in Anki');
    pencil.addEventListener('click', function (e) {
      e.stopPropagation();
      openAnkiFor(note);
    });
    actions.appendChild(pencil);
    node.appendChild(actions);

    // ---- body: compact single line ----
    var body = el('div', 'note-body');

    var top = el('div', 'note-top');
    var meta = el('div', 'note-meta');
    var modelBadge = el('span', 'badge model-badge', note.modelName || 'Note');
    meta.appendChild(modelBadge);
    if (note.tags && note.tags.length) {
      var tagBadge = el('span', 'badge tag-badge', '#' + note.tags.join(' #'));
      tagBadge.title = note.tags.join(', ');
      meta.appendChild(tagBadge);
    }
    top.appendChild(meta);

    if (io) {
      top.appendChild(buildIoPreview(note, io));
    } else {
      var first = el('div', 'note-first');
      first.innerHTML = rewriteMedia(fieldPreview(note.fields[0]));
      top.appendChild(first);
    }

    var cardsRow = el('div', 'note-cards');
    note.cards.forEach(function (card) {
      var cls = cardClass(card);
      var c = el('span', 'card-chip k-' + cls, card.deckName);
      c.title = cls + ' · due ' + (card.due != null ? card.due : '—') +
                ' · queue ' + card.queue + ' · reps ' + card.reps +
                ' · lapses ' + card.lapses;
      cardsRow.appendChild(c);
    });
    top.appendChild(cardsRow);

    body.appendChild(top);

    // ---- expandable extra fields ----
    var extra = el('div', 'note-extra');
    extra.hidden = true;
    for (var i = 1; i < note.fields.length; i++) {
      var fname = note.fieldNames[i] || ('Field ' + (i + 1));
      var row = el('div', 'extra-field');
      var label = el('span', 'extra-label', fname + ':');
      var value = el('span', 'extra-value');
      if (io && i === io.occlusions) {
        // the raw mask text is machine noise — show a human summary instead
        value.innerHTML = '<span class="io-summary">👁 ' + ioSummary(ioShapesOf(note, io)) +
          ' — use Reveal on the image above</span>';
      } else {
        value.innerHTML = rewriteMedia(
          (state.expanded[note.id] ? AnkiParser.richHtml(note.fields[i]) : fieldPreview(note.fields[i]))
        );
      }
      row.appendChild(label);
      row.appendChild(value);
      extra.appendChild(row);
    }
    if (!extra.children.length) {
      extra.appendChild(el('span', 'empty', 'No additional fields.'));
    }
    body.appendChild(extra);
    node.appendChild(body);

    // ---- expand toggle ----
    var toggle = el('button', 'expand-btn', '▾');
    toggle.type = 'button';
    toggle.title = 'Show all fields';
    toggle.setAttribute('aria-label', 'Show all fields');
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleExpanded(note.id);
    });
    node.appendChild(toggle);

    return node;
  }

  function toggleExpanded(id) {
    state.expanded[id] = !state.expanded[id];
    renderNotes();
  }

  /* ------------------------------ filtering ------------------------------- */

  /*
   * Card-type classification used by BOTH the toggle chips and the per-card
   * chips in each note row. Anki cards: type 0=new, 1=learning, 2=review,
   * 3=filtered; queue -1=suspended, -2/-3=buried, 0=new, 1=learn, 2=review,
   * 3=day-learn, 4=preview. Queue is the live state, so it wins when >= 0.
   */
  function cardClass(card) {
    var q = card.queue;
    if (q === -1) return 'suspended';
    if (q === -2 || q === -3) return 'buried';
    var t = q >= 0 ? q : card.type;
    if (t === 0) return 'new';
    if (t === 2) return 'due';
    return 'learn';
  }

  var CARD_TYPE_CHIPS = [
    { id: 'new', label: 'New' },
    { id: 'learn', label: 'Learning' },
    { id: 'due', label: 'Review' },
    { id: 'suspended', label: 'Suspended' },
    { id: 'buried', label: 'Buried' },
    { id: 'nocards', label: 'No cards' }
  ];

  function defaultTypeFilter() {
    return { new: true, learn: true, due: true, suspended: true, buried: true, nocards: true };
  }

  /** Set of card-type classes a note currently "occupies". */
  function noteClasses(note) {
    var set = {};
    if (!note.cards || !note.cards.length) set.nocards = true;
    for (var i = 0; i < note.cards.length; i++) set[cardClass(note.cards[i])] = true;
    return set;
  }

  function notePassesTypeFilter(note) {
    if (!state.typeFilter) return true;
    var set = noteClasses(note);
    var allOn = true;
    for (var k in state.typeFilter) {
      if (!state.typeFilter[k]) { allOn = false; break; }
    }
    if (allOn) return true; // nothing hidden → no filtering at all
    for (var cls in set) {
      if (state.typeFilter[cls]) return true; // at least one card type is visible
    }
    return false;
  }

  /** Build the toggle chips once; counts/pressed-state refreshed per render. */
  function buildTypeBar() {
    if (!ui.typeChips) return;
    ui.typeChips.innerHTML = '';
    CARD_TYPE_CHIPS.forEach(function (t) {
      var chip = el('button', 'type-chip');
      chip.type = 'button';
      chip.dataset.type = t.id;
      chip.setAttribute('aria-pressed', 'true');
      chip.title = 'Show/hide notes whose cards are ' + t.label.toLowerCase();
      chip.appendChild(el('span', 'chip-label', t.label));
      var count = el('span', 'chip-count', '0');
      chip.appendChild(count);
      chip.addEventListener('click', function () {
        state.typeFilter[t.id] = !state.typeFilter[t.id];
        renderNotes();
      });
      ui.typeChips.appendChild(chip);
    });
    if (ui.typeReset) {
      ui.typeReset.addEventListener('click', function () {
        state.typeFilter = defaultTypeFilter();
        renderNotes();
      });
    }
  }

  function updateTypeBar() {
    if (!ui.typeChips) return;
    var counts = {};
    CARD_TYPE_CHIPS.forEach(function (t) { counts[t.id] = 0; });
    state.notes.forEach(function (n) {
      var set = noteClasses(n);
      for (var cls in set) {
        if (counts[cls] != null) counts[cls] += 1;
      }
    });
    var anyOff = false;
    var chips = ui.typeChips.children;
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var id = chip.dataset.type;
      var on = !state.typeFilter || state.typeFilter[id];
      if (!on) anyOff = true;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      var cc = chip.querySelector('.chip-count');
      if (cc) cc.textContent = counts[id].toLocaleString();
    }
    if (ui.typeReset) ui.typeReset.hidden = !anyOff;
  }

  function applyFilters() {
    var q = state.filter.trim().toLowerCase();
    var out = [];
    for (var i = 0; i < state.notes.length; i++) {
      var n = state.notes[i];
      if (q) {
        var hay = (n.sfld + ' ' + n.fields.join(' ') + ' ' + n.tags.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      if (!notePassesTypeFilter(n)) continue;
      out.push(n);
    }

    var mode = state.sortMode;
    out.sort(function (a, b) {
      if (mode === 'model') {
        var mc = (a.modelName || '').localeCompare(b.modelName || '');
        if (mc) return mc;
      } else if (mode === 'time') {
        var tc = (b.mod || 0) - (a.mod || 0);
        if (tc) return tc;
      } else if (mode === 'text') {
        var sc = (a.sfld || '').localeCompare(b.sfld || '');
        if (sc) return sc;
      } else {
        // deck: group by first card's deck, then sort field
        var da = (a.cards[0] && a.cards[0].deckName) || '—';
        var db = (b.cards[0] && b.cards[0].deckName) || '—';
        var cmp = da.localeCompare(db);
        if (cmp) return cmp;
      }
      // stable, meaningful tie-break for every mode
      var t = (a.sfld || '').localeCompare(b.sfld || '');
      if (t) return t;
      return (a.id || 0) - (b.id || 0);
    });
    return out;
  }

  function renderNotes() {
    var list = applyFilters();
    ui.list.innerHTML = '';
    var frag = document.createDocumentFragment();
    list.forEach(function (n) { frag.appendChild(buildNoteNode(n)); });
    ui.list.appendChild(frag);
    ui.count.textContent = list.length.toLocaleString() +
      (list.length !== state.notes.length ? ' / ' + state.notes.length.toLocaleString() : '');
    updateTypeBar();
    updateStats();
  }

  /* ------------------------------ editing bridge ---------------------------- */
  /*
   * Deep links into the installed Anki clients. AnkiDroid does NOT handle
   * intent://note links — an intent:// URL with a Play-Store fallback_url is
   * what kept bouncing users to the Store. What AnkiDroid DOES expose is a
   * real, registered deep link (AnkiDroid 2.22+):
   *
   *     anki://x-callback-url/browser?search=<query>
   *
   * which opens the Card Browser pre-filtered with an Anki search query, so
   * `nid:<note id>` lands on exactly this note (tap it to edit). AnkiMobile
   * (2.0.90+) speaks `anki://x-callback-url/search?query=`. We navigate with
   * the plain anki:// scheme — no intent:// wrapper, no Play Store fallback:
   * if no client is installed nothing happens instead of a Store redirect.
   */

  function ankiDeepLink(note, userAgent) {
    var ua = userAgent || navigator.userAgent || '';
    var nid = encodeURIComponent('nid:' + note.id);
    if (/iPhone|iPad|iPod/i.test(ua)) {
      return 'anki://x-callback-url/search?query=' + nid;   // AnkiMobile
    }
    return 'anki://x-callback-url/browser?search=' + nid;   // AnkiDroid / desktop try
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(function () { /* noop */ });
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) { /* clipboard is best-effort */ }
    return Promise.resolve();
  }

  /** Small transient toast (auto-dismisses — unlike the error banner). */
  function toast(message, ms) {
    var t = el('div', 'update-toast', message);
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 400);
    }, ms || 2600);
  }

  function openAnkiFor(note) {
    if (!note) return;
    var target = ankiDeepLink(note);
    // Handy fallback: the exact search term is on the clipboard either way.
    copyText('nid:' + note.id);
    toast('Opening Anki at note ' + note.id + ' (nid:' + note.id + ' copied)');
    try { window.location.href = target; } catch (e) { /* scheme not handled */ }
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* noop */ } }
  }

  /* --------------------------------- worker -------------------------------- */

  function ensureWorker() {
    if (worker) return;
    worker = new Worker('js/worker.js');
    worker.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m) return;
      var req = pending[m.id];
      if (!req) return;

      if (m.type === 'progress') {
        ui.bar.style.width = Math.round(m.progress * 100) + '%';
        ui.progText.textContent = m.text;
      } else if (m.type === 'result') {
        delete pending[m.id];
        ui.bar.style.width = '100%';
        ui.progText.textContent = 'Done';
        req.resolve(m);
      } else if (m.type === 'error') {
        delete pending[m.id];
        req.reject(new Error(m.message));
      }
    });
    worker.addEventListener('error', function (ev) {
      // Route any worker error to the active request
      var ids = Object.keys(pending);
      if (ids.length) {
        var req = pending[ids[0]];
        delete pending[ids[0]];
        req.reject(new Error(ev.message || 'Web Worker crashed.'));
      }
    });
  }

  function parseWithWorker(buffer) {
    ensureWorker();
    return new Promise(function (resolve, reject) {
      var id = nextReqId++;
      pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage({ type: 'parse', id: id, buffer: buffer }, [buffer]);
    });
  }

  /* ------------------------------ load pipeline ----------------------------- */

  function showProgress(on) {
    ui.progWrap.hidden = !on;
    if (on) {
      ui.bar.style.width = '0%';
      ui.progText.textContent = 'Starting…';
      ui.spinner.hidden = false;
    } else {
      ui.spinner.hidden = true;
    }
  }

  function showError(message) {
    ui.errText.textContent = message;
    ui.errBox.hidden = false;
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function updateStats() {
    var n = state.notes.length;
    var c = state.cards.length;
    var m = state.media.length;
    var line = '📚 ' + n.toLocaleString() + ' notes · 🃏 ' + c.toLocaleString() + ' cards';
    if (m) line += ' · 🖼️ ' + m.toLocaleString() + ' media';
    line += ' · ⚡ parsed in ' + state.parseMs + ' ms';
    if (state.format) line += ' · 📦 ' + state.format;
    ui.stats.textContent = line;
  }

  async function loadApkg(buffer, fileName, fileSize) {
    state.activeRequest++;
    var reqId = state.activeRequest;
    showProgress(true);
    showErrorBox(false);

    try {
      var res = await parseWithWorker(buffer);

      if (reqId !== state.activeRequest) return; // a newer file superseded this one

      revokeMedia();
      state.notes = res.data.notes;
      state.cards = res.data.cards;
      state.models = res.data.models;
      state.decks = res.data.decks;
      state.mediaMap = res.data.mediaMap;
      state.media = res.data.media;
      state.files = buildMediaMap(res.data.media);
      state.expanded = {};
      state.typeFilter = defaultTypeFilter();
      state.fileName = fileName || '';
      state.fileSize = fileSize || 0;
      state.parseMs = Math.round(res.elapsed);
      state.format = (res.data && res.data.format && res.data.format.label) || '';

      ui.fileName.textContent = state.fileName + (state.fileSize ? '  (' + fmtBytes(state.fileSize) + ')' : '');
      ui.fileName.hidden = false;
      $('#new-file').hidden = false;
      // landing screen fully steps aside — the deck list IS the screen now
      ui.dropzone.hidden = true;
      if (ui.helpCard) ui.helpCard.hidden = true;
      ui.main.hidden = false;
      if (ui.typeBar) ui.typeBar.hidden = false;
      renderNotes();
      updateStats();
      try { window.scrollTo(0, 0); } catch (e) { /* noop */ }
    } catch (err) {
      if (reqId !== state.activeRequest) return;
      showError(err.message || String(err));
    } finally {
      if (reqId === state.activeRequest) {
        showProgress(false);
        ui.spinner.hidden = true;
      }
    }
  }

  /* ------------------------------ share target ----------------------------- */

  /**
   * Share Target API v2: Android posts the shared file to the URL in the
   * manifest (POST, multipart). We also support:
   *   - ?apkg=<url>          (iOS share-extension pattern)
   *   - #blob=<id>           (in-page direct access)
   *   - the legacy GET query from Web Share Target v1
   */
  async function handleShareTarget() {
    var url = new URL(location.href);

    // 1) Share Target v2 hand-off: the service worker stashed the shared file
    //    in Cache Storage and redirected us here with ?web-share-target&shared=<key>
    var sharedKey = url.searchParams.get('shared');
    if (sharedKey && url.searchParams.get('web-share-target') !== null) {
      showProgress(true);
      ui.progText.textContent = 'Receiving shared package…';
      try {
        var r = await fetch('./?fetch-shared=' + encodeURIComponent(sharedKey));
        if (!r.ok) throw new Error('Could not read the shared file (it may already be consumed).');
        var buf = await r.arrayBuffer();
        try { history.replaceState(null, '', originBase()); } catch (e) { /* noop */ }
        await loadApkg(buf, state.fileName || 'shared.apkg', buf.byteLength);
      } catch (err) {
        showProgress(false);
        showError(err.message || String(err));
      }
      return;
    }

    // in-page blob link (drag & drop or picker on same tab)
    var blobId = url.hash.match(/^#blob=([^&]+)/);
    if (blobId) {
      var b = lookupBlob(blobId[1]);
      if (b) {
        history.replaceState(null, '', originBase());
        await loadApkg(b.buffer, b.name, b.size);
        return;
      }
    }

    // 2) ?apkg=<url> (iOS / external)
    var apkgUrl = url.searchParams.get('apkg');
    if (apkgUrl) {
      showProgress(true);
      ui.progText.textContent = 'Fetching shared package…';
      try {
        var r = await fetch(apkgUrl);
        if (!r.ok) throw new Error('Could not fetch shared package (' + r.status + ').');
        var buf = await r.arrayBuffer();
        history.replaceState(null, '', originBase());
        await loadApkg(buf, apkgUrl.split('/').pop() || 'shared.apkg', buf.byteLength);
      } catch (err) {
        showProgress(false);
        showError(err.message || String(err));
      }
      return;
    }

    // 3) POST multipart (Share Target API v2, direct hit — no SW involved)
    if (location.search && location.search.indexOf('web-share-target') !== -1) {
      var form = new FormData();
      var entries = form.entries();
      var it = entries.next();
      while (!it.done) {
        var val = it.value[1];
        if (typeof File !== 'undefined' && val instanceof File) {
          if (PACKAGE_RE.test(val.name) || val.type.indexOf('apkg') !== -1 || val.type === 'application/octet-stream' || val.type === 'application/zip') {
            var buf = await val.arrayBuffer();
            var base = originBase();
            try {
              history.replaceState(null, '', base);
              document.title = 'Anki Inspector';
            } catch (e) { /* noop */ }
            await loadApkg(buf, val.name, val.size);
            return;
          }
        }
        it = entries.next();
      }
      showError('No .apkg file was found in the shared content. ' +
        'Make sure you share the file itself (not a text link).');
      showProgress(false);
      return;
    }

    // 4) legacy GET query (v1): /?title=..&text=..&url=..
    var legacy = url.searchParams.get('url');
    if (legacy && /\.apkg(?:$|\?)/i.test(legacy)) {
      try {
        var rr = await fetch(legacy);
        var bb = await rr.arrayBuffer();
        history.replaceState(null, '', originBase());
        await loadApkg(bb, legacy.split('/').pop(), bb.byteLength);
      } catch (e) {
        showError(e.message || String(e));
      }
      return;
    }
  }

  /* ------------------------------ picker / dnd ----------------------------- */

  var blobStore = {};
  function storeBlob(buffer, name, size) {
    var id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    blobStore[id] = { buffer: buffer, name: name, size: size };
    return id;
  }
  function lookupBlob(id) { return blobStore[id] || null; }

  ui.dropzone.addEventListener('click', function () { ui.fileInput.click(); });

  ui.fileInput.addEventListener('change', function () {
    var f = ui.fileInput.files && ui.fileInput.files[0];
    if (!f) return;
    ui.fileInput.value = '';
    openFile(f);
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    ui.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      ui.dropzone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    ui.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      ui.dropzone.classList.remove('dragging');
    });
  });
  ui.dropzone.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  window.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f) { openFile(f); break; }
      }
    }
  });

  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  // Any Anki package flavour: .apkg (deck), .colpkg (whole collection) and
  // raw .zip (same container, renamed by mail apps / download managers).
  var PACKAGE_RE = /\.(apkg|colpkg|zip)$/i;

  function openFile(file) {
    if (!file) return;
    if (!PACKAGE_RE.test(file.name)) {
      showError('"' + file.name + '" does not look like an Anki package — expected .apkg or .colpkg.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var buf = reader.result;
      var id = storeBlob(buf, file.name, file.size);
      try {
        history.replaceState(null, '', originBase() + '#blob=' + id);
      } catch (e) { /* noop */ }
      loadApkg(buf, file.name, file.size);
    };
    reader.onerror = function () { showError('Could not read the file.'); };
    reader.readAsArrayBuffer(file);
  }

  /* --------------------------------- toolbar -------------------------------- */

  ui.search.addEventListener('input', function () {
    state.filter = ui.search.value;
    renderNotes();
  });

  ui.sort.addEventListener('change', function () {
    state.sortMode = ui.sort.value;
    renderNotes();
  });

  ui.errClose.addEventListener('click', function () { showErrorBox(false); });
  function showErrorBox(on) { ui.errBox.hidden = !on; }

  $('#new-file').addEventListener('click', function () { ui.fileInput.click(); });

  /* ------------------------------ install prompt ---------------------------- */
  /*
   * The button must never nag someone who already has the app:
   *  - inside the installed app (display-mode: standalone) it is pointless
   *  - on the site, getInstalledRelatedApps() (manifest related_applications,
   *    platform "webapp") lets us detect the installed WebAPK and stay quiet
   */

  function runningStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
  }

  function relatedAppInstalled() {
    return Promise.resolve()
      .then(function () {
        if (!navigator.getInstalledRelatedApps) return [];
        return navigator.getInstalledRelatedApps();
      })
      .then(function (apps) { return !!(apps && apps.length); })
      .catch(function () { return false; });
  }

  var deferredPrompt = null;
  var installKnown = false; // set once we know the app is already installed

  relatedAppInstalled().then(function (installed) {
    installKnown = installed;
    if (installed) ui.install.hidden = true;
  });

  if (runningStandalone()) {
    installKnown = true;
    ui.install.hidden = true;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    if (installKnown || runningStandalone()) return;
    deferredPrompt = e;
    ui.install.hidden = false;
  });
  window.addEventListener('appinstalled', function () {
    installKnown = true;
    deferredPrompt = null;
    ui.install.hidden = true;
  });
  ui.install.addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () { deferredPrompt = null; ui.install.hidden = true; });
  });

  /* --------------------------- service worker ------------------------------ */
  /*
   * Self-updating: the SW is fetched network-first, so a deploy is picked up
   * on the next launch automatically. To also refresh a session that is
   * already open, we check for updates when the tab becomes visible and once
   * an hour; when a new worker takes over, the page reloads itself once (with
   * a small toast) — the user never has to reinstall anything.
   */

  var refreshing = false;

  function showUpdateToast() {
    var toast = document.createElement('div');
    toast.className = 'update-toast';
    toast.textContent = '🔄 Updated to v' + APP_VERSION + ' — refreshing…';
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 10);
  }

  function watchForUpdates(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) {
      // an update finished downloading before this page noticed it
      applyNow(reg.waiting);
    }
    reg.addEventListener('updatefound', function () {
      var incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', function () {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          applyNow(incoming);
        }
      });
    });
    // Re-check when the user comes back to the app, and hourly while open.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { try { reg.update(); } catch (e) { /* noop */ } }
    });
    setInterval(function () { try { reg.update(); } catch (e) { /* noop */ } }, 60 * 60 * 1000);
  }

  function applyNow(worker) {
    if (refreshing) return;
    refreshing = true;
    showUpdateToast();
    try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { /* noop */ }
    // skipWaiting may already have run during install — reload either way
    setTimeout(function () { location.reload(); }, 1500);
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var isSecure = location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1';
    if (!isSecure) return;
    // relative path + scope so it also works when hosted under a sub-path
    // (e.g. GitHub Pages: /Anki-PWA/)
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
      console.log('[anki-inspector] SW v' + APP_VERSION + ' registered:', reg.scope);
      watchForUpdates(reg);
    }).catch(function (err) {
      console.warn('[anki-inspector] SW registration failed:', err);
    });
  }

  /* -------------------------------- kick off -------------------------------- */

  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // expose a tiny API for tests / console debugging
  window.AnkiInspector = {
    _state: state,
    version: APP_VERSION,
    fmtBytes: fmtBytes,
    fmtDate: fmtDate,
    renderNotes: renderNotes,
    loadApkg: loadApkg,
    handleShareTarget: handleShareTarget,
    ankiDeepLink: ankiDeepLink,
    cardClass: cardClass,
    buildTypeBar: buildTypeBar
  };

  document.addEventListener('DOMContentLoaded', function () {
    var vEl = document.getElementById('version');
    if (vEl) vEl.textContent = 'v' + APP_VERSION;
    if (!state.typeFilter) state.typeFilter = defaultTypeFilter();
    buildTypeBar();
    registerSW();
    handleShareTarget().catch(function (e) { showError(e.message || String(e)); });
  });
})();
