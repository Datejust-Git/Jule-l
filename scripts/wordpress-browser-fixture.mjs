/**
 * Browser-test fixture for the generated WordPress frontend.
 *
 * This serves the plugin page/asset paths and adapts its REST transport to the
 * real Node app. It deliberately does not emulate WordPress or execute PHP;
 * PHP domain and upload behavior have their own tests.
 */
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = '/juleolsmaking/';
const assetPrefix = '/wp-content/plugins/datejust-juleol/assets/';
const restPrefix = '/wp-json/datejust-juleol/v1';
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function sendJson(res, status, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
}

async function jsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createWordPressFixture({ dataDir, publicDir } = {}) {
  if (!dataDir) throw new Error('WordPress browser fixture requires an isolated dataDir.');
  const assetsDir = resolve(publicDir ?? resolve(root, 'wordpress/datejust-juleol/assets'));
  const backend = createApp({ dataDir, rateLimit: false });
  await new Promise((done, reject) => {
    backend.server.once('error', reject);
    backend.server.listen(0, '127.0.0.1', done);
  });
  const backendPort = backend.server.address().port;
  const activeProxies = new Set();

  function proxy(req, res, path, { method = req.method, data, contentType, wordPress = false } = {}) {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !hopByHop.has(name) && name !== 'host'));
    if (wordPress) {
      const token = headers['x-datejust-token'];
      delete headers['x-datejust-token'];
      if (token) headers.authorization = `Bearer ${token}`;
    }
    if (data !== undefined) {
      delete headers['content-length'];
      delete headers['content-type'];
      if (data.length) {
        headers['content-length'] = String(data.length);
        headers['content-type'] = contentType;
      }
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: backendPort, path, method, headers }, response => {
      const safeHeaders = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !hopByHop.has(name)));
      res.writeHead(response.statusCode, safeHeaders);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    activeProxies.add(upstream);
    upstream.on('close', () => activeProxies.delete(upstream));
    upstream.on('error', () => sendJson(res, 502, 'Testserveren kunne ikke nå appen.'));
    res.on('close', () => upstream.destroy());
    if (data !== undefined) upstream.end(data);
    else req.pipe(upstream);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      // This fixture listens only on localhost; the Host is used as a test URL,
      // never as an upstream destination or a production trusted-proxy signal.
      const origin = `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      const path = decodeURIComponent(url.pathname);
      if (path.includes('\0')) return sendJson(res, 404, 'Fant ikke denne adressen.');

      if (path === restPrefix || path.startsWith(`${restPrefix}/`)) {
        const nodePath = `/api${url.pathname.slice(restPrefix.length)}${url.search}`;
        if (req.method === 'POST' && /^\/sessions\/[A-Z0-9]{6}\/beers\/[^/]+\/image$/i.test(path.slice(restPrefix.length))) {
          let input;
          try { input = await jsonBody(req); } catch { return sendJson(res, 400, 'Bildet må sendes som gyldig JSON.'); }
          if (input?.image === '') return proxy(req, res, nodePath, { method: 'DELETE', data: Buffer.alloc(0), wordPress: true });
          if (typeof input?.image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image)) {
            return sendJson(res, 400, 'Bruk et gyldig JPEG-bilde.');
          }
          const data = Buffer.from(input.image.slice('data:image/jpeg;base64,'.length), 'base64');
          return proxy(req, res, nodePath, { method: 'PUT', data, contentType: 'image/jpeg', wordPress: true });
        }
        return proxy(req, res, nodePath, { wordPress: true });
      }
      if (path.startsWith('/api/')) return proxy(req, res, `${url.pathname}${url.search}`);

      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, 'Metoden støttes ikke.');
      if (path === pagePath || path === pagePath.slice(0, -1)) {
        const nonce = randomBytes(18).toString('base64');
        const config = JSON.stringify({ base: `${origin}${pagePath}`, api: `${origin}${restPrefix}` }).replace(/</g, '\\u003c');
        let html = await readFile(resolve(assetsDir, 'index.html'), 'utf8');
        html = html.replace('href="/favicon.svg"', `href="${assetPrefix}favicon.svg"`)
          .replace('href="/styles.css"', `href="${assetPrefix}styles.css"`)
          .replace('src="/app.js"', `src="${assetPrefix}app.js"`)
          .replace('</head>', `<script nonce="${nonce}">window.DATEJUST_JULEOL=${config};</script><script src="${assetPrefix}qrcode.js"></script></head>`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`,
        });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (path.startsWith(assetPrefix)) {
        const file = resolve(assetsDir, path.slice(assetPrefix.length));
        if (!file.startsWith(`${assetsDir}${sep}`)) return sendJson(res, 404, 'Fant ikke denne adressen.');
        let data;
        try { data = await readFile(file); } catch (error) {
          if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return sendJson(res, 404, 'Fant ikke denne adressen.');
          throw error;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      return sendJson(res, 404, 'Denne testserveren tilbyr bare pluginens egne adresser.');
    } catch {
      sendJson(res, 500, 'Testserveren kunne ikke behandle forespørselen.');
    }
  });

  let closed = false;
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      for (const upstream of activeProxies) upstream.destroy();
      await new Promise(done => { server.close(done); server.closeAllConnections(); });
      await backend.close();
    },
  };
}
