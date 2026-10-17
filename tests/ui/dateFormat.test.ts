import { describe, expect, it, vi } from 'vitest';

// The obsidian package has no runtime entry; supply its `moment` export from the
// real moment package (which is what Obsidian bundles at runtime).
vi.mock('obsidian', async () => {
  const real = await vi.importActual<{ default: unknown }>('moment');
  return { moment: real.default };
});

import { formatDate, nowStamp } from '../../src/ui/dateFormat';

describe('dateFormat', () => {
  it('formatDate formats the given date with a moment pattern', () => {
    const d = new Date(2026, 9, 17, 9, 5, 7);
    expect(formatDate(d, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-10-17 09:05:07');
    expect(formatDate(d, 'YYYYMMDD-HHmmss')).toBe('20261017-090507');
  });

  it('formatDate does not mutate the date it formats', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    const before = d.getTime();
    formatDate(d, 'YYYY');
    expect(d.getTime()).toBe(before);
  });

  it('nowStamp formats the current time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 17, 23, 59, 1));
      expect(nowStamp('YYYYMMDD-HHmmss')).toBe('20261017-235901');
    } finally {
      vi.useRealTimers();
    }
  });
});
