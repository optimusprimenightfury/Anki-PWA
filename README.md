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

## Live demo & hosting

**Right now (this session):** the app is served over HTTPS as the live preview —
open it on your phone to test immediately. Note: this URL only lives while this
session runs; it is not persistent.

**Persistent free hosting — GitHub Pages (recommended, 2 taps):**
1. Merge the open pull request (`main` then contains the app; `404.html`,
   `.nojekyll`, relative paths are already in place).
2. On github.com (works from a phone browser): **Settings → Pages →
   Deploy from a branch → `main` → `/ (root)` → Save**.
The app is then permanently live (free HTTPS, installable, share target ready) at:
**`https://optimusprimenightfury.github.io/Anki-PWA/`**

**Temporary persistent alternative — GitHub Codespaces (no admin needed, free tier):**
1. Open the repo on github.com and create a Codespace (works from a phone browser).
2. Run `npm start` (or `node server.js`) inside the terminal.
3. Use the **Ports** panel → open the forwarded port → copy the HTTPS URL
   (format `https://<codespace-name>-8080.app.github.dev`).
That URL is persistent with SSL while the Codespace is running, and works exactly
like the localhost experience — no USB debugging, no desktop required.

**Other free hosts** (any static host works — all paths are relative):
Netlify (drag-drop or git import), Vercel, Cloudflare Pages (git import),
Render static sites, surge.sh (CLI). For a PWA that needs HTTPS + service
workers, GitHub Pages is the simplest free option.


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

## Share-sheet troubleshooting (Android)

If **Anki Inspector** doesn't show up when you tap **Share** on a `.apkg`:

1. **Install the app first.** Android only lists *installed* PWAs as share
   targets — open the site in Chrome → **Install app** / menu → *Add to Home
   screen*. The same steps are in the in-app help card on the landing screen.
2. **Share the file itself.** Use the **Files** app (or *Downloads*):
   long-press the `.apkg` → **Share** → Anki Inspector. Some apps share a text
   link instead of a file — the app will tell you when that happens.
3. **Give the WebAPK a minute.** Chrome refreshes installed web apps roughly
   once a day, so the share entry can lag the install by a bit. Open the app
   once, wait a minute, share again.
4. **Force an update (Chromium only):** open `chrome://webapks`, find
   *Anki Inspector*, tap **Update**. Last resort: uninstall and reinstall the
   PWA.
5. **Odd MIME types are covered.** File managers report `.apkg` as
   `application/octet-stream`, `application/zip`, sqlite variants — the
   manifest accept list covers all of them (plus `*/*`), so the app shows for
   any file share.
6. **App updates no longer need a reinstall.** Since service worker v2, the
   shell is fetched network-first and assets refresh in the background, so a
   deployed change appears on the next launch.

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
