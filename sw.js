/*!
 * Anki Inspector — service worker (v2).
 *
 * Handles two jobs:
 *  1. Web Share Target API v2: intercept the POST issued by the Android share
 *     sheet, stash the shared .apkg blob in Cache Storage, then redirect the
 *     page to a URL the page reads the blob from (works whether or not the
 *     app window was already open).
 *  2. App-shell caching so the inspector works fully offline once visited.
 *
 * v2 update strategy (fixes "pushes need uninstall/reinstall"):
 *   - HTML navigations  → network-first: a freshly deployed index.html shows
 *     up on the very next launch; the cached copy is only an offline fallback.
 *   - static assets     → stale-while-revalidate: served instantly from cache,
 *     refreshed in the background so the next load is current.
 *   - the v1 cache self-invalidates: bumping VERSION makes the activate step
 *     delete every cache that is not current (old shell + stale shared blobs),
 *     so existing installs migrate without any user action.
 * v3: answers SKIP_WAITING so the page can apply an update immediately.
 * v4: cache bump shipping the card-type filter chips, image-occlusion
 *     rendering and the dropzone/banner [hidden] fixes.
 * v5: fixes HALF-UPDATED sessions. With stale-while-revalidate, the first
 *     load after a deploy could pair the fresh index.html with the PREVIOUS
 *     release's app.js/app.css (banner that won't dismiss, dropzone that
 *     won't go away, old Play-Store pencil link…). Now:
 *       - every deploy pins its shell assets with ?v=ASSET_VER, so a new
 *         page can only ever reference its own files, and
 *       - the volatile shell files (HTML/JS/CSS/manifest) are served
 *         NETWORK-FIRST with the cache as offline fallback. Heavy, rarely
 *         changing payloads (sql-wasm, fflate, fzstd, icons) stay SWR.
 * v6: cloze rendering + token search release; manifest share_target hardened
 *     (absolute action URL, .apkg/.colpkg extensions, split icon purposes)
 *     so Android lists the app in the share sheet.
 */
'use strict';

var VERSION = 'anki-inspector-v6';
/*
 * Must match the ?v= suffixes in index.html and APP_VERSION in js/app.js —
 * a test asserts all three stay in lockstep. Bump on every release.
 */
var ASSET_VER = '3.3.0';

/* Files that change with every release. Served network-first so an already
 * open install can never keep running yesterday's code after an update. */
var VOLATILE = [
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/parser.js',
  './js/worker.js',
  './manifest.json'
];

