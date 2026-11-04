import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createApp } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(join(tmpdir(), 'juleol-browser-'));
const app = createApp({ dataDir, publicDir: join(root, 'public'), rateLimit: false });
let browser;
const errors = [];
const shots = join(root, 'test-results');
try {
  await new Promise((done, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const firstContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const [host, ida, morten, tv] = await Promise.all([hostContext.newPage(), firstContext.newPage(), secondContext.newPage(), tvContext.newPage()]);
  for (const page of [host, ida, morten, tv]) {
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', dialog => dialog.accept());
  }

  await mkdir(shots, { recursive: true });
  await host.goto(origin);
  await host.getByRole('heading', { level: 1 }).waitFor();
  await host.screenshot({ path: join(shots, 'forside.png'), fullPage: true });
  await host.getByLabel('Hva heter smakingen?').fill('Juleølkvelden');
  let captureCreation;
  const creation = new Promise(done => { captureCreation = done; });
  await host.route('**/api/sessions', async route => {
    const response = await route.fetch();
    captureCreation(await response.json());
    await route.fulfill({ response });
  });
  await host.locator('[data-form="create"]').getByRole('button').click();
  const created = await creation;
  const { code, adminToken } = created;
  assert.match(code, /^[A-Z0-9]{6}$/);
  await host.waitForURL(`**/?view=host&code=${code}`);
  await host.getByRole('heading', { name: 'Juleølkvelden', exact: true }).waitFor();

  async function scanQr(page) {
    const image = page.getByTestId('join-qr');
    await image.waitFor();
    await image.evaluate(img => img.decode());
    const png = PNG.sync.read(await image.screenshot());
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(decoded, 'Den viste QR-koden må kunne skannes.');
    assert.equal(decoded.data, `${origin}/?view=join&code=${code}`);
    assert.ok(!decoded.data.includes(adminToken), 'QR-koden skal bare dele deltakerlenken.');
    return decoded.data;
  }
  const scannedJoinUrl = await scanQr(host);

  async function addBeer(name, brewery, abv) {
    const form = host.locator('[data-form="beer"]');
    await form.locator('[name="name"]').fill(name);
    await form.locator('[name="brewery"]').fill(brewery);
    await form.locator('[name="abv"]').fill(abv);
    await form.getByRole('button', { name: 'Legg til', exact: true }).click();
    await host.locator('.beer-list-item').filter({ hasText: name }).waitFor();
    await host.waitForFunction(() => document.querySelector('#beer-name').value === '');
  }
  await addBeer('Nissebokk <vinter>', 'Nordlys bryggeri', '6.5');
  await addBeer('Julenatt', 'Fjell & fjord', '7.2');
  assert.equal(await host.locator('.beer-list-item').count(), 2);

  async function joinTasting(page, name) {
    await page.goto(scannedJoinUrl);
    await page.getByLabel('Kode til smakingen').waitFor();
    assert.equal(await page.getByLabel('Kode til smakingen').inputValue(), code);
    await page.getByLabel('Navnet ditt').fill(name);
    await page.locator('[data-form="join"]').getByRole('button').click();
    await page.getByText(`Hei, ${name}!`, { exact: true }).waitFor();
  }
  await joinTasting(ida, 'Ida');
  await joinTasting(morten, 'Morten');
  await tv.goto(`${origin}/?view=tv&code=${code}`);
  await tv.locator('.people-list').getByText('Morten', { exact: true }).waitFor();
  await scanQr(tv);

  // A live update must preserve an unfinished beer form and the focused input.
  await host.getByLabel('Navn på ølet').fill('Et utkast som skal beholdes');
  await host.getByLabel('Bryggeri').fill('Ikke lagret ennå');
  await ida.reload();
  const openRound = host.locator('.beer-list-item').filter({ hasText: 'Nissebokk <vinter>' }).getByRole('button', { name: 'Start runde' });
  await openRound.click();
  await ida.getByRole('heading', { name: 'Nissebokk <vinter>', exact: true }).waitFor();
  assert.equal(await host.getByLabel('Navn på ølet').inputValue(), 'Et utkast som skal beholdes');
  assert.equal(await host.getByLabel('Bryggeri').inputValue(), 'Ikke lagret ennå');
  assert.equal(await tv.locator('.people-list .person').count(), 2);

  async function vote(page, score) {
    await page.getByRole('button', { name: `${score} poeng`, exact: true }).click();
    const request = page.waitForResponse(response => response.url().endsWith('/scores') && response.request().method() === 'POST');
    await page.locator('[data-form="score"]').getByRole('button', { name: /(?:Gi|Oppdater til) \d+ poeng/ }).click();
    const response = await request;
    assert.equal(response.status(), 200);
    await page.getByText(`Du har gitt ${score} poeng. Du kan endre mens runden er åpen.`, { exact: true }).waitFor();
  }
  await vote(ida, 8);
  await tv.locator('.vote-progress strong').filter({ hasText: '1 av 2' }).waitFor();
  assert.equal(await tv.locator('.people-list .person').count(), 1);
  assert.match(await tv.locator('.people-list').innerText(), /Morten/);
  assert.doesNotMatch(await tv.locator('.people-list').innerText(), /Ida/);
  await tv.screenshot({ path: join(shots, 'tv-venter.png'), fullPage: true });
  await ida.getByRole('button', { name: '10 poeng', exact: true }).click();
  await vote(morten, 6);
  await tv.getByText('Alle har gitt poeng!', { exact: true }).waitFor();
  await ida.locator('.vote-progress strong').filter({ hasText: '2 av 2' }).waitFor();
  assert.equal(await ida.getByRole('button', { name: '10 poeng', exact: true }).getAttribute('aria-pressed'), 'true', 'Et usendt poengvalg må bevares ved liveoppdateringer.');
  assert.equal(await ida.evaluate(() => document.activeElement?.dataset.score), '10', 'Liveoppdateringer må bevare tastaturfokus.');
  const firstRow = tv.locator('.leader-row[role="row"]').filter({ hasText: 'Nissebokk <vinter>' });
  await firstRow.locator('.score-number').filter({ hasText: '7,0' }).waitFor();
  await vote(ida, 10);
  await firstRow.locator('.score-number').filter({ hasText: '8,0' }).waitFor();
  assert.equal((await firstRow.locator('.vote-count').innerText()).trim().split(/\s/)[0], '2');
  await host.screenshot({ path: join(shots, 'arrangor.png'), fullPage: true });
  await ida.screenshot({ path: join(shots, 'mobil.png'), fullPage: true });
  await tv.screenshot({ path: join(shots, 'tv.png'), fullPage: true });

  // Simulate a slow score response arriving AFTER the next round's live event.
  // It must never restore the previous beer on the participant's screen.
  let captured;
  const intercepted = new Promise(done => { captured = done; });
  let release;
  const responseGate = new Promise(done => { release = done; });
  const scoreUrl = `**/api/sessions/${code}/scores`;
  await ida.route(scoreUrl, async route => {
    const response = await route.fetch();
    captured();
    await responseGate;
    await route.fulfill({ response });
  });
  const delayedResponse = ida.waitForResponse(response => response.url().endsWith('/scores'));
  await ida.locator('.submit-score').click();
  await intercepted;
  await host.locator('.beer-list-item').filter({ hasText: 'Julenatt' }).getByRole('button', { name: 'Start runde' }).click();
  await ida.getByRole('heading', { name: 'Julenatt', exact: true }).waitFor();
  release();
  await delayedResponse;
  await ida.waitForFunction(() => document.querySelector('.submit-score')?.textContent.includes('Gi poeng'));
  assert.equal(await ida.getByRole('heading', { level: 1 }).textContent(), 'Julenatt');
  await ida.unroute(scoreUrl);
  await morten.getByRole('heading', { name: 'Julenatt', exact: true }).waitFor();
  await vote(ida, 9);
  await vote(morten, 9);
  const winner = tv.locator('.leader-first .beer-cell strong');
  await winner.filter({ hasText: 'Julenatt' }).waitFor();
  await ida.reload();
  await ida.getByText('Du har gitt 9 poeng. Du kan endre mens runden er åpen.', { exact: true }).waitFor();
  await host.reload();
  await host.getByRole('button', { name: 'Avslutt runden' }).click();
  await ida.locator('.waiting-card').waitFor();
  assert.equal(await ida.locator('[data-form="score"]').count(), 0);

  for (const page of [host, ida, morten, tv]) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Visningen må passe skjermbredden.');
  }
  // Also check the public entry screen on a narrow phone.
  const phoneHome = await firstContext.newPage();
  await phoneHome.goto(origin);
  await phoneHome.getByRole('heading', { level: 1 }).waitFor();
  assert.equal(await phoneHome.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phoneHome.screenshot({ path: join(shots, 'forside-mobil.png'), fullPage: true });

  const result = await fetch(`${origin}/api/sessions/${code}`).then(response => response.json());
  assert.equal(result.session.participantCount, 2);
  assert.equal(result.session.activeBeerId, null);
  assert.deepEqual(result.session.beers.map(beer => beer.averageScore), [8, 9]);
  const unauthorized = await fetch(`${origin}/api/sessions/${code}/beers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ugyldig' }, body: JSON.stringify({ name: 'Ikke tillatt' }),
  });
  assert.equal(unauthorized.status, 401);
  // Confirm no token was accidentally exposed in public state.
  assert.ok(!JSON.stringify(result).includes(adminToken));
  assert.deepEqual(errors, [], `Nettleserfeil: ${errors.join('; ')}`);
  console.log('Nettlesertest bestått: skanning av begge QR-kodene, innmelding via QR-lenken, opprettelse, øl, to mobiler, TV live, poengendring, ny runde, gjenåpning av siden og responsive visninger.');
  console.log(`Skjermbilder: ${shots}`);
} finally {
  await browser?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
