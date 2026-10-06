import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exchange, Observation, Snapshot } from './types.js';
import { compare } from './compare.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));

export async function saveJson(directory: string, name: string, data: unknown) {
  await writeFile(join(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export async function writeReport(directory: string, snapshots: Snapshot[], exchanges: Exchange[], marker: string) {
  const redact = (value: string) => value.split(marker).join('[marker]');
  const location = (value: string) => {
    // Remove query strings and fragments from URLs, including cache entry keys.
    return redact(value.replace(/https?:\/\/[^\s]+/g, match => {
      try { const url = new URL(match); return `${url.origin}${url.pathname}`; }
      catch { return '[URL]'; }
    }));
  };
  const observations: Observation[] = compare(snapshots, exchanges, marker).map(o => ({
    ...o, location: location(o.location), detail: redact(o.detail),
  }));
  const first = snapshots.find(s => s.stage === 'account-a');
  const markerSeen = !!first && (first.visibleText.includes(marker) || first.items.some(i => i.value.includes(marker))
    || exchanges.some(e => e.stage === 'account-a' && e.body?.includes(marker)));
  const summary = {
    markerSeenInAccountA: markerSeen,
    observations,
    snapshots: snapshots.map(s => ({ stage: s.stage, time: s.time, url: location(s.url),
      warnings: s.warnings.map(location) })),
    omittedResponses: exchanges.filter(e => e.error).length,
  };
  await saveJson(directory, 'report.json', summary);
  const rows = observations.map(o => `<tr><td>${escape(o.stage)}</td><td>${escape(o.kind)}</td><td>${escape(o.location)}</td><td>${escape(o.detail)}</td></tr>`).join('');
  const stages = summary.snapshots.map(s => `<li><b>${escape(s.stage)}</b> · ${escape(s.time)} · ${escape(s.url)}${s.warnings.map(w => `<p>${escape(w)}</p>`).join('')}</li>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>AfterLogout report</title><style>
body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 24px;color:#20252b;background:#fafafa}h1{margin-bottom:0}table{width:100%;border-collapse:collapse;background:white}th,td{padding:12px;text-align:left;border:1px solid #ddd;vertical-align:top;overflow-wrap:anywhere}li{margin:12px 0}p{max-width:850px}small{color:#555}
</style></head><body><h1>AfterLogout</h1><p>Browser evidence across an account switch</p>
<p>${markerSeen ? `${observations.length} marker observations after account A.` : 'The marker was not recorded under account A. This run cannot establish a useful baseline.'}</p>
<p>These are observations, not automatically confirmed vulnerabilities. Account labels were supplied by the researcher. Confirm identity and unauthorized access using the raw evidence.</p>
<h2>Timeline</h2><ol>${stages}</ol><h2>Observations</h2>
${rows ? `<table><thead><tr><th>Stage</th><th>Evidence</th><th>Location</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No matching observations. This does not establish that the application is secure.</p>'}
<p>${summary.omittedResponses} response bodies were omitted or unavailable. Check snapshot warnings for other capture limits.</p>
<h2>Evidence files</h2><p>Stage JSON files contain raw browser data. Stage PNG files are raw screenshots. network.json contains captured response bodies. manifest.json records SHA-256 hashes for the saved files.</p>
<small>Storage values, response bodies, screenshots, and the marker are excluded from this report. URL queries and fragments are removed. Paths and storage names may still be sensitive; review before sharing. Hashes detect changes against this manifest; they do not authenticate a capture.</small>
</body></html>`;
  await writeFile(join(directory, 'report.html'), html, { mode: 0o600 });
  const files: Record<string, string> = {};
  for (const file of (await readdir(directory)).sort()) {
    if (file === 'manifest.json') continue;
    files[file] = createHash('sha256').update(await readFile(join(directory, file))).digest('hex');
  }
  await saveJson(directory, 'manifest.json', { algorithm: 'sha256', files });
  return summary;
}
