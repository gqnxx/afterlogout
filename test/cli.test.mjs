import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoServer, marker } from '../demo/server.mjs';

test('CLI saves all three captures and refuses to overwrite a run', { timeout: 60000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'afterlogout-cli-'));
  const directory = join(parent, 'run');
  const server = createDemoServer();
  const demoHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  let command = '';
  let child;
  const watchdog = setTimeout(() => child?.kill(), 45000);
  watchdog.unref();
  // Only the test page is automated. The real CLI still waits for Enter.
  server.on('request', (req, res) => {
    if (req.url === '/__command') {
      res.end(command);
      command = '';
    } else if (req.url === '/__ready') {
      child.stdin.write('\n');
      res.end();
    } else {
      if (req.url === '/') {
        const end = res.end.bind(res);
        res.end = html => end(html.replace('</html>', `<script>
          let busy = false;
          setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
              const command = await (await fetch('/__command')).text();
              if (!command) return;
              if (command === 'logged-out') await document.querySelector('#logout').onclick();
              else {
                await document.querySelector(command === 'account-a' ? '#a' : '#b').onclick();
                await document.querySelector('#invoice').onclick();
              }
              await fetch('/__ready');
            } finally { busy = false; }
          }, 50);
        </script></html>`));
      }
      demoHandler(req, res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${server.address().port}`;
  const args = ['dist/cli.js', target, '--marker', marker, '--out', directory];
  try {
    child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const prompted = new Set();
    child.stdout.on('data', data => {
      output += data;
      for (const stage of ['account-a', 'logged-out', 'account-b']) {
        if (!prompted.has(stage) && output.includes(`Press Enter when ready to capture ${stage}:`)) {
          prompted.add(stage);
          command = stage;
        }
      }
    });
    child.stderr.on('data', data => { errors += data; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.equal(code, 0, errors);
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.snapshots.length, 3);
    assert.ok(report.observations.some(o => o.stage === 'account-b' && o.kind === 'visible-marker'));
    for (const stage of ['account-a', 'logged-out', 'account-b']) {
      const png = await readFile(join(directory, `${stage}.png`));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      if (process.platform !== 'win32') assert.equal((await stat(join(directory, `${stage}.json`))).mode & 0o777, 0o600);
    }
    const repeat = spawn(process.execPath, args, { stdio: 'ignore' });
    assert.equal(await new Promise(resolve => repeat.on('exit', resolve)), 1);
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(parent, { recursive: true, force: true });
  }
});
