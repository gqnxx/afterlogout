import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const marker = 'a-private-invoice-4821';

export function createDemoServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/login' && req.method === 'POST') {
      const account = url.searchParams.get('account') === 'b' ? 'b' : 'a';
      res.setHeader('Set-Cookie', `account=${account}; HttpOnly; SameSite=Lax; Path=/`);
      res.writeHead(200).end();
    } else if (url.pathname === '/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'account=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
      res.writeHead(200).end();
    } else if (url.pathname === '/api/invoice') {
      const account = /(?:^|;\s*)account=([ab])(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(account ? 200 : 401).end(JSON.stringify(account
        ? { owner: account, invoice: account === 'a' ? marker : 'b-private-invoice-9912' }
        : { error: 'Log in first' }));
    } else if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Invoice demo</title>
<style>body{font:18px/1.6 system-ui;max-width:700px;margin:60px auto}button{padding:10px;margin:4px}pre{padding:20px;background:#eee;white-space:pre-wrap}</style>
<h1>Invoice demo</h1><p id="mode"></p><p id="account">Logged out</p>
<button id="a">Log in as A</button><button id="b">Log in as B</button><button id="logout">Log out</button><button id="invoice">Open invoice</button>
<pre id="document">No invoice open</pre><script>
const safe = new URL(location.href).searchParams.get('safe') === '1';
document.querySelector('#mode').textContent = safe ? 'Fixed mode: cache cleared on logout' : 'Buggy mode: cache shared between accounts';
const output = document.querySelector('#document');
for (const account of ['a', 'b']) document.querySelector('#' + account).onclick = async () => {
  await fetch('/login?account=' + account, {method: 'POST'});
  document.querySelector('#account').textContent = 'Account ' + account.toUpperCase();
  output.textContent = 'No invoice open';
};
document.querySelector('#logout').onclick = async () => {
  await fetch('/logout', {method: 'POST'});
  if (safe) {
    for (const name of await caches.keys()) await caches.delete(name);
    localStorage.clear(); sessionStorage.clear();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('invoices');
      request.onsuccess = resolve; request.onerror = reject;
    });
  }
  document.querySelector('#account').textContent = 'Logged out';
  output.textContent = 'No invoice open';
};
document.querySelector('#invoice').onclick = async () => {
  const cache = await caches.open('invoices');
  let response = await cache.match('/api/invoice');
  if (!response) {
    response = await fetch('/api/invoice');
    if (response.ok) await cache.put('/api/invoice', response.clone());
  }
  const data = await response.json();
  output.textContent = JSON.stringify(data, null, 2);
  if (!response.ok) return;
  localStorage.setItem('last-invoice', JSON.stringify(data));
  sessionStorage.setItem('last-invoice', JSON.stringify(data));
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('invoices', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('documents');
    request.onerror = reject;
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').put(data, 'last');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
};
</script></html>`);
    } else res.writeHead(404).end('Not found');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDemoServer().listen(4173, '127.0.0.1', () => {
    console.log('Buggy demo: http://127.0.0.1:4173');
    console.log('Fixed demo: http://127.0.0.1:4173/?safe=1');
    console.log(`Marker: ${marker}`);
  });
}
