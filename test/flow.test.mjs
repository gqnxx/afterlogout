import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createDemoServer, marker } from '../demo/server.mjs';
import { capture, recordNetwork } from '../dist/capture.js';
import { compare } from '../dist/compare.js';
import { saveJson, writeReport } from '../dist/report.js';

for (const safe of [false, true]) test(`${safe ? 'fixed' : 'buggy'} account switch`, async () => {
  const server = createDemoServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const directory = await mkdtemp(join(tmpdir(), 'afterlogout-'));
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const network = await recordNetwork(page, origin);
    await page.goto(`${origin}/?safe=${safe ? '1' : '0'}`);
    await page.click('#a');
    await page.waitForFunction(() => document.querySelector('#account').textContent === 'Account A');
    await page.click('#invoice');
    await page.waitForFunction(() => document.querySelector('#document').textContent.includes('a-private-invoice-4821'));
    // Wait for the demo's IndexedDB write rather than relying on a timer.
    await page.waitForFunction(async () => (await indexedDB.databases()).some(db => db.name === 'invoices'));
    const a = await capture(page, origin, 'account-a');
    assert.ok(a.items.some(i => i.kind === 'indexedDB' && i.value.includes(marker)));
    assert.ok(a.items.some(i => i.kind === 'cache' && i.value.includes(marker)));
    await network.setStage('logged-out');
    await page.click('#logout');
    await page.waitForFunction(() => document.querySelector('#account').textContent === 'Logged out');
    const logout = await capture(page, origin, 'logged-out');
    await network.setStage('account-b');
    await page.click('#b');
    await page.waitForFunction(() => document.querySelector('#account').textContent === 'Account B');
    await page.click('#invoice');
    await page.waitForFunction(() => document.querySelector('#document').textContent.includes('private-invoice'));
    const b = await capture(page, origin, 'account-b');
    await network.flush();
    const snapshots = [a, logout, b];
    const observations = compare(snapshots, network.exchanges, marker);
    assert.equal(observations.some(o => o.stage === 'account-b' && o.kind === 'visible-marker'), !safe);
    assert.equal(observations.some(o => o.stage === 'logged-out' && o.kind === 'stored-marker'), !safe);
    assert.ok(network.exchanges.some(e => e.stage === 'account-a' && e.body?.includes(marker)));
    assert.deepEqual(compare(snapshots, network.exchanges, 'not-a-recorded-marker'), []);
    for (const s of snapshots) await saveJson(directory, `${s.stage}.json`, s);
    await saveJson(directory, 'network.json', network.exchanges);
    await writeReport(directory, snapshots, network.exchanges, marker);
    const report = await readFile(join(directory, 'report.html'), 'utf8');
    assert.ok(!report.includes(marker));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), hash);
    }
    await page.goto('about:blank');
    await assert.rejects(capture(page, origin, 'account-b'), /Return to/);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('report escapes page-controlled text and excludes raw values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'afterlogout-report-'));
  try {
    const snapshots = ['account-a', 'account-b'].map(stage => ({ stage, time: 'now',
      url: 'https://example.test/?token=secret#fragment', visibleText: marker,
      warnings: ['<img src=x onerror=alert(1)>'],
      items: [{ kind: 'localStorage', key: '<script>alert(1)</script>', value: marker + '-other-secret' }],
    }));
    await writeReport(directory, snapshots, [], marker);
    const html = await readFile(join(directory, 'report.html'), 'utf8');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('token=secret'));
    assert.ok(!html.includes('other-secret'));
    assert.ok(!html.includes(marker));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a delayed account A response keeps its original stage', async () => {
  let completeResponse;
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      completeResponse = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ invoice: marker }));
      };
      started();
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<p>Account A</p>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const network = await recordNetwork(page, origin);
    await page.goto(origin);
    const fetchResult = page.evaluate(() => fetch('/slow').then(r => r.text()));
    await requestStarted;
    await network.setStage('logged-out');
    completeResponse();
    await fetchResult;
    await network.flush();
    const slow = network.exchanges.find(e => e.url.endsWith('/slow'));
    assert.equal(slow.stage, 'account-a');
    assert.ok(slow.body.includes(marker));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
