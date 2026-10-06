#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { capture, recordNetwork } from './capture.js';
import { saveJson, writeReport } from './report.js';
import type { Snapshot, Stage } from './types.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    marker: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length === 0) {
    console.log(`Usage: afterlogout <url> --marker <private-test-string> [--out <new-directory>]

Manually capture account A, logout, and account B in one fresh Chromium session.
Use a distinctive marker in private test data owned by account A.
Raw evidence contains secrets. Reports omit values, but still need review.
Install the browser first: npx playwright install chromium`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one target URL.');
  const url = new URL(positionals[0]);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials.');
  }
  const marker = values.marker;
  if (!marker || marker.trim().length < 8) throw new Error('Supply --marker with at least 8 characters of distinctive private test data.');
  const directory = resolve(values.out ?? `evidence/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(resolve(directory, '..'), { recursive: true, mode: 0o700 });
  // Exclusive creation prevents mixing this run with earlier evidence.
  await mkdir(directory, { mode: 0o700 });
  const browser = await chromium.launch({ headless: false });
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const network = await recordNetwork(page, url.origin);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const snapshots: Snapshot[] = [];
    const steps: [Stage, string][] = [
      ['account-a', 'Log in as account A and open the private data containing your marker.'],
      ['logged-out', 'Log out using the application. Stay on the target site.'],
      ['account-b', 'Log in as account B and open the same application view.'],
    ];
    console.log(`\nEvidence: ${directory}\nCapture covers the original tab and target origin. Use this tab for every step.`);
    for (const [stage, instruction] of steps) {
      await network.setStage(stage);
      let snapshot: Snapshot;
      while (true) {
        await input.question(`\n${instruction}\nPress Enter when ready to capture ${stage}: `);
        try {
          snapshot = await capture(page, url.origin, stage);
          break;
        } catch (error) {
          if (page.isClosed()) throw new Error('The capture tab was closed. Earlier captures are saved in the evidence directory.');
          console.log(`Capture failed: ${error instanceof Error ? error.message : String(error)}\nCorrect the page and try again.`);
        }
      }
      const imagePath = join(directory, `${stage}.png`);
      snapshot.warnings.push(...await network.flush());
      snapshots.push(snapshot);
      await saveJson(directory, `${stage}.json`, snapshot);
      await saveJson(directory, 'network.json', network.exchanges);
      try {
        await page.bringToFront();
        await page.evaluate(() => new Promise<void>(done => {
          const timer = setTimeout(done, 1000);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done(); }));
        }));
        await page.screenshot({ path: imagePath });
        await chmod(imagePath, 0o600);
      } catch (error) {
        snapshot.warnings.push(`Screenshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
        await saveJson(directory, `${stage}.json`, snapshot);
      }
      const summary = await writeReport(directory, snapshots, network.exchanges, marker);
      console.log(`Saved ${stage}: ${snapshot.items.length} storage entries, ${snapshot.warnings.length} warnings.`);
      if (stage === 'account-a' && !summary.markerSeenInAccountA) console.log('Marker missing from account A evidence. Later matches cannot establish an account A baseline.');
    }
    console.log(`\nReport: ${join(directory, 'report.html')}`);
  } finally {
    input.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(`afterlogout: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
