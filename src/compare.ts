import type { Exchange, Observation, Snapshot } from './types.js';

export function compare(snapshots: Snapshot[], exchanges: Exchange[], marker: string): Observation[] {
  const first = snapshots.find(s => s.stage === 'account-a');
  if (!first) throw new Error('Missing account-a snapshot.');
  const observedInA = first.visibleText.includes(marker) || first.items.some(i => i.value.includes(marker))
    || exchanges.some(e => e.stage === 'account-a' && e.body?.includes(marker));
  if (!observedInA) return [];

  const observations: Observation[] = [];
  for (const snapshot of snapshots.filter(s => s.stage !== 'account-a')) {
    for (const item of snapshot.items.filter(i => i.value.includes(marker))) {
      const earlier = first.items.find(i => i.kind === item.kind && i.key === item.key);
      observations.push({
        stage: snapshot.stage, kind: 'stored-marker', location: `${item.kind}: ${item.key}`,
        detail: earlier?.value === item.value
          ? 'The same value recorded under account A is still stored. Storage alone does not prove access.'
          : 'The account A marker is present in this storage entry. Storage alone does not prove access.',
      });
    }
    if (snapshot.visibleText.includes(marker)) observations.push({
      stage: snapshot.stage, kind: 'visible-marker', location: 'Page text',
      detail: 'The account A marker appears in rendered page text. Check the screenshot and confirm the current account manually.',
    });
  }
  for (const exchange of exchanges.filter(e => e.stage !== 'account-a' && e.body?.includes(marker))) {
    observations.push({ stage: exchange.stage, kind: 'response-marker', location: exchange.url,
      detail: `A ${exchange.status} response contains the account A marker (source: ${exchange.source}).` });
  }
  return observations;
}
