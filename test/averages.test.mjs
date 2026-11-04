import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'juleol-averages-'));
  const dataDir = join(directory, 'data');
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Gjennomsnitt</title>');
  let app;
  let base;
  async function start() {
    app = createApp({ dataDir, publicDir, rateLimit: false });
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
    const data = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  async function tasting() {
    const { code, adminToken, session } = await api('/sessions', 'POST', { name: 'Gjennomsnitt for kvelden' });
    const path = `/sessions/${code}`;
    return { code, adminToken, session, path };
  }
  return { api, tasting, async restart() { await close(); await start(); } };
}

const person = (session, name) => session.participants.find((participant) => participant.name === name);
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

async function unevenVotes(f) {
  const tasting = await f.tasting();
  const { path, adminToken } = tasting;
  const first = await f.api(`${path}/beers`, 'POST', { name: 'Første juleøl' }, adminToken);
  const beerA = first.session.beers[0].id;
  const second = await f.api(`${path}/beers`, 'POST', { name: 'Andre juleøl' }, adminToken);
  const beerB = second.session.beers[1].id;
  const a = await f.api(`${path}/join`, 'POST', { name: 'Anna' });
  const b = await f.api(`${path}/join`, 'POST', { name: 'Bjørn' });
  await f.api(`${path}/join`, 'POST', { name: 'Cecilie' });
  await f.api(`${path}/round`, 'POST', { beerId: beerA }, adminToken);
  await f.api(`${path}/scores`, 'POST', { score: 10, beerId: beerA }, a.participantToken);
  await f.api(`${path}/scores`, 'POST', { score: 2, beerId: beerA }, b.participantToken);
  await f.api(`${path}/round`, 'POST', { beerId: beerB }, adminToken);
  const scored = await f.api(`${path}/scores`, 'POST', { score: 8, beerId: beerB }, a.participantToken);
  return { ...tasting, beerA, beerB, a, b, session: scored.session };
}

test('an evening without votes has null averages and zero vote counts', async (t) => {
  const f = await fixture(t);
  const { path, adminToken, session } = await f.tasting();
  assert.equal(session.groupAverageScore, null);
  assert.equal(session.groupScoreCount, 0);
  const joined = await f.api(`${path}/join`, 'POST', { name: 'Ingen poeng ennå' });
  const participant = joined.session.participants[0];
  assert.equal(participant.averageScore, null);
  assert.equal(participant.scoreCount, 0);
  assert.equal(participant.totalScore, 0);
  assert.equal(joined.session.groupAverageScore, null);
  const added = await f.api(`${path}/beers`, 'POST', { name: 'Urørt øl' }, adminToken);
  const opened = await f.api(`${path}/round`, 'POST', { beerId: added.session.beers[0].id }, adminToken);
  assert.equal(opened.session.groupAverageScore, null);
  assert.equal(opened.session.groupScoreCount, 0);
  assert.equal(opened.session.participants[0].averageScore, null);
});

test('participant averages cover the evening and group average weights each submitted vote', async (t) => {
  const f = await fixture(t);
  const { session, beerB } = await unevenVotes(f);
  assert.equal(session.activeBeerId, beerB);
  assert.equal(person(session, 'Anna').averageScore, 9);
  assert.equal(person(session, 'Anna').scoreCount, 2);
  assert.equal(person(session, 'Anna').totalScore, 18);
  assert.equal(person(session, 'Anna').hasScored, true);
  assert.equal(person(session, 'Bjørn').averageScore, 2);
  assert.equal(person(session, 'Bjørn').scoreCount, 1);
  assert.equal(person(session, 'Bjørn').totalScore, 2);
  assert.equal(person(session, 'Bjørn').hasScored, false);
  assert.equal(person(session, 'Cecilie').averageScore, null);
  assert.equal(person(session, 'Cecilie').scoreCount, 0);
  assert.equal(person(session, 'Cecilie').totalScore, 0);
  assert.equal(session.scoredCount, 1);
  assert.equal(session.missingCount, 2);
  assert.equal(session.groupScoreCount, 3);
  closeTo(session.groupAverageScore, 20 / 3);
  assert.notEqual(session.groupAverageScore, (9 + 2) / 2);
  assert.notEqual(session.groupAverageScore, (6 + 8) / 2);
});

test('changing an existing score replaces its contribution and closing preserves averages', async (t) => {
  const f = await fixture(t);
  const { path, adminToken, beerA, beerB, a } = await unevenVotes(f);
  const updated = await f.api(`${path}/scores`, 'POST', { score: 4, beerId: beerB }, a.participantToken);
  assert.equal(person(updated.session, 'Anna').averageScore, 7);
  assert.equal(person(updated.session, 'Anna').scoreCount, 2);
  assert.equal(person(updated.session, 'Anna').totalScore, 14);
  assert.equal(updated.session.groupScoreCount, 3);
  closeTo(updated.session.groupAverageScore, 16 / 3);
  const closed = await f.api(`${path}/round/close`, 'POST', {}, adminToken);
  assert.equal(closed.session.activeBeerId, null);
  assert.equal(closed.session.scoredCount, 0);
  assert.equal(closed.session.missingCount, 0);
  assert.equal(person(closed.session, 'Anna').hasScored, false);
  assert.equal(person(closed.session, 'Anna').averageScore, 7);
  assert.equal(closed.session.groupScoreCount, 3);
  closeTo(closed.session.groupAverageScore, 16 / 3);
  await f.api(`${path}/round`, 'POST', { beerId: beerA }, adminToken);
  const changedEarlier = await f.api(`${path}/scores`, 'POST', { score: 6, beerId: beerA }, a.participantToken);
  assert.equal(person(changedEarlier.session, 'Anna').averageScore, 5);
  assert.equal(changedEarlier.session.groupAverageScore, 4);
  assert.equal(changedEarlier.session.groupScoreCount, 3);
});

test('evening averages survive a restart and remain isolated to their tasting', async (t) => {
  const f = await fixture(t);
  const original = await unevenVotes(f);
  const other = await f.tasting();
  const joined = await f.api(`${other.path}/join`, 'POST', { name: 'Anna' });
  const added = await f.api(`${other.path}/beers`, 'POST', { name: 'Annen smaking' }, other.adminToken);
  const beerId = added.session.beers[0].id;
  await f.api(`${other.path}/round`, 'POST', { beerId }, other.adminToken);
  await f.api(`${other.path}/scores`, 'POST', { score: 1, beerId }, joined.participantToken);
  await f.restart();
  const restored = (await f.api(original.path)).session;
  assert.equal(restored.groupScoreCount, 3);
  closeTo(restored.groupAverageScore, 20 / 3);
  assert.equal(person(restored, 'Anna').averageScore, 9);
  assert.equal(person(restored, 'Bjørn').averageScore, 2);
  assert.equal(person(restored, 'Cecilie').averageScore, null);
  const otherRestored = (await f.api(other.path)).session;
  assert.equal(otherRestored.groupScoreCount, 1);
  assert.equal(otherRestored.groupAverageScore, 1);
  assert.equal(person(otherRestored, 'Anna').averageScore, 1);
});
