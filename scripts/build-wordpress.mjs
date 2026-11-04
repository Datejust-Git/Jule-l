import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'wordpress/datejust-juleol/assets');
mkdirSync(target, { recursive: true });
let js = readFileSync(resolve(root, 'public/app.js'), 'utf8');

// Share the complete UI. Only transport and deployment seams differ in WordPress.
function replaceOnce(before, after) {
  const index = js.indexOf(before);
  if (index < 0 || js.indexOf(before, index + before.length) >= 0) {
    throw new Error('Expected one frontend deployment seam: ' + before.slice(0, 80));
  }
  js = js.slice(0, index) + after + js.slice(index + before.length);
}
function replaceFunction(name, replacement) {
  const pattern = new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^\\}', 'gm');
  const matches = [...js.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Expected one frontend function: ' + name);
  js = js.replace(pattern, () => replacement);
}

const bootstrap = `const BASE = new URL(window.DATEJUST_JULEOL.base, location.href).pathname;
const API = window.DATEJUST_JULEOL.api;
const qrImages = new Map();
function apiAddress(path) {
  const endpoint = new URL(API, location.href);
  const suffix = path.slice(4);
  if (endpoint.searchParams.has('rest_route')) {
    endpoint.searchParams.set('rest_route', endpoint.searchParams.get('rest_route').replace(/\\/$/, '') + suffix);
  } else endpoint.pathname = endpoint.pathname.replace(/\\/$/, '') + suffix;
  return endpoint.href;
}
function qrImage(link) {
  if (!qrImages.has(link)) {
    const image = window.qrcode(0, 'M'); image.addData(link); image.make();
    qrImages.set(link, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(image.createSvgTag({ cellSize: 4, margin: 16, scalable: true })));
  }
  return qrImages.get(link);
}
async function smallBeerImage(file) {
  validateImage(file);
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Kunne ikke åpne bildet. Prøv JPEG, PNG eller WebP.'));
      image.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) {
      throw new Error('Bildet har for høy oppløsning. Velg et bilde under 40 megapiksler.');
    }
    const scale = Math.min(1, 400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Nettleseren kunne ikke klargjøre bildet. Prøv en annen nettleser.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5, 0.4]) {
      const result = canvas.toDataURL('image/jpeg', quality);
      // Under 155 kB base64 is also under the server's 120 kB decoded JPEG limit.
      if (result.startsWith('data:image/jpeg;base64,') && result.length < 155000) return result;
    }
    throw new Error('Bildet ble for stort. Prøv et enklere utsnitt.');
  } finally { URL.revokeObjectURL(objectUrl); }
}
`;

replaceOnce('`/?view=${target}&code=${encodeURIComponent(sessionCode)}`', '`${BASE}?view=${target}&code=${encodeURIComponent(sessionCode)}`');
replaceOnce('const imageUrl = `/api/sessions/${encodeURIComponent(state.session.code)}/qr.svg?origin=${encodeURIComponent(location.origin)}`;', 'const imageUrl = qrImage(joinLink);');
replaceOnce('  document.title = state.session', `  app.querySelectorAll('a[href="/"]').forEach(link => { link.href = BASE; });
  document.title = state.session`);

replaceFunction('api', `async function api(path, { method = 'GET', body, role, auth, signal } = {}) {
  // The established WordPress route removes photos with an empty JSON image.
  if (method === 'DELETE' && path.endsWith('/image')) { method = 'POST'; body = { image: '' }; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(apiAddress(path), {
      method, signal: signal || controller.signal, cache: 'no-store', credentials: 'omit',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...((auth || role) ? { 'X-Datejust-Token': auth || token(role) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('Serveren svarte ikke som forventet. Prøv igjen.'); }
    if (!response.ok) { const error = new Error(data.error || data.message || 'Noe gikk galt. Prøv igjen.'); error.status = response.status; throw error; }
    return data;
  } finally { clearTimeout(timeout); }
}`);

replaceFunction('uploadBeerImage', `async function uploadBeerImage(beerId, file) {
  const image = await smallBeerImage(file);
  const result = await api('/api/sessions/' + code + '/beers/' + encodeURIComponent(beerId) + '/image', { method: 'POST', role: 'admin', body: { image } });
  acceptSession(result.session);
}`);

replaceFunction('subscribe', `function subscribe() {
  source?.close();
  let cancelled = false, timer, controller, refreshingMe = false;
  source = { close() { cancelled = true; clearTimeout(timer); controller?.abort(); } };
  const poll = async () => {
    if (cancelled) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const data = await api('/api/sessions/' + code, { signal: controller.signal });
      if (cancelled) return;
      const previousBeer = state.session?.activeBeerId;
      const changed = !state.session || data.session.revision > state.session.revision;
      const wasOffline = !state.online;
      state.online = true;
      if (wasOffline) state.failedImages.clear();
      if (acceptSession(data.session) && (changed || wasOffline)) {
        state.error = '';
        render();
        if (view === 'join' && state.me && previousBeer && previousBeer !== state.session.activeBeerId) notify(state.session.activeBeerId ? 'Et nytt øl er klart for poeng!' : 'Runden er avsluttet.');
      }
      // Private status must not delay public rounds, leaderboard or later polls.
      if (view === 'join' && token('participant') && !refreshingMe) {
        refreshingMe = true;
        refreshMe().then(() => { if (!cancelled) render(); })
          .catch(() => { if (!cancelled) notify('Poengstatusen din kunne ikke hentes. Neste oppdatering prøver igjen.', true); })
          .finally(() => { refreshingMe = false; });
      }
    } catch {
      if (!cancelled && state.online) { state.online = false; render(); }
    } finally {
      clearTimeout(timeout);
      if (!cancelled) timer = setTimeout(poll, document.hidden ? 6000 : 2500);
    }
  };
  timer = setTimeout(poll, 500);
}`);

js = bootstrap + js;
new Script(js, { filename: 'wordpress/datejust-juleol/assets/app.js' });
writeFileSync(resolve(target, 'app.js'), js);
for (const name of ['index.html', 'styles.css', 'favicon.svg']) {
  copyFileSync(resolve(root, 'public', name), resolve(target, name));
}
console.log('WordPress assets built from the shared frontend (photo upload, camera and evening averages included).');
