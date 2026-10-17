import { describe, it, expect } from 'vitest';
import { SessionState } from '../../src/core/sessionState';
import { paneModel, statusText } from '../../src/ui/paneModel';
import type { SessionData } from '../../src/types';

function data(over: Partial<SessionData> = {}): SessionData {
  return {
    id: 's', startedAt: 0, watchRoot: 'r', destinationFolder: '', templateName: '', filename: '',
    appendTarget: null, pages: [], discardedPaths: [], phase: 'scanning', ...over,
  };
}

describe('paneModel', () => {
  it('is idle without a session', () => {
    expect(paneModel(null)).toEqual({ scanning: false, count: 0, lastPage: null, canDiscard: false });
  });

  it('counts pages and exposes the last one', () => {
    const s = new SessionState(data());
    s.addFile('a.pdf', 2, 'pdf', 1);
    const m = paneModel(s);
    expect(m.scanning).toBe(true);
    expect(m.count).toBe(2);
    expect(m.lastPage?.id).toBe('a.pdf#1');
    expect(m.canDiscard).toBe(true);
  });

  it('cannot discard with no pages', () => {
    const m = paneModel(new SessionState(data()));
    expect(m).toEqual({ scanning: true, count: 0, lastPage: null, canDiscard: false });
  });

  it('is not scanning in review', () => {
    const m = paneModel(new SessionState(data({ phase: 'review' })));
    expect(m.scanning).toBe(false);
    expect(m.canDiscard).toBe(false);
  });
});

describe('statusText', () => {
  it('formats singular and plural', () => {
    expect(statusText(1)).toBe('Scanning: 1 page');
    expect(statusText(0)).toBe('Scanning: 0 pages');
    expect(statusText(12)).toBe('Scanning: 12 pages');
  });
});
