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

  var APP_VERSION = '3.0.0';

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

  function buildNoteNode(note) {
    var node = el('li', 'note' + (note.cards.length ? '' : ' no-cards'));
    node.dataset.id = note.id;

    // ---- left: pencil (edit in Anki deep-link) ----
    var actions = el('div', 'note-actions');
    var pencil = el('button', 'icon-btn edit-btn', '✏️');
    pencil.type = 'button';
    pencil.title = 'Edit in Anki';
    pencil.setAttribute('aria-label', 'Edit note in Anki');
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

    var first = el('div', 'note-first');
    first.innerHTML = rewriteMedia(fieldPreview(note.fields[0]));
    top.appendChild(first);

    var cardsRow = el('div', 'note-cards');
    note.cards.forEach(function (card) {
      var c = el('span', 'card-chip', card.deckName);
      c.title = 'Due ' + (card.due != null ? card.due : '—') +
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
      value.innerHTML = rewriteMedia(
        (state.expanded[note.id] ? AnkiParser.richHtml(note.fields[i]) : fieldPreview(note.fields[i]))
      );
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

  function cardSortValue(card) {
    var TYPE = { 0: 'new', 1: 'learn', 2: 'due', 3: 'filtered' };
    return TYPE[card.type] || 'other';
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
      out.push(n);
    }

    var mode = state.sortMode;
    out.sort(function (a, b) {
      if (mode === 'model') {
        return (a.modelName || '').localeCompare(b.modelName || '');
      }
      if (mode === 'time') {
        return (b.mod || 0) - (a.mod || 0);
      }
      if (mode === 'text') {
        return (a.sfld || '').localeCompare(b.sfld || '');
      }
      // deck: group by first card's deck, then sort field
      var da = (a.cards[0] && a.cards[0].deckName) || '—';
      var db = (b.cards[0] && b.cards[0].deckName) || '—';
      var cmp = da.localeCompare(db);
      if (cmp) return cmp;
      return (a.sfld || '').localeCompare(b.sfld || '');
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
    updateStats();
  }

  /* ------------------------------ editing bridge ---------------------------- */

  var ANDROID_INTENT =
    'intent://com.ichi2.anki/#Intent;scheme=anki;package=com.ichi2.anki;' +
    'action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;' +
    'S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.ichi2.anki;end;';

  function openAnkiFor(note) {
    if (!note) return;
    var noteId = note.id;
    var target = null;

    if (/Android/i.test(navigator.userAgent)) {
      target = ANDROID_INTENT;
    } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      target = 'anki://x-callback-url/openNote?noteId=' + noteId;
    } else {
      target = 'anki://note/' + noteId;
    }

    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = target;
    document.body.appendChild(iframe);
    setTimeout(function () {
      iframe.parentNode && iframe.parentNode.removeChild(iframe);
    }, 1500);

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
      state.fileName = fileName || '';
      state.fileSize = fileSize || 0;
      state.parseMs = Math.round(res.elapsed);
      state.format = (res.data && res.data.format && res.data.format.label) || '';

      ui.fileName.textContent = state.fileName + (state.fileSize ? '  (' + fmtBytes(state.fileSize) + ')' : '');
      ui.fileName.hidden = false;
      $('#new-file').hidden = false;
      ui.dropzone.hidden = true;
      ui.main.hidden = false;
      renderNotes();
      updateStats();
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
    handleShareTarget: handleShareTarget
  };

  document.addEventListener('DOMContentLoaded', function () {
    var vEl = document.getElementById('version');
    if (vEl) vEl.textContent = 'v' + APP_VERSION;
    registerSW();
    handleShareTarget().catch(function (e) { showError(e.message || String(e)); });
  });
})();
