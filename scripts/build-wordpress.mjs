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
const photoHelper = `
function beerPhoto(beer, className = 'beer-thumb') {
  return beer?.imageUrl ? '<img class="beer-photo ' + className + '" src="' + esc(beer.imageUrl) + '" alt="Bilde av ' + esc(beer.name) + '" loading="lazy" decoding="async">' : '';
}
async function smallBeerImage(file) {
  if (file.size > 15000000) throw new Error('Velg et bilde som er mindre enn 15 MB.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Kunne ikke åpne bildet. Prøv JPEG, PNG eller WebP.')); });
    const scale = Math.min(1, 400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const result = canvas.toDataURL('image/jpeg', quality);
      if (result.length < 155000) return result;
    }
    throw new Error('Bildet ble for stort. Prøv et enklere utsnitt.');
  } finally { URL.revokeObjectURL(objectUrl); }
}
`;
js = photoHelper + js;
replace('<div class="beer-info"><strong>', '${beerPhoto(beer)}<div class="beer-info"><strong>');
replace('<span class="beer-cell" role="cell"><strong>', '<span class="beer-cell" role="cell">${beerPhoto(beer, \'leader-thumb\')}<strong>');
replace('<div class="tasting-beer-icon">${icon(\'beer\')}</div>', '${beer.imageUrl ? beerPhoto(beer, \'tasting-photo\') : \'<div class="tasting-beer-icon">\'+icon(\'beer\')+\'</div>\'}');
replace('<div class="round-icon">${icon(\'beer\')}</div>', '<div class="round-icon">${active?.imageUrl ? beerPhoto(active, \'round-photo\') : icon(\'beer\')}</div>');
replace('<section class="tv-current"><span', '<section class="tv-current">${beerPhoto(beer, \'tv-current-photo\')}<span');
replace('<div class="beer-actions">', '<div class="beer-actions"><button class="button button-small button-outline image-upload" type="button" data-action="image-upload" data-id="${esc(beer.id)}" aria-label="${beer.imageUrl ? \'Bytt\' : \'Legg til\'} bilde av ${esc(beer.name)}" ${state.pending ? \'disabled\' : \'\'}>${beer.imageUrl ? \'Bytt bilde\' : \'Legg til bilde\'}</button>${beer.imageUrl ? `<button class="icon-button" type="button" data-action="image-remove" data-id="${esc(beer.id)}" aria-label="Fjern bilde av ${esc(beer.name)}">${icon(\'close\')}</button>` : \'\'}');
replace("if (state.pending) return;\n  if (['open-round'", `if (state.pending) return;
  if (action === 'image-upload') {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file || state.pending) return;
      state.pending = 'image'; render();
      try {
        const image = await smallBeerImage(file);
        const result = await api('/api/sessions/' + code + '/beers/' + button.dataset.id + '/image', { method: 'POST', role: 'admin', body: { image } });
        acceptSession(result.session); notify('Bildet er lagt til.');
      } catch (error) { notify(error.message, true); }
      finally { state.pending = ''; render(); }
    }, { once: true });
    input.click(); return;
  }
  if (action === 'image-remove') {
    state.pending = 'image'; render();
    try {
      const result = await api('/api/sessions/' + code + '/beers/' + button.dataset.id + '/image', { method: 'POST', role: 'admin', body: { image: '' } });
      acceptSession(result.session); notify('Bildet er fjernet fra ølet.');
    } catch (error) { notify(error.message, true); }
    finally { state.pending = ''; render(); }
    return;
  }
  if (['open-round'`);
writeFileSync(resolve(target, 'app.js'), js);
for (const name of ['index.html', 'styles.css', 'favicon.svg']) copyFileSync(resolve(root, 'public', name), resolve(target, name));
const css = `
/* Optional beer photos. Keep the whole bottle/label visible. */
.beer-photo{object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:6px;flex-shrink:0}
.beer-thumb{width:44px;height:58px}.leader-thumb{float:left;width:38px;height:50px;margin:0 12px 0 0}.beer-cell:has(.leader-thumb){min-height:50px}
.tasting-photo{display:block;width:100px;height:130px;margin:22px auto 14px}.round-photo{width:45px;height:58px}
.tv-current-photo{float:left;width:94px;height:126px;margin:0 24px 12px 0}.tv-current:after{content:'';display:block;clear:both}
.tv-leaderboard .leader-thumb{width:48px;height:64px}.beer-actions .image-upload{font-size:.68rem;white-space:nowrap}
@media(max-width:1100px){.beer-actions{flex-wrap:wrap}.beer-list-item{flex-wrap:wrap}.beer-actions{margin-left:33px}}
@media(max-width:700px){.beer-thumb{width:36px;height:48px}.beer-info{min-width:0}.leader-thumb{width:28px;height:38px;margin-right:7px}.tv-leaderboard .leader-thumb{width:32px;height:44px}.tv-current-photo{width:68px;height:90px;margin-right:16px}.tasting-photo{width:86px;height:112px}}
`;
writeFileSync(resolve(target, 'styles.css'), readFileSync(resolve(target, 'styles.css'), 'utf8') + css);
console.log('WordPress assets built from the original app.');
