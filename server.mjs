import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { AppError, openStore } from './lib/store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new AppError(415, 'Send forespørselen som JSON.');
  }
  const content = await new Promise((accept, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        chunks = [];
        reject(new AppError(413, 'Forespørselen er for stor.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => accept(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  try {
    const parsed = JSON.parse(content || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new AppError(400, 'Forespørselen inneholder ugyldig JSON.');
  }
}

export function createApp(options = {}) {
  const store = openStore(options.dataDir ?? process.env.DATA_DIR ?? resolve(root, 'data'));
  const publicDir = resolve(options.publicDir ?? resolve(root, 'public'));
  const listeners = new Map();
  const limits = new Map();

  function rateLimit(req, key, max, windowMs) {
    if (options.rateLimit === false) return;
    const now = Date.now();
    const id = `${req.socket.remoteAddress}:${key}`;
    let item = limits.get(id);
    if (!item || item.expires <= now) {
      item = { count: 0, expires: now + windowMs };
      limits.set(id, item);
    }
    if (++item.count > max) throw new AppError(429, 'For mange forsøk. Vent litt og prøv igjen.');
  }

  function broadcast(code) {
    const clients = listeners.get(code);
    if (!clients?.size) return;
    const message = `event: state\ndata: ${JSON.stringify({ session: store.session(code) })}\n\n`;
    for (const res of clients) {
      if (!res.destroyed) res.write(message);
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      if (path.startsWith('/api/')) {
        const parts = path.split('/').filter(Boolean);
        if (parts[1] !== 'sessions') throw new AppError(404, 'Fant ikke denne adressen.');
        if (parts.length === 2 && req.method === 'POST') {
          rateLimit(req, 'create', 20, 3_600_000);
          return json(res, 201, store.create(await body(req)));
        }
        const code = parts[2]?.toUpperCase();
        if (!code || !/^[A-Z0-9]{6}$/.test(code)) throw new AppError(404, 'Fant ikke smakingen. Kontroller koden.');
        const action = parts[3];
        const supplied = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, { session: store.session(code) });
        if (req.method === 'GET' && action === 'me' && parts.length === 4) return json(res, 200, store.me(code, supplied));
        if (req.method === 'GET' && action === 'qr.svg' && parts.length === 4) {
          store.session(code);
          rateLimit(req, 'qr', 240, 60_000);
          const origin = url.searchParams.get('origin');
          let parsed;
          try {
            if (!origin || origin.length > 512 || !/^https?:\/\/[^/?#@]+\/?$/i.test(origin)) throw new Error();
            parsed = new URL(origin);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
          } catch {
            throw new AppError(400, 'QR-koden trenger en gyldig nettadresse uten sti eller innlogging.');
          }
          const svg = await QRCode.toString(`${parsed.origin}/?view=join&code=${code}`, {
            type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 256,
            color: { dark: '#17231c', light: '#ffffff' },
          });
          res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Content-Length': Buffer.byteLength(svg) });
          res.end(svg);
          return;
        }
        if (req.method === 'GET' && action === 'events' && parts.length === 4) {
          const initial = store.session(code);
          const count = [...listeners.values()].reduce((n, set) => n + set.size, 0);
          if (count >= 500) throw new AppError(503, 'For mange tilkoblinger. Prøv igjen om litt.');
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify({ session: initial })}\n\n`);
          if (!listeners.has(code)) listeners.set(code, new Set());
          listeners.get(code).add(res);
          req.on('close', () => {
            const clients = listeners.get(code);
            clients?.delete(res);
            if (!clients?.size) listeners.delete(code);
          });
          return;
        }
        let result;
        let status = 200;
        if (req.method === 'POST' && action === 'join' && parts.length === 4) {
          rateLimit(req, 'join', 120, 900_000);
          result = store.join(code, await body(req));
          status = 201;
        } else if (req.method === 'POST' && action === 'beers' && parts.length === 4) {
          rateLimit(req, 'mutation', 240, 60_000);
          result = store.addBeer(code, supplied, await body(req));
          status = 201;
        } else if (req.method === 'DELETE' && action === 'beers' && parts.length === 5) {
          rateLimit(req, 'mutation', 240, 60_000);
          result = store.deleteBeer(code, supplied, parts[4]);
        } else if (req.method === 'POST' && action === 'round' && parts.length === 4) {
          rateLimit(req, 'mutation', 240, 60_000);
          result = store.openRound(code, supplied, await body(req));
        } else if (req.method === 'POST' && action === 'round' && parts.length === 5 && parts[4] === 'close') {
          rateLimit(req, 'mutation', 240, 60_000);
          result = store.closeRound(code, supplied);
        } else if (req.method === 'POST' && action === 'scores' && parts.length === 4) {
          rateLimit(req, 'score', 600, 60_000);
          result = store.score(code, supplied, await body(req));
        } else {
          throw new AppError(404, 'Fant ikke denne adressen.');
        }
        json(res, status, result);
        broadcast(code);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'Metoden støttes ikke.');
      const file = resolve(publicDir, path === '/' ? 'index.html' : `.${path}`);
      if (!file.startsWith(`${publicDir}${sep}`) || path.includes('\0')) throw new AppError(404, 'Fant ikke denne adressen.');
      let data;
      try { data = await readFile(file); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') throw new AppError(404, 'Fant ikke denne adressen.');
        throw error;
      }
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AppError) return json(res, error.status, { error: error.message });
      if (error instanceof URIError) return json(res, 400, { error: 'Adressen er ugyldig.' });
      console.error('Server error:', error);
      json(res, 500, { error: 'Noe gikk galt. Prøv igjen.' });
    }
  });

  const heartbeat = setInterval(() => {
    for (const clients of listeners.values()) for (const res of clients) if (!res.destroyed) res.write(': heartbeat\n\n');
    const now = Date.now();
    for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    store,
    async close() {
      clearInterval(heartbeat);
      for (const clients of listeners.values()) for (const res of clients) res.end();
      listeners.clear();
      await new Promise((done) => { server.close(done); server.closeIdleConnections(); });
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  app.server.listen(port, host, () => console.log(`Juleøl kjører på port ${port}.`));
  app.server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
}
