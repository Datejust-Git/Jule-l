import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'juleol-newhost-'));
  const dataDir = join(directory, 'data');
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await mkdir(dataDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Arrangør</title>');
  if (options.prepare) await options.prepare(dataDir);
  let app;
  let base;
  async function start() {
    app = createApp({ dataDir, publicDir, rateLimit: options.rateLimit ?? false });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function close() {
    if (app) { const closing = app; app = null; await closing.close(); }
  }
  await start();
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  async function api(path, method = 'GET', input, token) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (input !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}/api${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  }
  async function tasting() {
    const response = await api('/sessions', 'POST', { name: 'Flere arrangører' });
    assert.equal(response.status, 201);
    return { ...response.data, path: `/sessions/${response.data.code}` };
  }
  async function hostCode(path, token) {
    const response = await api(`${path}/host-code`, 'POST', {}, token);
    assert.equal(response.status, 200);
    assert.match(response.data.hostCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    return response.data.hostCode;
  }
  return { api, tasting, hostCode, dataDir, get base() { return base; }, async restart() { await close(); await start(); } };
}

const wrongCode = (code) => `${code[0] === 'A' ? 'B' : 'A'}${code.slice(1)}`;
const assertNoSecrets = (data, secrets) => {
  const serialized = JSON.stringify(data);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /host_code_hash|"hostCode":|admin_hash|adminToken|token_hash/);
};

test('a public tasting code alone cannot grant organizer access', async (t) => {
  const f = await fixture(t);
  const { code, path, adminToken } = await f.tasting();
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode: 'ABCDEFGH' })).status, 401);
  const hostCode = await f.hostCode(path, adminToken);
  const invalid = [undefined, null, 12345678, '', code, 'ABCDEFG', 'ABCDEFGHI', '00000000', 'IIIIIIII', wrongCode(hostCode)];
  for (const value of invalid) {
    const response = await f.api(`${path}/host-login`, 'POST', { hostCode: value });
    assert.equal(response.status, 401, JSON.stringify(value));
    assert.deepEqual(Object.keys(response.data), ['error']);
  }
  assert.equal((await f.api(`${path}/beers`, 'POST', { name: 'Ulovlig øl' }, code)).status, 401);
});

test('the host code grants independent tokens that all manage the same tasting', async (t) => {
  const f = await fixture(t);
  const { path, adminToken } = await f.tasting();
  const hostCode = await f.hostCode(path, adminToken);
  const normalized = `${hostCode.slice(0, 4)} - ${hostCode.slice(4)}`.toLowerCase();
  const first = await f.api(`${path}/host-login`, 'POST', { hostCode: normalized });
  const second = await f.api(`${path}/host-login`, 'POST', { hostCode });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const tokens = [adminToken, first.data.adminToken, second.data.adminToken];
  assert.equal(new Set(tokens).size, 3);
  for (const [index, token] of tokens.entries()) {
    const me = await f.api(`${path}/me`, 'GET', undefined, token);
    assert.equal(me.status, 200);
    assert.deepEqual(me.data, { role: 'admin' });
    assert.equal((await f.api(`${path}/beers`, 'POST', { name: `Øl fra arrangør ${index + 1}` }, token)).status, 201);
  }
  assert.equal((await f.api(path)).data.session.beers.length, 3);
});

test('only an organizer of this tasting can generate its private host code', async (t) => {
  const f = await fixture(t);
  const a = await f.tasting();
  const b = await f.tasting();
  const participant = await f.api(`${a.path}/join`, 'POST', { name: 'Deltaker' });
  assert.equal((await f.api(`${a.path}/host-code`, 'POST', {})).status, 401);
  assert.equal((await f.api(`${a.path}/host-code`, 'POST', {}, participant.data.participantToken)).status, 403);
  assert.equal((await f.api(`${a.path}/host-code`, 'POST', {}, b.adminToken)).status, 401);
  const code = await f.hostCode(a.path, a.adminToken);
  assert.equal((await f.api(`${b.path}/host-login`, 'POST', { hostCode: code })).status, 401);
});

test('rotating the host code invalidates the old code while retaining every issued token', async (t) => {
  const f = await fixture(t);
  const { path, adminToken } = await f.tasting();
  const originalCode = await f.hostCode(path, adminToken);
  const joined = await f.api(`${path}/host-login`, 'POST', { hostCode: originalCode });
  const additionalToken = joined.data.adminToken;
  const replacementCode = await f.hostCode(path, additionalToken);
  assert.notEqual(replacementCode, originalCode);
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode: originalCode })).status, 401);
  const latest = await f.api(`${path}/host-login`, 'POST', { hostCode: replacementCode });
  assert.equal(latest.status, 200);
  for (const token of [adminToken, additionalToken, latest.data.adminToken]) {
    assert.equal((await f.api(`${path}/beers`, 'POST', { name: 'Fortsatt tilgang' }, token)).status, 201);
  }
});

