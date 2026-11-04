const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const view = ['host', 'join', 'tv'].includes(params.get('view')) ? params.get('view') : 'home';
const code = (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const state = { session: null, me: null, loading: view !== 'home', error: '', tab: params.has('code') ? 'join' : 'create', online: true, pending: '', qrFailed: false, ratings: {}, drafts: {}, recent: [], saved: {} };
let source;
let toastTimer;
let meRequest = 0;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const num = value => Number(value).toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (n, singular, multiple = singular) => `${n} ${n === 1 ? singular : multiple}`;
const url = (target, sessionCode = code) => `/?view=${target}&code=${encodeURIComponent(sessionCode)}`;
const tokenKey = (role, sessionCode = code) => `juleol:${role}:${sessionCode}`;
function read(key) { try { return storageAvailable.storage?.getItem(key) ?? null; } catch { return null; } }
function write(key, value) { requireStorage(); storageAvailable.storage.setItem(key, value); return true; }
const memoryTokens = {};
const storageAvailable = (() => {
  for (const kind of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[kind];
      const probe = `juleol:storage-check:${Date.now()}`;
      storage.setItem(probe, '1'); storage.removeItem(probe);
      return { storage, persistent: kind === 'localStorage' };
    } catch { /* Try same-tab storage before requiring browser settings. */ }
  }
  return { storage: null, persistent: false };
})();
function requireStorage() {
  if (!storageAvailable.storage) throw new Error('Nettleseren tillater ikke lagring. Tillat lagring for dette nettstedet før du oppretter eller blir med på en smaking.');
}
function acceptSession(incoming) {
  if (!state.session || incoming.revision >= state.session.revision) { state.session = incoming; return true; }
  return false;
}
const token = role => memoryTokens[role] || read(tokenKey(role));
function remember(sessionCode, name, role) {
  let recent;
  try { recent = JSON.parse(read('juleol:recent') || '[]'); } catch { recent = []; }
  if (!Array.isArray(recent)) recent = [];
  recent = [{ code: sessionCode, name, role }, ...recent.filter(item => item.code !== sessionCode || item.role !== role)].slice(0, 6);
  write('juleol:recent', JSON.stringify(recent));
}
function icon(name, className = '') {
  const paths = {
    tree: '<path d="m12 2-5 7h3l-5 7h5v6h4v-6h5l-5-7h3Z"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    tv: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
    cup: '<path d="M7 3h10v5c0 4-2 6-5 6s-5-2-5-6Zm0 2H3v3c0 3 2 4 5 4m9-7h4v3c0 3-2 4-5 4m-4 2v7m-4 0h8"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    beer: '<path d="M8 9h9l-1 12H9Zm9 2h3v6h-4M8 9a3 3 0 0 1-1-6 3 3 0 0 1 5 0 3 3 0 0 1 5 0 3 3 0 0 1 1 6M11 12v6m3-6v6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  };
  return `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.star}</svg>`;
}

function brand() { return `<a class="brand" href="/" aria-label="Juleøl – forsiden"><span class="brand-mark">${icon('tree')}</span><span>juleøl<span class="brand-period">.</span></span></a>`; }
function header(extra = '') { return `<header class="site-header">${brand()}<div class="header-right">${extra || '<span class="header-note">En smakfull tradisjon</span><a class="button button-small button-outline" href="#start" data-action="join-tab">Bli med på smaking '+icon('arrow')+'</a>'}</div></header>`; }
function footer() { return '<footer class="site-footer"><span>Gode smaker. Godt selskap.</span><span>Smak med omtanke.</span></footer>'; }
function beerArt() { return `<svg class="beer-art" viewBox="0 0 440 280" aria-hidden="true"><defs><pattern id="paper" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1" cy="2" r=".5" fill="#fff" opacity=".13"/></pattern></defs><ellipse cx="242" cy="245" rx="146" ry="15" fill="#421b22" opacity=".16"/><path d="M141 230V104c0-14 19-29 19-44V24h30v36c0 15 19 30 19 44v126q-34 13-68 0" fill="#354b40"/><path d="M159 22h32v9h-32z" fill="#d3b16e"/><path d="M144 121h62v83h-62z" fill="#f7eee0"/><path d="M145 128h60v70h-60z" fill="none" stroke="#c7aa76" stroke-width="1"/><path d="m175 141-12 19h7l-12 18h34l-12-18h7Z" fill="#6c242d"/><path d="M157 108v-9c0-10 12-22 12-33" fill="none" stroke="#6a7b68" stroke-width="4" stroke-linecap="round"/><path d="m240 95 12 136q24 13 48 0l12-136Z" fill="#eab968"/><path d="m244 129 10 97q22 9 44 0l10-97Z" fill="#a96134"/><path d="m246 139 9 86q4 4 10 4l-7-90Z" fill="#d89d53"/><path d="M240 95c-3-15 8-23 21-20 5-14 24-14 31-1 14-2 25 9 20 21v35c-11 6-21-5-32 0-12 5-24-4-36 1Z" fill="#faf0da"/><path d="M260 92c10-3 24-3 33-1" fill="none" stroke="#decba8" stroke-width="2" stroke-linecap="round"/><path d="M104 160c-21 6-34 22-43 41m17-18-25 1m38-13-19-10m-7 34-17 9m62-37 4-23" fill="none" stroke="#c3b18b" stroke-width="2"/><path d="m330 193 34-37m-20 24 21 1m-12-13-1-19m-20 42 12 5" fill="none" stroke="#c3b18b" stroke-width="2"/><path d="M223 43v14m-7-7h14m100 29v10m-5-5h10M99 75v10m-5-5h10m243 139v10m-5-5h10" stroke="#d1b376" stroke-width="2" stroke-linecap="round"/><circle cx="104" cy="123" r="2" fill="#d1b376"/><circle cx="321" cy="122" r="2" fill="#d1b376"/><path d="M120 235c5-10 10-13 18-14" fill="none" stroke="#c3b18b" stroke-width="2"/><rect x="0" y="0" width="440" height="280" fill="url(#paper)"/></svg>`; }

function home() {
  let recent = [];
  try { recent = JSON.parse(read('juleol:recent') || '[]'); } catch { /* New browser. */ }
  if (!Array.isArray(recent)) recent = [];
  return `${header()}<main id="main" class="home-main"><section class="hero"><div class="hero-intro"><div class="eyebrow"><span class="tiny-star">${icon('star')}</span> SAMLE GJENGEN. FINN FAVORITTEN.</div><h1>Julens beste øl?<br>Det avgjør <em>dere.</em></h1><p class="hero-description">Noen er mørke. Noen er krydrede. Alle har en mening. Samle vennene til juleølsmaking og la poengene tale.</p><div class="hero-art-wrap">${beerArt()}<div class="art-caption"><span>01 — 10</span><span>Små slurker.<br>Store meninger.</span></div></div></div><section class="start-card" id="start" aria-label="Start eller bli med på en smaking"><div class="card-kicker">DET BEGYNNER RUNDT BORDET</div><h2>Gjør klart for en<br>smakfull kveld.</h2><div class="tabs" role="tablist" aria-label="Velg hvordan du vil bli med"><button id="tab-create" type="button" role="tab" aria-selected="${state.tab === 'create'}" aria-controls="start-form" class="tab ${state.tab === 'create' ? 'active' : ''}" data-action="create-tab">Arranger smaking</button><button id="tab-join" type="button" role="tab" aria-selected="${state.tab === 'join'}" aria-controls="start-form" class="tab ${state.tab === 'join' ? 'active' : ''}" data-action="join-tab">Bli med</button></div><div id="start-form" role="tabpanel" aria-labelledby="tab-${state.tab}">${state.tab === 'create' ? `<form data-form="create" class="stack-form"><label for="session-name">Hva heter smakingen?</label><input id="session-name" name="name" maxlength="80" required placeholder="F.eks. Juleøl hos oss" autocomplete="off"><p class="input-help">Du legger til ølene etterpå. Deltakerne blir med med en kode.</p><button class="button button-primary button-block" ${state.pending ? 'disabled' : ''}>${state.pending === 'create' ? 'Gjør klart …' : 'Opprett smaking '+icon('arrow')}</button></form>` : `<form data-form="join" class="stack-form"><label for="join-code">Kode til smakingen</label><input id="join-code" class="code-input" name="code" maxlength="8" required placeholder="ABC123" value="${esc(code)}" autocapitalize="characters" autocomplete="off" spellcheck="false"><label for="join-name">Navnet ditt</label><input id="join-name" name="name" maxlength="40" required placeholder="F.eks. Nora" autocomplete="given-name"><button class="button button-primary button-block" ${state.pending ? 'disabled' : ''}>${state.pending === 'join' ? 'Finner plassen din …' : 'Bli med på smakingen '+icon('arrow')}</button></form>`}</div><div class="card-footnote">${icon('check')} Ingen konto. Bare godt selskap.</div></section></section><section class="how-it-works" aria-label="Slik fungerer det"><div class="section-intro"><span class="eyebrow">LAV TERSKEL. GOD STEMNING.</span><h2>Fra første skål<br>til kveldens vinner.</h2></div><div class="step"><span class="step-number">01</span><h3>Sett ølene på bordet</h3><p>Legg inn kveldens øl og del koden med gjengen.</p></div><div class="step"><span class="step-number">02</span><h3>Smak og gi poeng</h3><p>Alle gir 1–10 poeng på mobilen. Helt etter egen smak.</p></div><div class="step"><span class="step-number">03</span><h3>Følg spenningen</h3><p>Se hvem som mangler å stemme og hvem som leder på TV-en.</p></div></section>${recent.length ? `<section class="recent-section"><div class="section-title"><h2>Tilbake til bordet</h2><span>På denne enheten</span></div><div class="recent-grid">${recent.filter(item => item && typeof item.code === 'string').map(item => `<a class="recent-card" href="${url(item.role === 'admin' ? 'host' : 'join', item.code)}"><span class="recent-icon">${icon(item.role === 'admin' ? 'beer' : 'users')}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.code)} · ${item.role === 'admin' ? 'Arrangør' : 'Deltaker'}</small></span>${icon('arrow')}</a>`).join('')}</div></section>` : ''}</main>${footer()}`;
}

function qrInvite(isTv = false) {
  const joinLink = new URL(url('join', state.session.code), location.origin).href;
  const imageUrl = `/api/sessions/${encodeURIComponent(state.session.code)}/qr.svg?origin=${encodeURIComponent(location.origin)}`;
  const localOnly = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) || location.hostname.endsWith('.localhost');
  return `<figure class="qr-invite ${isTv ? 'qr-invite-tv' : ''}"><a class="qr-image-link" href="${esc(joinLink)}" target="_blank" rel="noopener" aria-label="Åpne deltakersiden til ${esc(state.session.name)}" ${state.qrFailed ? 'hidden' : ''}><img class="join-qr" data-testid="join-qr" src="${esc(imageUrl)}" alt="QR-kode: bli med på ${esc(state.session.name)}" width="256" height="256" decoding="async"></a><figcaption><p class="qr-load-error" role="status" ${state.qrFailed ? '' : 'hidden'}>QR-koden kunne ikke lastes. Bruk lenken under, eller last siden på nytt.</p><a class="qr-site-link" href="${esc(joinLink)}" target="_blank" rel="noopener" aria-label="Deltakerlenke på ${esc(location.host)}">${esc(location.host)}</a>${localOnly ? '<p class="qr-local-note">Åpne appen på en delt nettadresse før du deler QR-koden.</p>' : ''}</figcaption></figure>`;
}

