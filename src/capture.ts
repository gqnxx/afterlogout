import type { Page } from 'playwright';
import type { Exchange, Item, Snapshot, Stage } from './types.js';

const MAX_BODY = 1024 * 1024;

export async function recordNetwork(page: Page, origin: string) {
  const session = await page.context().newCDPSession(page);
  const exchanges: Exchange[] = [];
  const pending = new Set<Promise<void>>();
  const responses = new Map<string, Exchange>();
  const requests = new Map<string, Stage>();
  const warnings = new Set<string>();
  let stage: Stage = 'account-a';
  const stages: { stage: Stage; time: number }[] = [{ stage, time: 0 }];
  await session.send('Network.enable');
  session.on('Network.requestWillBeSent', event => {
    if (new URL(event.request.url).origin === origin && !requests.has(event.requestId)) {
      const started = stages.filter(s => s.time <= event.wallTime).at(-1);
      requests.set(event.requestId, started?.stage ?? 'account-a');
    }
  });
  session.on('Network.responseReceived', event => {
    const response = event.response;
    if (new URL(response.url).origin !== origin) return;
    if (exchanges.length >= 500) {
      warnings.add('Network capture stopped at 500 responses.');
      return;
    }
    const exchange: Exchange = {
      stage: requests.get(event.requestId) ?? stage,
      time: new Date().toISOString(), url: response.url, status: response.status,
      source: response.fromServiceWorker ? 'service-worker' : response.fromDiskCache ? 'disk-cache' : 'network',
    };
    exchanges.push(exchange);
    if (/^(text\/|application\/(json|.*\+json|javascript|xml))/.test(response.mimeType)) {
      responses.set(event.requestId, exchange);
    } else exchange.error = 'Body omitted: non-text response.';
  });
  session.on('Network.loadingFinished', event => {
    requests.delete(event.requestId);
    const exchange = responses.get(event.requestId);
    if (!exchange) return;
    responses.delete(event.requestId);
    if (event.encodedDataLength > MAX_BODY) {
      exchange.error = 'Body omitted: response exceeds 1 MiB.';
      return;
    }
    const task = session.send('Network.getResponseBody', { requestId: event.requestId })
      .then(result => {
        const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
        if (bytes.length > MAX_BODY) exchange.error = 'Body omitted: decoded response exceeds 1 MiB.';
        else exchange.body = bytes.toString('utf8');
      }).catch(() => { exchange.error = 'Body unavailable from the browser.'; });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  session.on('Network.loadingFailed', event => {
    requests.delete(event.requestId);
    const exchange = responses.get(event.requestId);
    if (exchange) exchange.error = `Request failed: ${event.errorText}`;
    responses.delete(event.requestId);
  });
  return {
    exchanges,
    async setStage(next: Stage) {
      const { result } = await session.send('Runtime.evaluate', {
        expression: 'performance.timeOrigin + performance.now()', returnByValue: true,
      });
      stages.push({ stage: next, time: result.value / 1000 });
      stage = next;
    },
    async flush() {
      await Promise.all([...pending]);
      return [...warnings, ...[...responses.values()].map(e => `Response still loading: ${e.url}`)];
    },
  };
}

export async function capture(page: Page, origin: string, stage: Stage): Promise<Snapshot> {
  if (new URL(page.url()).origin !== origin) {
    throw new Error(`Return to ${origin} before taking a snapshot.`);
  }
  const state = await page.evaluate(async expectedOrigin => {
    if (location.origin !== expectedOrigin) throw new Error('The page left the target origin during capture.');
    const items: Item[] = [];
    const warnings: string[] = [];
    const limit = 1024 * 1024;
    const add = (kind: Item['kind'], key: string, value: string) => {
      if (items.length >= 1000) {
        if (!warnings.includes('Storage capture stopped at 1000 entries.')) warnings.push('Storage capture stopped at 1000 entries.');
      } else if (value.length > limit) warnings.push(`Entry omitted: ${kind} ${key} exceeds the size limit.`);
      else items.push({ kind, key, value });
    };
    for (const kind of ['localStorage', 'sessionStorage'] as const) {
      try {
        const storage = window[kind];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)!;
          add(kind, key, storage.getItem(key) ?? '');
        }
      } catch { warnings.push(`${kind} could not be read.`); }
    }
    try {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (items.length >= 1000) { warnings.push('Cache enumeration stopped at the entry limit.'); break; }
          const response = await cache.match(request);
          if (!response) continue;
          const key = `${name} / ${request.url}`;
          if (!/text|json|javascript|xml/.test(response.headers.get('content-type') ?? '')) {
            warnings.push(`Cache body omitted: ${key} has no supported text content type.`);
            continue;
          }
          const reader = response.body?.getReader();
          if (!reader) continue;
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) { await reader.cancel(); break; }
            chunks.push(value);
          }
          if (size > limit) warnings.push(`Cache body omitted: ${key} exceeds 1 MiB.`);
          else {
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            add('cache', key, new TextDecoder().decode(bytes));
          }
        }
      }
    } catch { warnings.push('Cache Storage could not be fully read.'); }
    try {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        await new Promise<void>(resolve => {
          let db: IDBDatabase | undefined;
          let finished = false;
          const finish = () => { finished = true; clearTimeout(timer); db?.close(); resolve(); };
          const timer = setTimeout(() => { warnings.push(`IndexedDB timeout: ${info.name}`); finish(); }, 3000);
          const request = indexedDB.open(info.name!);
          // A database removed between enumeration and open must not be recreated.
          request.onupgradeneeded = () => request.transaction?.abort();
          request.onerror = () => { warnings.push(`IndexedDB could not be opened: ${info.name}`); finish(); };
          request.onblocked = () => { warnings.push(`IndexedDB is blocked: ${info.name}`); finish(); };
          request.onsuccess = () => {
            db = request.result;
            if (finished) { db.close(); return; }
            const stores = Array.from(db.objectStoreNames);
            if (!stores.length) { finish(); return; }
            const tx = db.transaction(stores, 'readonly');
            tx.oncomplete = finish;
            tx.onabort = () => { warnings.push(`IndexedDB read aborted: ${info.name}`); finish(); };
            for (const store of stores) {
              const cursor = tx.objectStore(store).openCursor();
              cursor.onsuccess = () => {
                const entry = cursor.result;
                if (finished || !entry) return;
                if (items.length >= 1000) { warnings.push(`IndexedDB entry limit: ${info.name}/${store}`); return; }
                try { add('indexedDB', `${info.name}/${store}/${JSON.stringify(entry.key)}`, JSON.stringify(entry.value) ?? ''); }
                catch { warnings.push(`IndexedDB value could not be serialized: ${info.name}/${store}`); }
                entry.continue();
              };
            }
          };
        });
      }
    } catch { warnings.push('IndexedDB could not be fully read.'); }
    const text = document.body?.innerText ?? '';
    if (text.length > limit) warnings.push('Visible page text truncated at 1 MiB.');
    return { items, warnings, visibleText: text.slice(0, limit) };
  }, origin);
  if (new URL(page.url()).origin !== origin) throw new Error('The page left the target origin during capture.');
  const cookies = (await page.context().cookies()).filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '');
    const host = new URL(origin).hostname;
    return host === domain || (cookie.domain.startsWith('.') && host.endsWith(`.${domain}`));
  });
  for (const cookie of cookies) state.items.push({
    kind: 'cookie', key: `${cookie.domain}${cookie.path} ${cookie.name}`, value: cookie.value,
  });
  return { stage, time: new Date().toISOString(), url: page.url(), ...state };
}
