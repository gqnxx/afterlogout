export type Stage = 'account-a' | 'logged-out' | 'account-b';

export interface Item {
  kind: 'cookie' | 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cache';
  key: string;
  value: string;
}

export interface Exchange {
  stage: Stage;
  time: string;
  url: string;
  status: number;
  source: 'network' | 'disk-cache' | 'service-worker';
  body?: string;
  error?: string;
}

export interface Snapshot {
  stage: Stage;
  time: string;
  url: string;
  items: Item[];
  visibleText: string;
  warnings: string[];
}

export interface Observation {
  stage: Stage;
  kind: string;
  location: string;
  detail: string;
}
