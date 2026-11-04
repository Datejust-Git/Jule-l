import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'wordpress/datejust-juleol/assets');
mkdirSync(target, { recursive: true });
let js = readFileSync(resolve(root, 'public/app.js'), 'utf8');
function replace(old, next) { if (!js.includes(old)) throw new Error('Source changed: ' + old.slice(0, 70)); js = js.replace(old, next); }
js = `const BASE = new URL(window.DATEJUST_JULEOL.base).pathname;
const API = window.DATEJUST_JULEOL.api;
const qrImages = new Map();
function qrImage(link) {
  if (!qrImages.has(link)) {
    const image = window.qrcode(0, 'M'); image.addData(link); image.make();
    qrImages.set(link, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(image.createSvgTag({ cellSize: 4, margin: 16, scalable: true })));
  }
  return qrImages.get(link);
}
` + js;
replace('`/?view=${target}&code=${encodeURIComponent(sessionCode)}`', '`${BASE}?view=${target}&code=${encodeURIComponent(sessionCode)}`');
replace('const imageUrl = `/api/sessions/${encodeURIComponent(state.session.code)}/qr.svg?origin=${encodeURIComponent(location.origin)}`;', "const imageUrl = qrImage(joinLink);");
replace('const response = await fetch(path, { method, signal, headers:', "const response = await fetch(API + path.slice(4), { method, signal, cache: 'no-store', credentials: 'omit', headers:");
replace('Authorization: `Bearer ${auth || token(role)}`', "'X-Datejust-Token': auth || token(role)");
const start = js.indexOf('function subscribe() {');
const end = js.indexOf('\nasync function load()', start);
if (start < 0 || end < 0) throw new Error('Missing live update function');
js = js.slice(0, start) + `function subscribe() {
  source?.close();
  let cancelled = false, timer, controller;
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
      if (acceptSession(data.session) && (changed || wasOffline)) {
        state.error = '';
        if (view === 'join' && token('participant')) await refreshMe();
        if (cancelled) return;
        render();
        if (view === 'join' && state.me && previousBeer && previousBeer !== state.session.activeBeerId) notify(state.session.activeBeerId ? 'Et nytt øl er klart for poeng!' : 'Runden er avsluttet.');
      }
    } catch {
      if (!cancelled && state.online) { state.online = false; render(); }
    } finally {
      clearTimeout(timeout);
      if (!cancelled) timer = setTimeout(poll, document.hidden ? 6000 : 2500);
    }
  };
  timer = setTimeout(poll, 500);
}
` + js.slice(end);
replace("for (const [selector, testid] of", "app.querySelectorAll('a[href=\"/\"]').forEach(link => { link.href = BASE; });\n  for (const [selector, testid] of");
writeFileSync(resolve(target, 'app.js'), js);
for (const name of ['index.html', 'styles.css', 'favicon.svg']) copyFileSync(resolve(root, 'public', name), resolve(target, name));
console.log('WordPress assets built from the original app.');