test('host secrets stay out of public session state, SSE and /me and are hashed at rest', async (t) => {
  const f = await fixture(t);
  const { code, path, adminToken } = await f.tasting();
  const hostCode = await f.hostCode(path, adminToken);
  const loggedIn = await f.api(`${path}/host-login`, 'POST', { hostCode });
  assert.equal(loggedIn.status, 200);
  const additionalToken = loggedIn.data.adminToken;
  const secrets = [hostCode, adminToken, additionalToken];
  assertNoSecrets((await f.api(path)).data, secrets);
  assertNoSecrets((await f.api(`${path}/me`, 'GET', undefined, additionalToken)).data, secrets);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${f.base}/api${path}/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  for (const secret of secrets) assert.equal(initial.includes(secret), false);
  assert.doesNotMatch(initial, /host_code_hash|"hostCode":|admin_hash|adminToken|token_hash/);
  await f.api(`${path}/beers`, 'POST', { name: 'Vanlig offentlig oppdatering' }, additionalToken);
  const next = await Promise.race([reader.read(), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('No public state broadcast')), 3000); timer.unref();
  })]);
  const event = new TextDecoder().decode(next.value);
  assert.match(event, /Vanlig offentlig oppdatering/);
  for (const secret of secrets) assert.equal(event.includes(secret), false);
  assert.doesNotMatch(event, /host_code_hash|"hostCode":|admin_hash|adminToken|token_hash/);
  await reader.cancel();
  const database = new DatabaseSync(join(f.dataDir, 'app.sqlite'), { readOnly: true });
  try {
    const session = database.prepare('SELECT admin_hash, host_code_hash FROM sessions WHERE code = ?').get(code);
    assert.equal(session.admin_hash, createHash('sha256').update(adminToken).digest('hex'));
    assert.equal(session.host_code_hash, createHash('sha256').update(hostCode).digest('hex'));
    const rows = database.prepare('SELECT * FROM admin_tokens WHERE session_code = ?').all(code);
    assert.equal(rows.length, 1);
    assert.ok(Object.values(rows[0]).includes(createHash('sha256').update(additionalToken).digest('hex')));
    for (const secret of secrets) assert.equal(JSON.stringify(rows).includes(secret), false);
  } finally { database.close(); }
});

test('shared organizer access, its host code, scores and images persist through restart', async (t) => {
  const f = await fixture(t);
  const { path, adminToken } = await f.tasting();
  const beerId = (await f.api(`${path}/beers`, 'POST', { name: 'Lagret juleøl' }, adminToken)).data.session.beers[0].id;
  const participant = (await f.api(`${path}/join`, 'POST', { name: 'Dommer' })).data;
  await f.api(`${path}/round`, 'POST', { beerId }, adminToken);
  await f.api(`${path}/scores`, 'POST', { score: 7, beerId }, participant.participantToken);
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#654321' } }).png().toBuffer();
  const imageResponse = await fetch(`${f.base}/api${path}/beers/${beerId}/image`, {
    method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'image/png' }, body: image,
  });
  assert.equal(imageResponse.status, 200);
  const imageUrl = (await imageResponse.json()).session.beers[0].imageUrl;
  const hostCode = await f.hostCode(path, adminToken);
  const additionalToken = (await f.api(`${path}/host-login`, 'POST', { hostCode })).data.adminToken;
  await f.restart();
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, adminToken)).data, { role: 'admin' });
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, additionalToken)).data, { role: 'admin' });
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode })).status, 200);
  const restored = (await f.api(path)).data.session;
  assert.equal(restored.activeBeerId, beerId);
  assert.equal(restored.beers[0].averageScore, 7);
  assert.equal(restored.beers[0].imageUrl, imageUrl);
  assert.equal((await fetch(`${f.base}${imageUrl}`)).status, 200);
  assert.equal((await f.api(`${path}/round/close`, 'POST', {}, additionalToken)).status, 200);
});

