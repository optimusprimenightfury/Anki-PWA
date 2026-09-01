# Anki Inspector — Serverless .apkg Inspection PWA

Inspect Anki `.apkg` packages **entirely on-device**: WebAssembly SQLite, in-memory
unzip, zero uploads, no server. Designed for phones and tablets.

- **Web Share Target API v2** — share any `.apkg` straight from the share sheet.
- **Web Worker offloading** — unzip (`fflate`) + SQLite (`sql.js` WASM) run inside
  a worker, so the UI never blocks or OOMs on hardware-constrained tablets.
- **Media mapping** — `media` JSON keys are mapped to real filenames; every image,
  SVG and audio file is extracted to a temporary `Blob URL` and `[sound:…]` /
  `<img src="…">` tags are rewritten to render instantly with zero network calls.
- **Compact single-line note list** — excessive `<br>` / `<p>` noise is stripped
  while formatting and inline SVGs are preserved; tap ▾ for full fields.
- **Editor bridge** — a ✏️ button per note tries `anki://` / Android
  `intent://com.ichi2.anki…` deep links (with a Play Store fallback URL) to open
  the note in the native Anki app.
- **Offline-capable** — service worker caches the app shell; parsing works offline.

## Live demo

A persistent tunnel is started during development; see the session for the current
URL. The app works at any static URL — deploy `main` to GitHub Pages (Settings →
Pages → `main` branch), Netlify Drop, Cloudflare Pages, or any static host.

## Run locally

```bash
npm start          # serves ./ on http://localhost:8080 (no deps)
npm test           # parser + worker pipeline tests (Node)
npm run test:dom   # UI wiring test (jsdom; npm i first)
```

Or just serve the folder with any static server (`python3 -m http.server 8080`).
No build step — plain ES5-compatible JavaScript + WebAssembly.

> ⚠️ Service workers and Web Share Target only work over **HTTPS** (or localhost).

## Testing on a phone

```bash
# LAN (same Wi-Fi)
node server.js --port 8080 --lan

# Public tunnel (persistent-ish URL, works on mobile data)
node server.js --port 8080 --tunnel
```

Use the generated `test/sample.apkg` to try it out:

1. `node test/make-sample.js` → creates `test/sample.apkg`
2. On Android: open the tunnel URL → **Install app** (Add to Home screen) →
   open Files → long-press `sample.apkg` → **Share** → **Anki Inspector**.
3. Or simply drag & drop / tap to pick the file in the browser.

## How sharing works

| Step | Who | What |
|------|-----|------|
| 1 | OS share sheet | POSTs `multipart/form-data` to the manifest `share_target.action` |
| 2 | Service worker | intercepts the POST, stashes the file in Cache Storage, redirects |
| 3 | Page | reads the blob back via `?fetch-shared=<key>`, hands it to the worker |
| 4 | Web Worker | `fflate.unzipSync` → `sql.js` WASM → SQL queries → media extraction |
| 5 | Page | maps media to `Blob URL`s, rewrites `<img>` / `[sound:]`, renders |

Also supported: `?apkg=<url>` (iOS share extensions) and legacy GET share targets.

## Architecture

```
index.html          app shell (manifest, SW registration hooks)
manifest.json       Web Share Target v2 + install metadata
sw.js               share-target POST interception + offline app shell
js/worker.js        worker entry: protocol + transferables
js/parser.js        env-agnostic parser core (worker & Node, tested)
js/app.js           main thread: UI, blob URLs, deep links, share handling
js/fflate.min.js    in-memory unzip (vendored)
js/sql-wasm.js|wasm WASM SQLite (vendored)
test/               sample .apkg generator + parser/worker tests (Node)
```

## Privacy

Everything runs client-side. The only network requests are the app's own assets
(and `?apkg=<url>` fetches you explicitly trigger). Your decks never leave the
device.
