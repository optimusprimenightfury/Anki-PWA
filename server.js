#!/usr/bin/env node
/**
 * Dependency-free static server for Anki Inspector.
 *
 *   node server.js                 # http://localhost:8080
 *   node server.js --port 9000     # custom port
 *   node server.js --lan           # also print LAN IPs
 *   node server.js --tunnel        # start a public tunnel (cloudflared if
 *                                  #   present, otherwise `npx localtunnel`)
 *
 * No middleware, no host allow-list: any origin can load the app (required for
 * the live preview + phone testing).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const ROOT = __dirname;
// NB: argv[indexOf('--port') + 1] resolves to argv[0] (the node binary) when the
// flag is absent, which parseInt()s to NaN — guard for it so bare `npm start`
// keeps its documented default port.
const PORT = parseInt(
  process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '8080', 10
);
const LAN = process.argv.includes('--lan');
const TUNNEL = process.argv.includes('--tunnel');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.apkg': 'application/octet-stream',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // serve only the app root (never escape it)
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-ish fallback: unknown paths → index.html (keeps share-target URLs working)
      if (req.method === 'GET' && !filePath.includes('.')) {
        fs.readFile(path.join(ROOT, 'index.html'), (e2, buf) => {
          if (e2) { res.writeHead(404).end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': buf.length });
          res.end(buf);
        });
        return;
      }
      res.writeHead(404).end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // allow the app to be embedded/tested anywhere
      'Access-Control-Allow-Origin': '*'
    };
    if (urlPath.endsWith('sql-wasm.wasm')) headers['Content-Type'] = 'application/wasm';

    const stream = fs.createReadStream(filePath);
    stream.on('open', () => { res.writeHead(200, headers); stream.pipe(res); });
    stream.on('error', () => { res.writeHead(500).end('Server error'); });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Anki Inspector server:');
  console.log(`  Local:   http://localhost:${PORT}`);
  if (LAN) {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  LAN:     http://${a.address}:${PORT}  (${name})`);
        }
      }
    }
  }
  if (TUNNEL) startTunnel(PORT);
});

function startTunnel(port) {
  execFile('which', ['cloudflared'], (err, stdout) => {
    if (!err && stdout.trim()) {
      console.log('  Tunnel:  starting cloudflared…');
      const p = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: 'inherit' });
      p.on('error', () => fallbackTunnel(port));
    } else {
      fallbackTunnel(port);
    }
  });
}

function fallbackTunnel(port) {
  console.log('  Tunnel:  no cloudflared found, trying npx localtunnel…');
  const p = spawn('npx', ['-y', 'localtunnel', '--port', String(port)], { stdio: 'inherit' });
  p.on('error', (e) => console.error('  Tunnel unavailable:', e.message));
}