var SHELL = [
  './',
  './index.html',
  './manifest.json?v=' + ASSET_VER,
  './css/app.css?v=' + ASSET_VER,
  './js/app.js?v=' + ASSET_VER,
  './js/parser.js?v=' + ASSET_VER,
  './js/worker.js?v=' + ASSET_VER,
  './js/fflate.min.js',
  './js/fzstd.min.js',
  './js/sql-wasm.js',
  './js/sql-wasm.wasm',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* Pathnames (query stripped) of the network-first files, resolved against
 * this worker's own URL so it works under any sub-path deploy. */
var VOLATILE_PATHS = VOLATILE.map(function (v) {
  return new URL(v, self.location.href).pathname;
});

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

// Activating v2 deletes every cache that is not v2 — this is what wipes the
// stale v1 shell (self-invalidation) and any leftover shared-file blobs.
self.addEventListener('activate', function (event) {
  var KEEP = [VERSION, VERSION + '-shared'];
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return KEEP.indexOf(k) === -1; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/** Pull the first file entry out of a multipart/form-data request body. */
function parseSharedFile(request) {
  return request.formData().then(function (form) {
    var entries = form.entries();
    var it = entries.next();
    while (!it.done) {
      var val = it.value[1];
      if (typeof File !== 'undefined' && val instanceof File && val.size > 0) {
        return val;
      }
      it = entries.next();
    }
    return null;
  });
}

function htmlResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Only handle same-origin requests (cross-origin media stays untouched).
  if (url.origin !== self.location.origin) return;

  var method = event.request.method.toUpperCase();

  /* ---- 1) Web Share Target v2: POST with the shared file ------------------ */
  if (method === 'POST') {
    event.respondWith(
      (async function () {
        var file = await parseSharedFile(event.request);

        if (!file) {
          return htmlResponse(
            '<!doctype html><meta charset="utf-8"><title>No file received</title>' +
            '<h1>No .apkg file was found in the shared content.</h1>' +
            '<p>Share the actual file from your files app — not a text link.</p>' +
            '<a href="./">Back to Anki Inspector</a>', 400);
        }

        // Stash the file in Cache Storage under a unique key, then bounce the
        // browser to a URL the page can read it back from.
        var key = 'shared-file-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        var cache = await caches.open(VERSION + '-shared');
        await cache.put(key, new Response(file));

        var target = new URL('./?web-share-target&shared=' + key, self.location.origin);
        return Response.redirect(target.href, 302);
      })()
    );
    return;
  }

  if (method !== 'GET') return;

  /* ---- 2) HTML navigations: network-first ---------------------------------- */
  // The freshly deployed shell must appear WITHOUT uninstall/reinstall, so the
  // network wins whenever it is reachable; cache is the offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async function () {
        try {
          var fresh = await fetch(event.request);
          if (fresh && fresh.ok) {
            var copy = fresh.clone();
            var shellCache = await caches.open(VERSION);
            event.waitUntil(shellCache.put('./index.html', copy));
          }
          return fresh;
        } catch (err) {
          var cached = await caches.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
          cached = await caches.match('./index.html');
          if (cached) return cached;
          return htmlResponse(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
            '<h1>You are offline</h1><p>Reconnect once to finish installing ' +
            'Anki Inspector, then it works fully offline.</p>' +
            '<a href="./">Try again</a>', 503);
        }
      })()
    );
    return;
  }

  /* ---- 3) volatile shell files (HTML/JS/CSS/manifest): network-first ------- */
  // A page that just updated must run THIS deploy's code, not the mix of the
  // previous release that stale-while-revalidate would hand out on first hit.
  if (VOLATILE_PATHS.indexOf(url.pathname) !== -1) {
    event.respondWith(
      (async function () {
        try {
          var fresh = await fetch(event.request);
          if (fresh && fresh.ok && fresh.type === 'basic') {
            var copy = fresh.clone();
            var cache = await caches.open(VERSION);
            await cache.put(event.request, copy);
          }
          return fresh;
        } catch (err) {
          // offline: this version's copy, else any cached variant of the file
          var cached = await caches.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
          return new Response('You are offline and this file was never cached.', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  /* ---- 4) everything else (GET assets): stale-while-revalidate ------------- */
  event.respondWith(
    (async function () {
      // 3a) the page asks for the stashed shared file back
      var sharedKey = url.searchParams.get('fetch-shared');
      if (sharedKey) {
        var cache2 = await caches.open(VERSION + '-shared');
        var hit = await cache2.match(sharedKey);
        if (hit) {
          // tidy up after the page has consumed it
          event.waitUntil(cache2.delete(sharedKey));
          return hit;
        }
        return htmlResponse('Shared file no longer available (already consumed or expired).', 404);
      }

      // 3b) serve from cache immediately…
      var cached = await caches.match(event.request);
      if (cached) {
        // …and refresh the copy in the background for the next load.
        event.waitUntil(
          fetch(event.request).then(function (res) {
            if (res && res.ok && res.type === 'basic') {
              return caches.open(VERSION).then(function (c) { return c.put(event.request, res); });
            }
          }).catch(function () { /* offline — keep the stale copy */ })
        );
        return cached;
      }

      // 3c) nothing cached: go to the network, cache a good copy.
      var res = await fetch(event.request);
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        var shellCache = await caches.open(VERSION);
        event.waitUntil(shellCache.put(event.request, copy));
      }
      return res;
    })().catch(function () {
      return caches.match('./index.html');
    })
  );
});

/* ---- 5) page asks us to apply a waiting update immediately ---------------- */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data && event.data.type === 'SHARE_TARGET') {
    event.respondWith(Response.redirect('./?url=' + encodeURIComponent(event.data.url), 302));
  }
});