test('an older database migrates organizer sharing without losing votes or images', async (t) => {
  const originalToken = 'original-organizer-token-for-legacy-test';
  const participantToken = 'original-participant-token-for-legacy-test';
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#772211' } }).webp().toBuffer();
  const f = await fixture(t, { prepare(dataDir) {
    const database = new DatabaseSync(join(dataDir, 'app.sqlite'));
    database.exec(`
      CREATE TABLE sessions(code TEXT PRIMARY KEY, name TEXT NOT NULL, admin_hash TEXT NOT NULL,
        active_beer_id TEXT, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE beers(id TEXT PRIMARY KEY, session_code TEXT NOT NULL REFERENCES sessions(code),
        name TEXT NOT NULL, brewery TEXT NOT NULL, abv REAL, position INTEGER NOT NULL);
      CREATE TABLE participants(id TEXT PRIMARY KEY, session_code TEXT NOT NULL REFERENCES sessions(code),
        name TEXT NOT NULL, name_key TEXT NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(session_code,name_key));
      CREATE TABLE scores(participant_id TEXT NOT NULL REFERENCES participants(id),
        beer_id TEXT NOT NULL REFERENCES beers(id), score INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(participant_id,beer_id));
      CREATE TABLE beer_images(beer_id TEXT PRIMARY KEY REFERENCES beers(id), data BLOB NOT NULL,
        content_type TEXT NOT NULL, version TEXT NOT NULL);
    `);
    const now = '2026-11-04T10:00:00Z';
    database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
      .run('ABCDEF', 'Tidligere smaking', createHash('sha256').update(originalToken).digest('hex'), 'legacy-beer', now, 7);
    database.prepare('INSERT INTO beers VALUES(?,?,?,?,?,?)').run('legacy-beer', 'ABCDEF', 'Bevart øl', 'Bryggeri', 6.5, 1);
    database.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?)')
      .run('legacy-person', 'ABCDEF', 'Tidligere deltaker', 'tidligere deltaker', createHash('sha256').update(participantToken).digest('hex'), now);
    database.prepare('INSERT INTO scores VALUES(?,?,?,?)').run('legacy-person', 'legacy-beer', 8, now);
    database.prepare('INSERT INTO beer_images VALUES(?,?,?,?)').run('legacy-beer', image, 'image/webp', 'legacy-version');
    database.close();
  } });
  const path = '/sessions/ABCDEF';
  const before = (await f.api(path)).data.session;
  assert.equal(before.revision, 7);
  assert.equal(before.beers[0].averageScore, 8);
  assert.equal(before.participants[0].averageScore, 8);
  const hostCode = await f.hostCode(path, originalToken);
  const newAccess = await f.api(`${path}/host-login`, 'POST', { hostCode });
  assert.equal(newAccess.status, 200);
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, originalToken)).data, { role: 'admin' });
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, newAccess.data.adminToken)).data, { role: 'admin' });
  const imageResponse = await fetch(`${f.base}${before.beers[0].imageUrl}`);
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image);
  assert.equal((await f.api(`${path}/me`, 'GET', undefined, participantToken)).data.scores['legacy-beer'], 8);
});

test('host-code generation is limited per session after authorization', async (t) => {
  const f = await fixture(t, { rateLimit: true });
  const a = await f.tasting();
  const b = await f.tasting();
  for (let i = 0; i < 25; i++) assert.equal((await f.api(`${a.path}/host-code`, 'POST', {})).status, 401);
  for (let i = 0; i < 20; i++) assert.equal((await f.api(`${a.path}/host-code`, 'POST', {}, a.adminToken)).status, 200);
  assert.equal((await f.api(`${a.path}/host-code`, 'POST', {}, a.adminToken)).status, 429);
  assert.equal((await f.api(`${b.path}/host-code`, 'POST', {}, b.adminToken)).status, 200);
});

test('host-login limits ten attempts per session and sixty across sessions per IP', async (t) => {
  const f = await fixture(t, { rateLimit: true });
  const sessions = [];
  for (let i = 0; i < 7; i++) {
    const session = await f.tasting();
    session.hostCode = await f.hostCode(session.path, session.adminToken);
    sessions.push(session);
  }
  for (const session of sessions.slice(0, 6)) {
    for (let i = 0; i < 10; i++) {
      assert.equal((await f.api(`${session.path}/host-login`, 'POST', { hostCode: wrongCode(session.hostCode) })).status, 401);
    }
  }
  assert.equal((await f.api(`${sessions[6].path}/host-login`, 'POST', { hostCode: sessions[6].hostCode })).status, 429);
});

test('exhausting one host-login session limit does not block a different tasting', async (t) => {
  const f = await fixture(t, { rateLimit: true });
  const a = await f.tasting();
  const b = await f.tasting();
  const codeA = await f.hostCode(a.path, a.adminToken);
  const codeB = await f.hostCode(b.path, b.adminToken);
  for (let i = 0; i < 10; i++) assert.equal((await f.api(`${a.path}/host-login`, 'POST', { hostCode: wrongCode(codeA) })).status, 401);
  assert.equal((await f.api(`${a.path}/host-login`, 'POST', { hostCode: codeA })).status, 429);
  assert.equal((await f.api(`${b.path}/host-login`, 'POST', { hostCode: codeB })).status, 200);
});

