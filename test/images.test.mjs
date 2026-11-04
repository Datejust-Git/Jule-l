import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'juleol-images-'));
  const dataDir = join(directory, 'data');
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Bilder</title>');
  let app;
  let base;
  async function start() {
    app = createApp({ dataDir, publicDir, rateLimit: false });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function close() {
    if (app) {
      const closing = app;
      app = null;
      await closing.close();
    }
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
  async function upload(path, bytes, contentType, token) {
    const headers = { 'Content-Type': contentType };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}/api${path}`, { method: 'PUT', headers, body: bytes });
    return { status: response.status, data: await response.json() };
  }
  async function tasting() {
    const created = await api('/sessions', 'POST', { name: 'Bildesmaking' });
    assert.equal(created.status, 201);
    const { code, adminToken } = created.data;
    const path = `/sessions/${code}`;
    const added = await api(`${path}/beers`, 'POST', { name: 'Juleøl med bilde' }, adminToken);
    assert.equal(added.status, 201);
    const beer = added.data.session.beers[0];
    assert.equal(beer.imageUrl, null);
    return { code, adminToken, path, beerId: beer.id, imagePath: `${path}/beers/${beer.id}/image` };
  }
  return { api, upload, tasting, close, dataDir, get base() { return base; }, async restart() { await close(); await start(); } };
}

const png = (width = 80, height = 120, background = '#ae692b') => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const bytesOf = async (response) => Buffer.from(await response.arrayBuffer());

test('PNG upload becomes a resized public WebP with metadata removed', async (t) => {
  const f = await fixture(t);
  const { code, adminToken, imagePath } = await f.tasting();
  const source = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#834421' } })
    .withMetadata({ exif: { IFD0: { Copyright: 'Private camera information' } } }).png().toBuffer();
  const uploaded = await f.upload(imagePath, source, 'image/png', adminToken);
  assert.equal(uploaded.status, 200);
  const beer = uploaded.data.session.beers[0];
  const imageURL = new URL(beer.imageUrl, 'https://example.test');
  assert.equal(imageURL.pathname, `/api/sessions/${code}/beers/${beer.id}/image`);
  assert.ok(imageURL.searchParams.get('v'));
  assert.equal(uploaded.data.session.revision, 2);
  const response = await fetch(`${f.base}${beer.imageUrl}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/webp(?:;|$)/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.doesNotMatch(response.headers.get('cache-control') || '', /immutable/);
  const bytes = await bytesOf(response);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.equal(beer.scoreCount, 0);
  assert.equal(JSON.stringify(uploaded.data).includes('base64'), false);
});

test('JPEG orientation is normalized and small JPEG/WebP images are not enlarged', async (t) => {
  const f = await fixture(t);
  const { adminToken, imagePath } = await f.tasting();
  const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#226632' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const jpegResult = await f.upload(imagePath, jpeg, 'image/jpeg', adminToken);
  assert.equal(jpegResult.status, 200);
  const rotated = await sharp(await bytesOf(await fetch(`${f.base}${jpegResult.data.session.beers[0].imageUrl}`))).metadata();
  assert.equal(rotated.width, 80);
  assert.equal(rotated.height, 120);
  assert.equal(rotated.orientation, undefined);
  assert.equal(rotated.exif, undefined);
  const webp = await sharp({ create: { width: 24, height: 48, channels: 3, background: '#bb5500' } }).webp().toBuffer();
  const webpResult = await f.upload(imagePath, webp, 'image/webp', adminToken);
  assert.equal(webpResult.status, 200);
  const small = await sharp(await bytesOf(await fetch(`${f.base}${webpResult.data.session.beers[0].imageUrl}`))).metadata();
  assert.equal(small.width, 24);
  assert.equal(small.height, 48);
});

test('replacing and removing an image preserves an active round and its scores', async (t) => {
  const f = await fixture(t);
  const { adminToken, path, beerId, imagePath } = await f.tasting();
  const joined = await f.api(`${path}/join`, 'POST', { name: 'Bildedommer' });
  await f.api(`${path}/round`, 'POST', { beerId }, adminToken);
  const voted = await f.api(`${path}/scores`, 'POST', { score: 9, beerId }, joined.data.participantToken);
  const revision = voted.data.session.revision;
  const first = await f.upload(imagePath, await png(), 'image/png', adminToken);
  assert.equal(first.status, 200);
  const second = await f.upload(imagePath, await png(80, 120, '#123456'), 'image/png', adminToken);
  assert.equal(second.status, 200);
  assert.notEqual(first.data.session.beers[0].imageUrl, second.data.session.beers[0].imageUrl);
  assert.equal(second.data.session.revision, revision + 2);
  assert.equal(second.data.session.activeBeerId, beerId);
  assert.equal(second.data.session.scoredCount, 1);
  assert.equal(second.data.session.beers[0].scoreCount, 1);
  assert.equal(second.data.session.beers[0].averageScore, 9);
  const removed = await f.api(imagePath, 'DELETE', undefined, adminToken);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.session.revision, revision + 3);
  assert.equal(removed.data.session.beers[0].imageUrl, null);
  assert.equal(removed.data.session.activeBeerId, beerId);
  assert.equal(removed.data.session.beers[0].averageScore, 9);
  assert.equal((await fetch(`${f.base}/api${imagePath}`)).status, 404);
  const me = await f.api(`${path}/me`, 'GET', undefined, joined.data.participantToken);
  assert.equal(me.data.scores[beerId], 9);
});

