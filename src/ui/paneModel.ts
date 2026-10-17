import type { SessionState } from '../core/sessionState';
import type { PageRef } from '../types';

export interface PaneModel {
  scanning: boolean;
  count: number;
  lastPage: PageRef | null;
  canDiscard: boolean;
}

export function paneModel(state: SessionState | null): PaneModel {
  if (!state) return { scanning: false, count: 0, lastPage: null, canDiscard: false };
  const pages = state.data.pages;
  const scanning = state.data.phase === 'scanning';
  return {
    scanning,
    count: pages.length,
    lastPage: pages.length > 0 ? pages[pages.length - 1] : null,
    canDiscard: scanning && pages.length > 0,
  };
}

export function statusText(count: number): string {
  return `Scanning: ${count} ${count === 1 ? 'page' : 'pages'}`;
}
