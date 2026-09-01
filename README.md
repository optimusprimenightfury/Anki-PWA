# Anki Inspector — Serverless .apkg Inspection PWA

Inspect Anki `.apkg` packages **entirely on-device**: WebAssembly SQLite, in-memory
unzip, zero uploads, no server. Designed for phones and tablets.

> **What's new in v3.2** — *atomic self-updates*: every release now pins its
> HTML/JS/CSS with `?v=` and the service worker (v5) serves those files
> **network-first**, so an updated app can never keep running a mix of the old
> and new release (that mix was why the dismiss banner/dropzone stuck around
> and the pencil still went to the Play Store after a deploy). Image-occlusion
> parsing now speaks Anki's *actual* grammar — `{{c1::image-occlusion:rect:…}}`
> with all coordinates normalized, text font sizes as a fraction of the image
> height, and pre-release pixel-coordinate notes auto-detected. The card-type
> chips sit **above** the sort dropdown and a ↑/↓ button flips the sort order.
> The ✏️ pencil deep link gains a watchdog toast when no Anki app answers
> (still never a Play Store redirect).

- **Web Share Target API v2** — share any `.apkg` straight from the share sheet.
- **Web Worker offloading** — unzip (`fflate`) + SQLite (`sql.js` WASM) run inside
  a worker, so the UI never blocks or OOMs on hardware-constrained tablets.
- **Media mapping** — `media` JSON keys are mapped to real filenames; every image,
  SVG and audio file is extracted to a temporary `Blob URL` and `[sound:…]` /
  `<img src="…">` tags are rewritten to render instantly with zero network calls.
- **Image occlusion rendering** — Image Occlusion notes (Anki 23.10+/AnkiDroid
  2.20+ *and* the legacy "Image Occlusion Enhanced" add-on) are drawn as the real
  masked image: the base image with the occlusion shapes overlaid, plus a
  👁 Reveal button to see what is underneath. Both mask grammars are parsed:
  the marker-free tokens of early ports and the current
  `{{c1::image-occlusion:rect:top=.25:left=.2:…}}` serialization, with
  normalized coordinates (incl. text `fs`) and a fallback for pre-release
  pixel-coordinate notes.
- **Card-type filter chips** — a chip row **above** the sort dropdown toggles
  New / Learning / Review / Suspended / Buried / No-cards notes on and off,
  on top of whatever sort order is active; a ↑/↓ button flips the direction
  of the sort itself.
- **Compact single-line note list** — excessive `<br>` / `<p>` noise is stripped
  while formatting and inline SVGs are preserved; tap ▾ for full fields.
- **Editor bridge** — the ✏️ button per note opens the installed client at that
  exact note: AnkiDroid's registered deep link
  `anki://x-callback-url/browser?search=nid:<id>` (Card Browser pre-filtered —
  verified against AnkiDroid's `AndroidManifest.xml` intent filter, shipped
  since v2.17, Aug 2022) or AnkiMobile's `anki://x-callback-url/search?query=…`
  (2.0.90+). The `nid:` search term is copied to the clipboard as a fallback,
  and if no app answers within ~2 s a toast says what to paste. There is
  deliberately **no `intent://` wrapper and no Play Store fallback URL** — an
  `intent://` link carries the package name and Chrome bounces straight to the
  Store when nothing resolves it, which is exactly the old bug.
- **Offline-capable + self-updating** — the service worker (v5) caches the app
  shell for offline use, checks for updates whenever the app becomes visible,
  and reloads itself once with a toast when a new version lands — no
  reinstall. Each release pins its shell files with `?v=` and the worker serves
  them network-first, so a session can never end up running a half-updated mix
  of two releases.

## Supported package formats — legacy + new + upcoming

Every Anki export generation is read directly; **no "Support older Anki
versions" re-export needed**:

| Generation | Exported by | DB inside the zip | Metadata | Media index |
|---|---|---|---|---|
| Legacy 1 | Anki 2.0 | `collection.anki2` (SQLite schema 11, JSON `col`) | — | JSON |
| Legacy 2 | Anki 2.1 | `collection.anki21` (schema 11, JSON `col`) **+ dummy `collection.anki2`** | `meta` JSON | JSON |
| Latest | Anki 2.1.50+ / 23.x / 24.x+ | `collection.anki21b` — **zstd-compressed** SQLite, schema 18 (`notetypes`/`fields`/`decks` tables) | zstd+protobuf | zstd+protobuf `MediaEntries` |

Notes on that:

- Modern exports ship a **decoy `collection.anki2`** whose only note says
  *"Please update to the latest Anki version, then import the .colpkg/.apkg
  file again."* The inspector always prefers the newest real database
  (`anki21b` → `anki21` → `anki2`) and never shows that decoy. If you saw that
  message in an older version of this app — that was the decoy being read.
- zstd decompression uses the vendored `fzstd` (~8 KB) inside the worker.
- `.colpkg` (whole-collection exports) uses the same containers and is
  accepted everywhere `.apkg` is (file picker, drag & drop, share sheet).
- The parsed generation is shown in the stats line (e.g. `📦 Anki 2022+
  (anki21b)`) and the app version in the footer.

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

Use the generated samples to try it out:

1. `node test/make-sample.js` → creates `test/sample.apkg` (Anki 2.0),
   `test/sample-legacy2.apkg` (Anki 2.1 + decoy) and `test/sample-modern.apkg`
   (Anki 2022+: zstd + protobuf — what current Anki versions export)
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
6. **App updates no longer need a reinstall.** The shell is fetched
   network-first, assets refresh in the background, and an open app tab
   refreshes itself when a new version arrives (look for the footer version
   badge). If you were repeatedly told to *"install the latest version"*,
   either (a) the app was reading Anki's decoy note from a modern export —
   fixed by the multi-format parser — or (b) the installed copy was stuck on
   the very first service-worker cache — fixed since SW v2; opening the app
   once while online is enough.
7. **A deck shows only one "Please update…" note?** That note is a decoy Anki
   writes for ancient clients (see *Supported package formats*). Current
   versions of this app read the real database instead; reload the app once
   while online to make sure you have it.

## Architecture

```
index.html          app shell (manifest, SW registration hooks)
manifest.json       Web Share Target v2 + install metadata
sw.js               share-target POST interception + offline app shell (v3)
js/worker.js        worker entry: protocol + transferables
js/parser.js        env-agnostic parser core: all 3 package generations
js/app.js           main thread: UI, blob URLs, deep links, share handling,
                    self-update + install-state detection
js/fflate.min.js    in-memory unzip (vendored)
js/fzstd.min.js     zstd decompression for 2022+ packages (vendored)
js/sql-wasm.js|wasm WASM SQLite (vendored)
test/               sample generators (one package per generation) + tests
```

## Privacy

Everything runs client-side. The only network requests are the app's own assets
(and `?apkg=<url>` fetches you explicitly trigger). Your decks never leave the
device.