test('beer images and their public versions persist through server restart', async (t) => {
  const f = await fixture(t);
  const { adminToken, path, imagePath } = await f.tasting();
  const uploaded = await f.upload(imagePath, await png(), 'image/png', adminToken);
  assert.equal(uploaded.status, 200);
  const imageUrl = uploaded.data.session.beers[0].imageUrl;
  const before = await bytesOf(await fetch(`${f.base}${imageUrl}`));
  await f.restart();
  const restored = await f.api(path);
  assert.equal(restored.data.session.beers[0].imageUrl, imageUrl);
  assert.equal(restored.data.session.revision, uploaded.data.session.revision);
  const response = await fetch(`${f.base}${imageUrl}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await bytesOf(response), before);
});

test('image changes require organizer access and a beer in that session', async (t) => {
  const f = await fixture(t);
  const a = await f.tasting();
  const b = await f.tasting();
  const participant = await f.api(`${a.path}/join`, 'POST', { name: 'Deltaker' });
  const badBytes = Buffer.from('<svg></svg>');
  assert.equal((await f.upload(a.imagePath, badBytes, 'image/svg+xml')).status, 401);
  assert.equal((await f.upload(a.imagePath, badBytes, 'image/svg+xml', participant.data.participantToken)).status, 403);
  assert.equal((await f.upload(a.imagePath, badBytes, 'image/svg+xml', b.adminToken)).status, 401);
  assert.equal((await f.upload(`${b.path}/beers/${a.beerId}/image`, badBytes, 'image/svg+xml', b.adminToken)).status, 404);
  assert.equal((await f.upload(`${a.path}/beers/not-a-beer/image`, badBytes, 'image/svg+xml', a.adminToken)).status, 404);
  assert.equal((await f.api(a.imagePath, 'DELETE')).status, 401);
  assert.equal((await f.api(a.imagePath, 'DELETE', undefined, participant.data.participantToken)).status, 403);
  assert.equal((await fetch(`${f.base}/api${b.path}/beers/${a.beerId}/image`)).status, 404);
  const state = await f.api(a.path);
  assert.equal(state.data.session.revision, 2);
  assert.equal(state.data.session.beers[0].imageUrl, null);
});

test('unsupported, forged, empty and corrupt files never become beer images', async (t) => {
  const f = await fixture(t);
  const { adminToken, path, imagePath } = await f.tasting();
  const invalid = [
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), [415]],
    ['image/gif', Buffer.from('GIF89a'), [415]],
    ['text/plain', await png(), [415]],
    ['image/jpeg', await png(), [415]],
    ['image/png', Buffer.from('<svg></svg>'), [415]],
    ['image/png', Buffer.alloc(0), [400, 415]],
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), [400]],
    ['image/jpeg', Buffer.from([255, 216, 255, 224, 0, 1, 2, 3, 4]), [400]],
    ['image/webp', Buffer.from('RIFF0000WEBPbroken image'), [400]],
  ];
  for (const [type, bytes, statuses] of invalid) {
    const result = await f.upload(imagePath, bytes, type, adminToken);
    assert.ok(statuses.includes(result.status), `${type} length=${bytes.length}: ${JSON.stringify(result)}`);
    assert.equal(typeof result.data.error, 'string');
  }
  const state = await f.api(path);
  assert.equal(state.data.session.revision, 1);
  assert.equal(state.data.session.beers[0].imageUrl, null);
});

test('uploads above ten MiB are rejected before decoding or changing state', async (t) => {
  const f = await fixture(t);
  const { adminToken, path, imagePath } = await f.tasting();
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  Buffer.from([255, 216, 255, 224]).copy(oversized);
  const result = await f.upload(imagePath, oversized, 'image/jpeg', adminToken);
  assert.equal(result.status, 413);
  assert.equal(typeof result.data.error, 'string');
  assert.equal((await f.api(path)).data.session.revision, 1);
});

test('animated images and excessive decoded pixel counts are rejected', async (t) => {
  const f = await fixture(t);
  const { adminToken, imagePath } = await f.tasting();
  const frames = Buffer.from([...Array(4).fill([255, 0, 0]).flat(), ...Array(4).fill([0, 255, 0]).flat()]);
  const animation = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
    .webp({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 2);
  const animatedResult = await f.upload(imagePath, animation, 'image/webp', adminToken);
  assert.equal(animatedResult.status, 400);
  const giant = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 1 }).toBuffer();
  const giantResult = await f.upload(imagePath, giant, 'image/png', adminToken);
  assert.ok([400, 413].includes(giantResult.status), JSON.stringify(giantResult));
});

test('image updates broadcast only a versioned URL and deleting a beer cascades the blob', async (t) => {
  const f = await fixture(t);
  const { code, adminToken, path, beerId, imagePath } = await f.tasting();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${f.base}/api${path}/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  const uploaded = await f.upload(imagePath, await png(), 'image/png', adminToken);
  assert.equal(uploaded.status, 200);
  const next = await Promise.race([reader.read(), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('No image state broadcast')), 3000); timer.unref();
  })]);
  const event = new TextDecoder().decode(next.value);
  const data = JSON.parse(event.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  assert.equal(data.session.code, code);
  assert.equal(data.session.revision, 2);
  assert.equal(data.session.beers[0].imageUrl, uploaded.data.session.beers[0].imageUrl);
  assert.equal(Object.hasOwn(data.session.beers[0], 'data'), false);
  assert.equal(event.includes('base64'), false);
  await reader.cancel();
  assert.equal((await f.api(`${path}/beers/${beerId}`, 'DELETE', undefined, adminToken)).status, 200);
  assert.equal((await fetch(`${f.base}/api${imagePath}`)).status, 404);
  await f.close();
  const database = new DatabaseSync(join(f.dataDir, 'app.sqlite'));
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM beer_images WHERE beer_id = ?').get(beerId).n, 0);
  database.close();
});
