import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import { createApp } from '../server.mjs';
import { openStore } from '../lib/store.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'juleol-test-'));
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Juleøl</title>');
  const dataDir = join(directory, 'data');
  const app = createApp({ dataDir, publicDir, rateLimit: false, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  async function api(path, method = 'GET', input, token) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (input !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}/api${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const create = async (name = 'Juleølsmaking') => {
    const result = await api('/sessions', 'POST', { name });
    assert.equal(result.status, 201);
    return result.data;
  };
  return { app, base, api, create, dataDir, publicDir, close };
}

test('create, join, score and live leaderboard form a complete tasting', async (t) => {
  const { api, create } = await fixture(t);
  const { code, adminToken } = await create('  Julebord 2026  ');
  const path = `/sessions/${code}`;
  const first = await api(`${path}/beers`, 'POST', { name: 'Julebokk', brewery: 'Nord', abv: 6.5 }, adminToken);
  assert.equal(first.status, 201);
  const beer = first.data.session.beers[0];
  assert.equal(beer.abv, 6.5);
  const a = (await api(`${path}/join`, 'POST', { name: 'Åse' })).data;
  const b = (await api(`${path}/join`, 'POST', { name: 'Bjørn' })).data;
  assert.equal((await api(`${path}/round`, 'POST', { beerId: beer.id }, adminToken)).status, 200);
  const firstScore = await api(`${path}/scores`, 'POST', { score: 8, beerId: beer.id }, a.participantToken);
  assert.equal(firstScore.status, 200);
  assert.equal(firstScore.data.session.scoredCount, 1);
  assert.equal(firstScore.data.session.missingCount, 1);
  assert.equal(firstScore.data.session.participants.find((p) => p.name === 'Åse').hasScored, true);
  assert.equal(firstScore.data.session.participants.find((p) => p.name === 'Bjørn').hasScored, false);
  await api(`${path}/scores`, 'POST', { score: 6, beerId: beer.id }, b.participantToken);
  const updated = await api(`${path}/scores`, 'POST', { score: 10, beerId: beer.id }, a.participantToken);
  assert.equal(updated.data.session.beers[0].scoreCount, 2);
  assert.equal(updated.data.session.beers[0].averageScore, 8);
  assert.equal(updated.data.session.beers[0].totalScore, 16);
  assert.equal(updated.data.session.missingCount, 0);
  const me = await api(`${path}/me`, 'GET', undefined, a.participantToken);
  assert.deepEqual(me.data, { role: 'participant', participantId: a.participantId, scores: { [beer.id]: 10 } });
  assert.deepEqual((await api(`${path}/me`, 'GET', undefined, adminToken)).data, { role: 'admin' });
  assert.equal(updated.data.session.name, 'Julebord 2026');
  assert.equal(JSON.stringify(updated.data).includes(a.participantToken), false);
  assert.equal(JSON.stringify(updated.data).includes(adminToken), false);
});

test('authorization separates organizer, participant and other sessions', async (t) => {
  const { api, create } = await fixture(t);
  const a = await create();
  const b = await create('Annen smaking');
  const path = `/sessions/${a.code}`;
  const participant = (await api(`${path}/join`, 'POST', { name: 'Kari' })).data;
  assert.equal((await api(`${path}/beers`, 'POST', { name: 'Jul' })).status, 401);
  assert.equal((await api(`${path}/beers`, 'POST', { name: 'Jul' }, participant.participantToken)).status, 403);
  assert.equal((await api(`${path}/beers`, 'POST', { name: 'Jul' }, b.adminToken)).status, 401);
  const beerResult = await api(`${path}/beers`, 'POST', { name: 'Jul' }, a.adminToken);
  const beerId = beerResult.data.session.beers[0].id;
  assert.equal((await api(`/sessions/${b.code}/round`, 'POST', { beerId }, b.adminToken)).status, 404);
  await api(`${path}/round`, 'POST', { beerId }, a.adminToken);
  assert.equal((await api(`${path}/scores`, 'POST', { score: 8 }, a.adminToken)).status, 403);
});

test('score validation, stale rounds and closing prevent incorrect votes', async (t) => {
  const { api, create } = await fixture(t);
  const { code, adminToken } = await create();
  const path = `/sessions/${code}`;
  const { participantToken } = (await api(`${path}/join`, 'POST', { name: 'Ola' })).data;
  assert.equal((await api(`${path}/scores`, 'POST', { score: 8 }, participantToken)).status, 409);
  const beerId = (await api(`${path}/beers`, 'POST', { name: 'Juleøl' }, adminToken)).data.session.beers[0].id;
  await api(`${path}/round`, 'POST', { beerId }, adminToken);
  for (const score of [0, 11, 2.5, '8', null]) {
    assert.equal((await api(`${path}/scores`, 'POST', { score }, participantToken)).status, 400);
  }
  assert.equal((await api(`${path}/scores`, 'POST', { score: 8, beerId: 'old-beer' }, participantToken)).status, 409);
  await api(`${path}/scores`, 'POST', { score: 1 }, participantToken);
  const closed = await api(`${path}/round/close`, 'POST', {}, adminToken);
  assert.equal(closed.data.session.activeBeerId, null);
  assert.equal(closed.data.session.missingCount, 0);
  assert.equal(closed.data.session.beers[0].averageScore, 1);
  assert.equal((await api(`${path}/scores`, 'POST', { score: 10 }, participantToken)).status, 409);
  const reopened = await api(`${path}/round`, 'POST', { beerId }, adminToken);
  assert.equal(reopened.data.session.scoredCount, 1);
});

test('duplicate names are rejected without revealing or reusing credentials', async (t) => {
  const { api, create } = await fixture(t);
  const { code } = await create();
  const path = `/sessions/${code}`;
  assert.equal((await api(`${path}/join`, 'POST', { name: '  ÅSE  ' })).status, 201);
  const duplicate = await api(`${path}/join`, 'POST', { name: 'åse' });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(Object.keys(duplicate.data), ['error']);
  assert.equal((await api(`${path}/join`, 'POST', { name: 'Åse 2' })).status, 201);
  assert.equal((await api(`${path}/join`, 'POST', { name: '' })).status, 400);
  assert.equal((await api(`${path}/join`, 'POST', { name: 'a'.repeat(41) })).status, 400);
});

test('deletion protects active and scored beers and permits unused beers', async (t) => {
  const { api, create } = await fixture(t);
  const { code, adminToken } = await create();
  const path = `/sessions/${code}`;
  const beerId = (await api(`${path}/beers`, 'POST', { name: 'En' }, adminToken)).data.session.beers[0].id;
  const unusedId = (await api(`${path}/beers`, 'POST', { name: 'To' }, adminToken)).data.session.beers[1].id;
  assert.equal((await api(`${path}/beers/${unusedId}`, 'DELETE', undefined, adminToken)).status, 200);
  await api(`${path}/round`, 'POST', { beerId }, adminToken);
  assert.equal((await api(`${path}/beers/${beerId}`, 'DELETE', undefined, adminToken)).status, 409);
  const { participantToken } = (await api(`${path}/join`, 'POST', { name: 'Per' })).data;
  await api(`${path}/scores`, 'POST', { score: 7 }, participantToken);
  await api(`${path}/round/close`, 'POST', {}, adminToken);
  assert.equal((await api(`${path}/beers/${beerId}`, 'DELETE', undefined, adminToken)).status, 409);
});

test('session and credentials survive restarting the server', async (t) => {
  const f = await fixture(t);
  const { code, adminToken } = await f.create();
  const path = `/sessions/${code}`;
  const { participantToken } = (await f.api(`${path}/join`, 'POST', { name: 'Live' })).data;
  const beerId = (await f.api(`${path}/beers`, 'POST', { name: 'Lagringsøl' }, adminToken)).data.session.beers[0].id;
  await f.api(`${path}/round`, 'POST', { beerId }, adminToken);
  await f.api(`${path}/scores`, 'POST', { score: 9 }, participantToken);
  await f.close();
  const second = createApp({ dataDir: f.dataDir, publicDir: f.publicDir });
  t.after(() => second.close());
  second.server.listen(0, '127.0.0.1');
  await once(second.server, 'listening');
  assert.equal(second.store.session(code).beers[0].averageScore, 9);
  assert.equal(second.store.session(code).revision, 4);
  assert.equal(second.store.me(code, participantToken).scores[beerId], 9);
  assert.equal(second.store.me(code, adminToken).role, 'admin');
});

test('SSE sends an initial state and broadcasts changes to TV clients', async (t) => {
  const { api, create, base } = await fixture(t);
  const { code } = await create();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/sessions/${code}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: state/);
  assert.match(initial, /"participantCount":0/);
  await api(`/sessions/${code}/join`, 'POST', { name: 'TV-test' });
  const next = await Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No live state received')), 3000); timer.unref(); })]);
  const update = new TextDecoder().decode(next.value);
  assert.match(update, /"name":"TV-test"/);
  assert.match(update, /"participantCount":1/);
  await reader.cancel();
});

test('static delivery, health and malformed requests have safe responses', async (t) => {
  const { api, base, create } = await fixture(t);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Juleøl/);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await api('/health')).data.status, 'ok');
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', body: 'not json' })).status, 415);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await api('/sessions', 'POST', { name: 'x'.repeat(17_000) })).status, 413);
  const { code, adminToken } = await create();
  for (const abv of ['4.5', -1, 101]) {
    assert.equal((await api(`/sessions/${code}/beers`, 'POST', { name: 'Jul', abv }, adminToken)).status, 400);
  }
  assert.equal((await api('/sessions/XXXXXX')).status, 404);
});