test('one tasting accepts at most one hundred additional organizer tokens', async (t) => {
  const f = await fixture(t);
  const { path, adminToken } = await f.tasting();
  const hostCode = await f.hostCode(path, adminToken);
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    const response = await f.api(`${path}/host-login`, 'POST', { hostCode });
    assert.equal(response.status, 200);
    tokens.add(response.data.adminToken);
  }
  assert.equal(tokens.size, 100);
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode })).status, 409);
  const rotated = await f.hostCode(path, adminToken);
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode: rotated })).status, 409);
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, adminToken)).data, { role: 'admin' });
  const issued = [...tokens];
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, issued[0])).data, { role: 'admin' });
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, issued.at(-1))).data, { role: 'admin' });
});

test('the public host-code generation changes only on successful rotations and persists', async (t) => {
  const f = await fixture(t);
  const { path, adminToken, session } = await f.tasting();
  assert.equal(session.hostCodeGeneration, 0);
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode: 'ABCDEFGH' })).status, 401);
  assert.equal((await f.api(path)).data.session.hostCodeGeneration, 0);
  const first = await f.api(`${path}/host-code`, 'POST', {}, adminToken);
  assert.equal(first.status, 200);
  assert.equal(first.data.session.hostCodeGeneration, 1);
  const login = await f.api(`${path}/host-login`, 'POST', { hostCode: first.data.hostCode });
  assert.equal(login.status, 200);
  assert.equal(login.data.session.hostCodeGeneration, 1);
  const extraToken = login.data.adminToken;
  const added = await f.api(`${path}/beers`, 'POST', { name: 'Generasjonsøl' }, extraToken);
  const beerId = added.data.beerId;
  const participant = await f.api(`${path}/join`, 'POST', { name: 'Smaker' });
  await f.api(`${path}/round`, 'POST', { beerId }, adminToken);
  const score = await f.api(`${path}/scores`, 'POST', { score: 8, beerId }, participant.data.participantToken);
  assert.equal(score.data.session.hostCodeGeneration, 1);
  assert.equal((await f.api(`${path}/host-code`, 'POST', {}, participant.data.participantToken)).status, 403);
  assert.equal((await f.api(path)).data.session.hostCodeGeneration, 1);
  const second = await f.api(`${path}/host-code`, 'POST', {}, extraToken);
  assert.equal(second.status, 200);
  assert.equal(second.data.session.hostCodeGeneration, 2);
  assert.equal((await f.api(`${path}/host-login`, 'POST', { hostCode: first.data.hostCode })).status, 401);
  assert.equal((await f.api(path)).data.session.hostCodeGeneration, 2);
  await f.restart();
  const restored = (await f.api(path)).data.session;
  assert.equal(restored.hostCodeGeneration, 2);
  assert.equal(restored.beers[0].averageScore, 8);
  const restoredLogin = await f.api(`${path}/host-login`, 'POST', { hostCode: second.data.hostCode });
  assert.equal(restoredLogin.status, 200);
  assert.equal(restoredLogin.data.session.hostCodeGeneration, 2);
});

test('adding the host-code generation column preserves an existing private code', async (t) => {
  const originalToken = 'original-token-for-generation-migration';
  const oldHostCode = 'ABCDEFGH';
  const f = await fixture(t, { prepare(dataDir) {
    const database = new DatabaseSync(join(dataDir, 'app.sqlite'));
    database.exec(`CREATE TABLE sessions(code TEXT PRIMARY KEY, name TEXT NOT NULL,
      admin_hash TEXT NOT NULL, host_code_hash TEXT, active_beer_id TEXT,
      created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`);
    database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run('ABCDEF', 'Bevar vertskoden',
      createHash('sha256').update(originalToken).digest('hex'), createHash('sha256').update(oldHostCode).digest('hex'),
      null, '2026-11-04T10:00:00Z', 9);
    database.close();
  } });
  const path = '/sessions/ABCDEF';
  const initial = (await f.api(path)).data.session;
  assert.equal(initial.hostCodeGeneration, 0);
  assert.equal(initial.revision, 9);
  const login = await f.api(`${path}/host-login`, 'POST', { hostCode: oldHostCode });
  assert.equal(login.status, 200);
  assert.equal(login.data.session.hostCodeGeneration, 0);
  const rotated = await f.api(`${path}/host-code`, 'POST', {}, login.data.adminToken);
  assert.equal(rotated.status, 200);
  assert.equal(rotated.data.session.hostCodeGeneration, 1);
  await f.restart();
  const after = await f.api(`${path}/host-login`, 'POST', { hostCode: rotated.data.hostCode });
  assert.equal(after.status, 200);
  assert.equal(after.data.session.hostCodeGeneration, 1);
  assert.deepEqual((await f.api(`${path}/me`, 'GET', undefined, originalToken)).data, { role: 'admin' });
});