function connection() { return !state.online ? `<div class="connection-banner" role="status">${icon('clock')} Forbindelsen er brutt. Vi kobler til igjen automatisk.</div>` : ''; }
function meta(beer) { return [beer.brewery, beer.abv !== null && beer.abv !== undefined && beer.abv !== '' ? `${String(beer.abv).replace('.', ',')} %` : ''].filter(Boolean).map(esc).join(' <span aria-hidden="true">·</span> ') || 'Klar for en smak'; }
function ranking() {
  const beers = [...state.session.beers].sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1) || b.totalScore - a.totalScore || a.order - b.order);
  let previous, rank;
  return beers.map((beer, index) => {
    if (!previous || previous.averageScore !== beer.averageScore || previous.totalScore !== beer.totalScore) rank = index + 1;
    previous = beer;
    return { ...beer, rank: beer.scoreCount ? rank : null };
  });
}
function leaderboard(tv = false) {
  const beers = ranking();
  return `<section class="panel leaderboard ${tv ? 'tv-leaderboard' : ''}"><div class="panel-heading"><div><span class="eyebrow">KVELDENS FAVORITTER</span><h2>Resultattavlen</h2></div><span class="panel-icon">${icon('cup')}</span></div><p class="panel-description">Rangert etter gjennomsnitt · 1–10 poeng</p>${!beers.length ? `<div class="empty-state">${icon('cup')}<h3>Hvem blir kveldens favoritt?</h3><p>Resultatene dukker opp her når ølene er lagt til.</p></div>` : `<div class="leader-table" role="table" aria-label="Ølenes plassering"><div class="leader-row leader-head" role="row"><span role="columnheader">Plass</span><span role="columnheader">Øl</span><span role="columnheader">Stemmer</span><span role="columnheader">Snitt</span></div>${beers.map(beer => `<div class="leader-row ${beer.rank === 1 ? 'leader-first' : ''} ${beer.id === state.session.activeBeerId ? 'leader-active' : ''}" role="row"><span class="rank ${beer.rank === 1 ? 'rank-first' : ''}" role="cell">${beer.rank === 1 ? '<span class="sr-only">1</span>'+icon('cup') : beer.rank || '–'}</span><span class="beer-cell" role="cell"><strong>${esc(beer.name)}</strong><small>${meta(beer)}${beer.id === state.session.activeBeerId ? '<span class="now-label">Smakes nå</span>' : ''}</small></span><span class="vote-count" role="cell">${beer.scoreCount}<span class="mobile-vote-label"> stemmer</span></span><span class="score-number" role="cell">${beer.scoreCount ? num(beer.averageScore) : '–'}</span></div>`).join('')}</div>`}</section>`;
}
function participants(tv = false) {
  const s = state.session;
  const active = s.beers.find(beer => beer.id === s.activeBeerId);
  const waiting = s.participants.filter(person => !person.hasScored);
  return `<section class="panel people-panel ${tv ? 'tv-people' : ''}"><div class="panel-heading"><div><span class="eyebrow">RUNDT BORDET</span><h2>${active ? 'Vi venter på …' : 'Gjengen'}</h2></div><span class="count-badge">${s.participantCount}</span></div>${!s.participants.length ? `<div class="empty-state compact">${icon('users')}<h3>Plass til hele gjengen</h3><p>Bli med med koden <strong>${esc(s.code)}</strong>.</p></div>` : active ? `<div class="vote-progress"><div><strong>${s.scoredCount} av ${s.participantCount}</strong><span>har gitt poeng</span></div><progress max="${Math.max(s.participantCount, 1)}" value="${s.scoredCount}" aria-label="${s.scoredCount} av ${s.participantCount} har gitt poeng"></progress></div>${!waiting.length ? `<div class="all-done">${icon('check')}<div><strong>Alle har gitt poeng!</strong><p>Klar for neste smak.</p></div></div>` : `<div class="people-list">${waiting.map(person => `<div class="person"><span class="avatar">${esc(person.name.slice(0, 1).toLocaleUpperCase('nb-NO'))}</span><span>${esc(person.name)}</span>${icon('clock')}</div>`).join('')}</div>`}${s.scoredCount ? `<div class="done-people">${icon('check')} ${s.participants.filter(person => person.hasScored).map(person => esc(person.name)).join(', ')} har stemt</div>` : ''}` : `<p class="panel-description">Deltakerne er klare. Arrangøren åpner en smaksrunde.</p><div class="people-list">${s.participants.map(person => `<div class="person"><span class="avatar">${esc(person.name.slice(0, 1).toLocaleUpperCase('nb-NO'))}</span><span>${esc(person.name)}</span><span class="ready-dot" aria-label="Klar"></span></div>`).join('')}</div>`}</section>`;
}
function host() {
  const s = state.session;
  const active = s.beers.find(beer => beer.id === s.activeBeerId);
  return `${header(`<span class="role-badge">Arrangør</span><a class="button button-small button-outline" href="${url('tv')}" target="_blank" rel="noopener">${icon('tv')} Åpne TV-visning</a>`)}${connection()}<main id="main" class="dashboard"><div class="page-heading"><div><span class="eyebrow">VELKOMMEN TIL BORDET</span><h1>${esc(s.name)}</h1><p>Legg inn ølene, samle gjengen og åpne den første smaksrunden.</p></div><div class="session-code"><span>DEL KODEN MED GJENGEN</span><strong>${esc(s.code)}</strong><button class="text-button" data-action="copy-link">${icon('copy')} Kopier deltakerlenke</button></div></div><div class="host-layout"><div class="main-column"><section class="round-card ${active ? 'is-active' : ''}"><div class="round-icon">${icon('beer')}</div><div class="round-content"><span class="eyebrow">${active ? '<span class="live-dot"></span> SMAKES NÅ' : 'NESTE GODE SMAK'}</span><h2>${active ? esc(active.name) : 'Klar for første skål?'}</h2><p>${active ? meta(active) : 'Legg til ølene under og velg et øl for å åpne poenggivningen.'}</p></div>${active ? `<button class="button button-light" data-action="close-round" ${state.pending ? 'disabled' : ''}>Avslutt runden ${icon('check')}</button>` : ''}</section><section class="panel beer-panel"><div class="panel-heading"><div><span class="eyebrow">PÅ SMAKSMENYEN</span><h2>Kveldens øl <span class="heading-count">${s.beers.length}</span></h2></div></div>${s.beers.length ? `<ol class="beer-list">${s.beers.map((beer, index) => `<li class="beer-list-item ${beer.id === s.activeBeerId ? 'selected' : ''}"><span class="beer-order">${String(index + 1).padStart(2, '0')}</span><div class="beer-info"><strong>${esc(beer.name)}</strong><small>${meta(beer)}${beer.scoreCount ? ` · ${plural(beer.scoreCount, 'stemme', 'stemmer')}` : ''}</small></div><div class="beer-actions">${beer.id === s.activeBeerId ? '<span class="status-pill"><span class="live-dot"></span> Smakes nå</span>' : `<button class="button button-small button-outline" data-action="open-round" data-id="${esc(beer.id)}" ${state.pending ? 'disabled' : ''}>${beer.scoreCount ? 'Åpne igjen' : 'Start runde'} ${icon('arrow')}</button>`}${!beer.scoreCount && beer.id !== s.activeBeerId ? `<button class="icon-button remove-beer" data-action="delete-beer" data-id="${esc(beer.id)}" aria-label="Fjern ${esc(beer.name)}" title="Fjern ølet">${icon('close')}</button>` : ''}</div></li>`).join('')}</ol>` : '<div class="empty-state compact"><h3>Et blankt ark. Mange gode smaker.</h3><p>Begynn med å legge til det første ølet.</p></div>'}<form data-form="beer" class="add-beer-form"><h3>${icon('plus')} Legg til et øl</h3><div class="beer-form-grid"><div class="field field-beer"><label for="beer-name">Navn på ølet <span aria-hidden="true">*</span></label><input id="beer-name" name="name" required maxlength="100" placeholder="F.eks. Julebokk" autocomplete="off"></div><div class="field field-brewery"><label for="beer-brewery">Bryggeri <span class="optional">valgfritt</span></label><input id="beer-brewery" name="brewery" maxlength="80" placeholder="F.eks. Aass" autocomplete="off"></div><div class="field field-abv"><label for="beer-abv">Alkohol %</label><input id="beer-abv" name="abv" type="number" step="0.1" min="0" max="100" inputmode="decimal" placeholder="6,5"></div><button class="button button-primary add-beer-button" ${state.pending ? 'disabled' : ''}>${icon('plus')} ${state.pending === 'beer' ? 'Legger til …' : 'Legg til'}</button></div></form></section>${leaderboard()}</div><aside class="side-column"><section class="panel invitation-panel"><span class="panel-icon">${icon('users')}</span><h2>Smak bedre sammen.</h2><p>Skann QR-koden med mobilkameraet og bli med på denne smakingen.</p>${qrInvite()}<button class="button button-outline button-block" data-action="copy-link">${icon('copy')} Kopier invitasjonslenke</button><a class="text-button" href="${url('join')}" target="_blank" rel="noopener">Bli med selv ${icon('arrow')}</a></section>${participants()}</aside></div><p class="privacy-note">${icon('check')} Smakingen lagres automatisk. ${storageAvailable.persistent ? 'Arrangørtilgangen er lagret i denne nettleseren.' : 'Tilgangen lagres bare i denne fanen. Behold fanen åpen.'}</p></main>${footer()}`;
}
function joinForm() {
  return `${header('<a class="text-button" href="/">'+icon('back')+' Til forsiden</a>')}<main id="main" class="join-main"><section class="join-card panel"><div class="join-tree">${icon('tree')}</div><span class="eyebrow">DET ER PLASS TIL DEG OGSÅ</span><h1>${state.session ? esc(state.session.name) : 'Bli med rundt bordet.'}</h1><p>Godt øl og gode meninger. Hva skal vi kalle deg?</p><form data-form="join" class="stack-form"><label for="join-code">Kode til smakingen</label><input id="join-code" class="code-input" name="code" maxlength="8" value="${esc(code)}" placeholder="ABC123" required autocomplete="off" spellcheck="false" autocapitalize="characters"><label for="join-name">Navnet ditt</label><input id="join-name" name="name" maxlength="40" placeholder="F.eks. Nora" required autocomplete="given-name"><button class="button button-primary button-block" ${state.pending ? 'disabled' : ''}>${state.pending === 'join' ? 'Finner plassen din …' : 'Sett deg til bords '+icon('arrow')}</button></form></section></main>${footer()}`;
}
function participant() {
  const s = state.session;
  const me = s.participants.find(person => person.id === state.me.participantId);
  const beer = s.beers.find(item => item.id === s.activeBeerId);
  const saved = beer && state.me.scores?.[beer.id];
  const selected = beer ? state.ratings[beer.id] ?? saved : null;
  return `${header(`<span class="participant-greeting">${icon('users')} Hei, ${esc(me?.name || 'du')}!</span>`)}${connection()}<main id="main" class="participant-main"><div class="participant-heading"><span class="eyebrow">${esc(s.code)} · ${esc(s.name)}</span></div>${!storageAvailable.persistent ? '<p class="tab-storage-note">Tilgangen din lagres bare i denne fanen. Behold fanen åpen.</p>' : ''}${beer ? `<section class="tasting-card"><div class="tasting-label"><span class="live-dot"></span> SMAKES NÅ <span>ØL ${s.beers.findIndex(item => item.id === beer.id) + 1} AV ${s.beers.length}</span></div><div class="tasting-beer-icon">${icon('beer')}</div><h1>${esc(beer.name)}</h1><p class="tasting-meta">${meta(beer)}</p><div class="rating-divider"><span>HVA SYNES DU?</span></div><h2>Din smak. Dine poeng.</h2><p class="rating-description">Gi ølet fra 1 til 10 poeng.</p><form data-form="score" data-beer="${esc(beer.id)}"><fieldset class="rating-fieldset"><legend class="sr-only">Velg poeng fra 1 til 10</legend><div class="rating-grid">${Array.from({ length: 10 }, (_, index) => index + 1).map(score => `<button type="button" class="rating-button ${selected === score ? 'selected' : ''}" data-action="rate" data-score="${score}" aria-pressed="${selected === score}" aria-label="${score} poeng">${score}</button>`).join('')}</div><div class="rating-scale"><span>Ikke helt min smak</span><span>En ny julefavoritt</span></div></fieldset><button class="button button-primary button-block submit-score" ${!selected || state.pending ? 'disabled' : ''}>${state.pending === 'score' ? 'Lagrer poengene …' : saved && saved === selected ? icon('check')+' Poengene dine er lagret' : (saved ? 'Oppdater til ' : 'Gi ') + (selected ? selected+' poeng' : 'poeng') + ' '+icon('arrow')}</button>${saved ? `<p class="vote-confirmation">${icon('check')} Du har gitt ${saved} poeng. Du kan endre mens runden er åpen.</p>` : '<p class="rating-note">Poengene lagres når du trykker på knappen.</p>'}</form></section>` : `<section class="tasting-card waiting-card"><div class="waiting-decoration">${icon('beer')}${icon('star')}</div><span class="eyebrow">GODT SELSKAP TAR DEN TIDEN DET TAR</span><h1>${Object.keys(state.me.scores || {}).length ? 'Takk for smaken!' : 'Du er med!'}</h1><p>${s.beers.length ? 'Arrangøren åpner neste smaksrunde. Vi oppdaterer siden for deg når det er klart.' : 'Gjengen samles og ølene gjøres klare. Første øl dukker opp her når smakingen begynner.'}</p><div class="waiting-status"><span class="loading-dot"></span> Venter på arrangøren</div></section>`}<div class="participant-results">${leaderboard()}${participants()}</div></main>${footer()}`;
}
function tv() {
  const s = state.session;
  const beer = s.beers.find(item => item.id === s.activeBeerId);
  return `<div class="tv-shell"><header class="tv-header">${brand()}<div class="tv-session-name">${esc(s.name)}</div><div class="tv-live"><span class="live-dot"></span> DIREKTE <button class="icon-button" data-action="fullscreen" aria-label="Vis i fullskjerm" title="Vis i fullskjerm">${icon('expand')}</button></div></header>${connection()}<main id="main" class="tv-main"><div class="tv-top"><section class="tv-current"><span class="eyebrow">${beer ? 'I GLASSET AKKURAT NÅ' : 'VELKOMMEN TIL JULEØLSMAKING'}</span><h1>${beer ? esc(beer.name) : 'God smak. Godt selskap.'}</h1><p>${beer ? meta(beer) : 'Arrangøren åpner en smaksrunde når gjengen er klar.'}</p>${beer ? `<div class="tv-round-number">ØL ${s.beers.findIndex(item => item.id === beer.id) + 1}<span> / ${s.beers.length}</span></div>` : ''}</section><aside class="tv-code tv-qr-card">${qrInvite(true)}<div class="tv-join-details"><span class="tv-join-kicker">BLI MED PÅ MOBILEN</span><h2>Skann og smak.</h2><p>Åpne mobilkameraet og skann QR-koden.</p><span class="tv-manual-label">ELLER BRUK KODEN</span><strong>${esc(s.code)}</strong></div></aside></div><div class="tv-grid">${leaderboard(true)}${participants(true)}</div></main><footer class="tv-footer"><span>Gode smaker. Ærlige poeng.</span><span>Resultatene oppdateres automatisk <span class="live-dot"></span></span></footer></div>`;
}
function errorPage() { return `${header('<a class="text-button" href="/">'+icon('back')+' Til forsiden</a>')}<main id="main" class="join-main"><section class="panel join-card error-card">${icon('beer')}<h1>Vi fant ikke bordet.</h1><p>${esc(state.error)}</p><a href="/" class="button button-primary">Til forsiden ${icon('arrow')}</a><button class="text-button" data-action="retry">Prøv igjen</button></section></main>${footer()}`; }
function preserveDrafts() {
  app.querySelectorAll('form input').forEach(input => { state.drafts[input.id] = input.value; });
}
function render() {
  preserveDrafts();
  const activeElement = document.activeElement;
  const focused = activeElement?.id;
  const focusedAction = activeElement?.dataset?.action;
  const focusedDataId = activeElement?.dataset?.id;
  const focusedScore = activeElement?.dataset?.score;
  const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  document.body.classList.toggle('is-tv', view === 'tv');
  if (state.loading) app.innerHTML = `${header('<span class="header-note">Vi finner bordet ditt …</span>')}<main id="main" class="initial-loading"><span class="loading-dot"></span> Gjør klart rundt bordet …</main>`;
  else if (state.error) app.innerHTML = errorPage();
  else if (view === 'home') app.innerHTML = home();
  else if (view === 'tv') app.innerHTML = tv();
  else if (view === 'host') app.innerHTML = host();
  else app.innerHTML = state.me?.role === 'participant' ? participant() : joinForm();
  app.querySelectorAll('form input').forEach(input => { if (Object.hasOwn(state.drafts, input.id)) input.value = state.drafts[input.id]; });
  if (focused || focusedAction) {
    const element = focused ? document.getElementById(focused) : [...app.querySelectorAll('[data-action]')].find(el => el.dataset.action === focusedAction && el.dataset.id === focusedDataId && el.dataset.score === focusedScore);
    if (element) {
      element.focus({ preventScroll: true });
      if (selection && typeof selection[0] === 'number' && element.type !== 'number') element.setSelectionRange(...selection);
    }
  }
  for (const [selector, testid] of [['[data-form="create"]','create-form'],['[data-form="join"]','join-form'],['[data-form="beer"]','beer-form'],['.submit-score','score-submit'],['.leaderboard','leaderboard'],['.people-list','pending-list'],['.connection-banner','connection-status']]) app.querySelector(selector)?.setAttribute('data-testid', testid);
  app.querySelectorAll('[data-score]').forEach(el => el.setAttribute('data-testid', `score-${el.dataset.score}`));
  document.title = state.session ? `${state.session.name} — Juleøl` : 'Juleøl — finn kveldens favoritt';
}
function notify(message, isError = false) {
  const area = document.querySelector('#notifications');
  area.innerHTML = `<div class="toast ${isError ? 'toast-error' : ''}" role="${isError ? 'alert' : 'status'}">${icon(isError ? 'close' : 'check')}<span>${esc(message)}</span><button class="icon-button" data-action="dismiss-toast" aria-label="Lukk melding">${icon('close')}</button></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { area.innerHTML = ''; }, isError ? 9000 : 4500);
}
async function api(path, { method = 'GET', body, role, auth, signal } = {}) {
  const response = await fetch(path, { method, signal, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...((auth || role) ? { Authorization: `Bearer ${auth || token(role)}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let data;
  try { data = await response.json(); } catch { throw new Error('Serveren svarte ikke som forventet. Prøv igjen.'); }
  if (!response.ok) { const error = new Error(data.error || 'Noe gikk galt. Prøv igjen.'); error.status = response.status; throw error; }
  return data;
}
async function refreshMe() {
  const role = view === 'host' ? 'admin' : 'participant';
  if (!token(role)) { state.me = null; return; }
  const request = ++meRequest;
  try { const me = await api(`/api/sessions/${code}/me`, { role }); if (request === meRequest) state.me = me; }
  catch (error) { if (error.status === 401 || error.status === 403) { state.me = null; if (view === 'host') throw new Error('Arrangørtilgangen finnes ikke i denne nettleseren. Åpne smakingen på enheten der du opprettet den.'); } else throw error; }
}
function subscribe() {
  source?.close();
  source = new EventSource(`/api/sessions/${code}/events`);
  source.onopen = () => { if (!state.online) { state.online = true; render(); } };
  source.onerror = () => { if (state.online) { state.online = false; render(); } };
  source.addEventListener('state', async event => {
    try {
      const data = JSON.parse(event.data);
      if (!data.session) return;
      const previousBeer = state.session?.activeBeerId;
      if (!acceptSession(data.session)) return;
      state.error = '';
      render();
      if (view === 'join' && token('participant')) {
        try { await refreshMe(); render(); }
        catch { notify('Poengstatusen din kunne ikke hentes. Neste oppdatering prøver igjen.', true); }
      }
      if (view === 'join' && state.me && previousBeer && previousBeer !== state.session.activeBeerId) notify(state.session.activeBeerId ? 'Et nytt øl er klart for poeng!' : 'Runden er avsluttet.');
    } catch { /* A reconnect or next update recovers transient errors. */ }
  });
}
async function load() {
  if (view === 'home') { state.loading = false; render(); return; }
  if (!code) { state.loading = false; if (view !== 'join') state.error = 'Legg til en gyldig kode for smakingen.'; render(); return; }
  state.loading = true;
  state.error = '';
  render();
  try {
    const data = await api(`/api/sessions/${code}`);
    acceptSession(data.session);
    if (view !== 'tv') await refreshMe();
    if (view === 'host' && state.me?.role !== 'admin') throw new Error('Arrangørtilgangen finnes ikke i denne nettleseren. Åpne smakingen på enheten der du opprettet den.');
    subscribe();
  } catch (error) { state.error = error.message; }
  finally { state.loading = false; render(); }
}