test('session creation rate limits excessive requests', async (t) => {
  const { api } = await fixture(t, { rateLimit: true });
  for (let i = 0; i < 20; i++) assert.equal((await api('/sessions', 'POST', { name: 'Test' })).status, 201);
  assert.equal((await api('/sessions', 'POST', { name: 'Test' })).status, 429);
});

test('Norwegian names survive a multibyte character split across request chunks', async (t) => {
  const { create, base } = await fixture(t);
  const { code } = await create();
  const payload = Buffer.from(JSON.stringify({ name: 'Åse Østgård' }));
  const split = payload.indexOf(Buffer.from('Å')) + 1;
  const result = await new Promise((accept, reject) => {
    const req = request(`${base}/api/sessions/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => accept({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(payload.subarray(0, split));
    setTimeout(() => req.end(payload.subarray(split)), 10);
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.session.participants[0].name, 'Åse Østgård');
});

test('every successful session mutation advances its persisted revision', async (t) => {
  const { api, create } = await fixture(t);
  const { code, adminToken, session } = await create();
  const path = `/sessions/${code}`;
  assert.equal(session.revision, 0);
  const joined = await api(`${path}/join`, 'POST', { name: 'Sekvens' });
  assert.equal(joined.data.session.revision, 1);
  const { participantToken } = joined.data;
  const first = await api(`${path}/beers`, 'POST', { name: 'Første' }, adminToken);
  assert.equal(first.data.session.revision, 2);
  const beerId = first.data.session.beers[0].id;
  const second = await api(`${path}/beers`, 'POST', { name: 'Andre' }, adminToken);
  assert.equal(second.data.session.revision, 3);
  const unusedId = second.data.session.beers[1].id;
  assert.equal((await api(`${path}/beers/${unusedId}`, 'DELETE', undefined, adminToken)).data.session.revision, 4);
  assert.equal((await api(`${path}/round`, 'POST', { beerId }, adminToken)).data.session.revision, 5);
  assert.equal((await api(`${path}/scores`, 'POST', { score: 6, beerId }, participantToken)).data.session.revision, 6);
  assert.equal((await api(`${path}/scores`, 'POST', { score: 8, beerId }, participantToken)).data.session.revision, 7);
  assert.equal((await api(`${path}/round/close`, 'POST', {}, adminToken)).data.session.revision, 8);
  assert.equal((await api(`${path}/scores`, 'POST', { score: 4, beerId }, participantToken)).status, 409);
  assert.equal((await api(path)).data.session.revision, 8);
});

test('existing databases gain revisions while preserving sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'juleol-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'app.sqlite'));
  db.exec(`CREATE TABLE sessions (code TEXT PRIMARY KEY, name TEXT NOT NULL,
    admin_hash TEXT NOT NULL, active_beer_id TEXT, created_at TEXT NOT NULL)`);
  db.prepare('INSERT INTO sessions(code,name,admin_hash,created_at) VALUES (?,?,?,?)')
    .run('ABCDEF', 'Bevart smaking', 'existing-hash', '2026-11-04T10:00:00Z');
  db.close();
  const store = openStore(directory);
  assert.equal(store.session('ABCDEF').name, 'Bevart smaking');
  assert.equal(store.session('ABCDEF').revision, 0);
  assert.equal(store.join('ABCDEF', { name: 'Ny deltaker' }).session.revision, 1);
  store.close();
  const reopened = openStore(directory);
  assert.equal(reopened.session('ABCDEF').revision, 1);
  assert.equal(reopened.session('ABCDEF').participantCount, 1);
  reopened.close();
});

test('QR endpoint produces a public join code using the canonical supplied origin', async (t) => {
  const { create, base } = await fixture(t);
  const { code, adminToken } = await create();
  const origin = 'HTTPS://JULEOL.EXAMPLE.COM:443/';
  const response = await fetch(`${base}/api/sessions/${code.toLowerCase()}/qr.svg?origin=${encodeURIComponent(origin)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/svg\+xml; charset=utf-8$/);
  assert.match(response.headers.get('cache-control'), /public, max-age=3600/);
  const svg = await response.text();
  assert.match(svg, /^<svg /);
  assert.match(svg, /width="256"/);
  assert.match(svg, /#17231c/);
  const expected = await QRCode.toString(`https://juleol.example.com/?view=join&code=${code}`, {
    type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 256,
    color: { dark: '#17231c', light: '#ffffff' },
  });
  assert.equal(svg, expected);
  assert.equal(svg.includes(adminToken), false);
});

test('QR endpoint rejects missing or unsafe origins and unknown sessions', async (t) => {
  const { create, base } = await fixture(t);
  const { code } = await create();
  const endpoint = `${base}/api/sessions/${code}/qr.svg`;
  assert.equal((await fetch(endpoint)).status, 400);
  const invalidOrigins = [
    '', 'not a URL', 'javascript:alert(1)', 'ftp://example.com',
    'https://user:password@example.com', 'https://@example.com',
    'https://example.com/path', 'https://example.com/path/..',
    'https://example.com/?value=1', 'https://example.com/#section',
    'https://example.com?', 'https://example.com#',
    `https://${'a'.repeat(513)}.com`,
  ];
  for (const origin of invalidOrigins) {
    const response = await fetch(`${endpoint}?origin=${encodeURIComponent(origin)}`);
    assert.equal(response.status, 400, origin);
    assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  assert.equal((await fetch(`${base}/api/sessions/ZZZZZZ/qr.svg?origin=https%3A%2F%2Fexample.com`)).status, 404);
  const http = await fetch(`${endpoint}?origin=${encodeURIComponent('http://localhost:3000')}`);
  assert.equal(http.status, 200);
});
