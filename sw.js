/*!
 * Anki Inspector — service worker.
 *
 * Handles two jobs:
 *  1. Web Share Target API v2: intercept the POST issued by the Android share
 *     sheet, stash the shared .apkg blob in Cache Storage, then redirect the
 *     page to a URL the page reads the blob from (works whether or not the
 *     app window was already open).
 *  2. App-shell caching so the inspector works fully offline once visited.
 */
'use strict';

var VERSION = 'anki-inspector-v1';
var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/parser.js',
  './js/worker.js',
  './js/fflate.min.js',
  './js/sql-wasm.js',
  './js/sql-wasm.wasm',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

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

  /* ---- 2) GET ------------------------------------------------------------- */
  event.respondWith(
    (async function () {
      // 2a) the page asks for the stashed shared file back
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

      // 2b) app shell: cache-first, network fallback
      var cached = await caches.match(event.request);
      if (cached) return cached;

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

/* ---- 3) legacy Web Share Target v1 (GET) — kept for older clients ---------- */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SHARE_TARGET') {
    event.respondWith(Response.redirect('./?url=' + encodeURIComponent(event.data.url), 302));
  }
});