document.addEventListener('error', event => {
  if (!event.target.matches?.('.join-qr')) return;
  state.qrFailed = true;
  const figure = event.target.closest('.qr-invite');
  if (figure) {
    figure.querySelector('.qr-image-link').hidden = true;
    figure.querySelector('.qr-load-error').hidden = false;
  }
}, true);

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (state.pending) return;
  const type = form.dataset.form;
  const data = Object.fromEntries(new FormData(form));
  const beerId = form.dataset.beer;
  state.pending = type;
  render();
  try {
    if (type === 'create') {
      requireStorage();
      const result = await api('/api/sessions', { method: 'POST', body: { name: data.name.trim() } });
      memoryTokens.admin = result.adminToken;
      write(tokenKey('admin', result.code), result.adminToken);
      remember(result.code, result.session.name, 'admin');
      location.assign(url('host', result.code));
    } else if (type === 'join') {
      requireStorage();
      const targetCode = data.code.trim().toUpperCase();
      const existingToken = read(tokenKey('participant', targetCode));
      if (existingToken) {
        try { await api(`/api/sessions/${encodeURIComponent(targetCode)}/me`, { auth: existingToken }); location.assign(url('join', targetCode)); return; } catch { /* An expired local token can be replaced with a new join. */ }
      }
      const result = await api(`/api/sessions/${encodeURIComponent(targetCode)}/join`, { method: 'POST', body: { name: data.name.trim() } });
      memoryTokens.participant = result.participantToken;
      write(tokenKey('participant', targetCode), result.participantToken);
      remember(targetCode, result.session.name, 'participant');
      location.assign(url('join', targetCode));
    } else if (type === 'beer') {
      const result = await api(`/api/sessions/${code}/beers`, { method: 'POST', role: 'admin', body: { name: data.name.trim(), brewery: data.brewery.trim(), abv: data.abv === '' ? null : Number(data.abv) } });
      acceptSession(result.session);
      for (const key of ['beer-name', 'beer-brewery', 'beer-abv']) state.drafts[key] = '';
      form.reset();
      app.querySelectorAll('[data-form="beer"] input').forEach(input => { input.value = ''; });
      notify('Ølet er lagt til på smaksmenyen.');
    } else if (type === 'score') {
      const score = state.ratings[beerId] ?? state.me.scores?.[beerId];
      const result = await api(`/api/sessions/${code}/scores`, { method: 'POST', role: 'participant', body: { score, beerId } });
      acceptSession(result.session);
      await refreshMe();
      notify(`${score} poeng er lagret. Skål for god smak!`);
    }
  } catch (error) { notify(error.message, true); }
  finally { state.pending = ''; render(); }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'dismiss-toast') { document.querySelector('#notifications').innerHTML = ''; return; }
  if (action === 'create-tab' || action === 'join-tab') {
    if (view !== 'home') return;
    state.tab = action === 'create-tab' ? 'create' : 'join';
    render();
    if (button.tagName === 'A') { event.preventDefault(); document.querySelector('#start').scrollIntoView({ behavior: 'smooth', block: 'center' }); document.querySelector('#join-code')?.focus({ preventScroll: true }); }
    return;
  }
  if (action === 'retry') { await load(); return; }
  if (action === 'rate') { state.ratings[state.session.activeBeerId] = Number(button.dataset.score); render(); document.querySelector(`[data-score="${button.dataset.score}"]`)?.focus({ preventScroll: true }); return; }
  if (action === 'fullscreen') { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('Fullskjerm støttes ikke i denne nettleseren.'); } return; }
  if (action === 'copy-link') {
    const link = new URL(url('join', state.session.code), location.origin).href;
    try { await navigator.clipboard.writeText(link); notify('Invitasjonslenken er kopiert. Send den til gjengen!'); }
    catch {
      const input = document.createElement('textarea'); input.value = link; input.className = 'clipboard-fallback'; document.body.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove();
      if (copied) notify('Invitasjonslenken er kopiert.');
      else { notify('Kopier lenken fra feltet nedenfor.', true); const area = document.querySelector('#notifications .toast'); const manual = document.createElement('input'); manual.value = link; manual.readOnly = true; manual.setAttribute('aria-label', 'Invitasjonslenke'); area.append(manual); manual.select(); clearTimeout(toastTimer); }
    }
    return;
  }
  if (state.pending) return;
  if (['open-round', 'close-round', 'delete-beer'].includes(action)) {
    if (action === 'open-round' && state.session.activeBeerId && state.session.missingCount > 0 && !confirm(`${state.session.missingCount} har ikke gitt poeng ennå. Åpne neste øl likevel?`)) return;
    if (action === 'close-round' && state.session.missingCount > 0 && !confirm(`${state.session.missingCount} har ikke gitt poeng ennå. Avslutte runden likevel?`)) return;
    state.pending = action;
    render();
    try {
      const path = action === 'delete-beer' ? `/api/sessions/${code}/beers/${encodeURIComponent(button.dataset.id)}` : `/api/sessions/${code}/round${action === 'close-round' ? '/close' : ''}`;
      const result = await api(path, { method: action === 'delete-beer' ? 'DELETE' : 'POST', role: 'admin', ...(action === 'open-round' ? { body: { beerId: button.dataset.id } } : {}) });
      acceptSession(result.session);
      notify(action === 'open-round' ? 'Runden er åpen. Nå kan gjengen gi poeng!' : action === 'close-round' ? 'Runden er avsluttet. Alle poeng er beholdt.' : 'Ølet er fjernet.');
    } catch (error) { notify(error.message, true); }
    finally { state.pending = ''; render(); }
  }
});
window.addEventListener('pagehide', () => source?.close());
window.addEventListener('pageshow', event => { if (event.persisted && state.session) subscribe(); });
load();
