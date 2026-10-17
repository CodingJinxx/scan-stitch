import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../../src/core/settings';

const session = {
  id: 's1', startedAt: 1, watchRoot: '', destinationFolder: '', templateName: 'Scan',
  filename: 'x', appendTarget: null, pages: [], discardedPaths: [], phase: 'scanning',
};

describe('loadSettings', () => {
  it('returns defaults for undefined, null and non-objects', () => {
    for (const raw of [undefined, null, 5, 'x', []]) {
      expect(loadSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });
  it('returns fresh copies, not default references', () => {
    const s = loadSettings(undefined);
    expect(s.patterns).not.toBe(DEFAULT_SETTINGS.patterns);
    expect(s.templates).not.toBe(DEFAULT_SETTINGS.templates);
    expect(s.templates[0]).not.toBe(DEFAULT_SETTINGS.templates[0]);
    expect(s.recentLocations).not.toBe(DEFAULT_SETTINGS.recentLocations);
  });
  it('keeps user values and fills the rest', () => {
    const s = loadSettings({ watchRoot: 'Inbox', stabilityDelayMs: 500 });
    expect(s.watchRoot).toBe('Inbox');
    expect(s.stabilityDelayMs).toBe(500);
    expect(s.patterns).toEqual(['*.pdf']);
    expect(s.includeSubfolders).toBe(true);
  });
  it('replaces wrongly-typed fields with defaults', () => {
    const s = loadSettings({
      watchRoot: 3, includeSubfolders: 'yes', patterns: 'x', stabilityDelayMs: -1,
      stabilityRetries: 2.5, recentLocations: 'a',
    });
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ stabilityDelayMs: NaN }).stabilityDelayMs).toBe(1000);
    expect(loadSettings({ stabilityDelayMs: Infinity }).stabilityDelayMs).toBe(1000);
    expect(loadSettings({ stabilityRetries: 4 }).stabilityRetries).toBe(4);
  });
  it('drops template entries with empty name or non-string pattern', () => {
    const s = loadSettings({
      templates: [
        { name: '', pattern: 'a' },
        { name: 'Ok', pattern: 'b', folder: 'F' },
        { name: 'Bad', pattern: 3 },
        null,
      ],
      defaultTemplate: 'Ok',
    });
    expect(s.templates).toEqual([{ name: 'Ok', pattern: 'b', folder: 'F' }]);
  });
  it('uses default templates when none survive', () => {
    const s = loadSettings({ templates: [{ name: '', pattern: 'a' }], defaultTemplate: 'zzz' });
    expect(s.templates).toEqual(DEFAULT_SETTINGS.templates);
    expect(s.defaultTemplate).toBe('Scan');
  });
  it('falls back to first template when defaultTemplate is missing', () => {
    const s = loadSettings({
      templates: [{ name: 'A', pattern: 'a' }, { name: 'B', pattern: 'b' }],
      defaultTemplate: 'Nope',
    });
    expect(s.defaultTemplate).toBe('A');
  });
  it('keeps a valid session, nulls an invalid one', () => {
    expect(loadSettings({ session }).session).toEqual(session);
    expect(loadSettings({ session: { id: 1, pages: [] } }).session).toBeNull();
    expect(loadSettings({ session: { id: 'a', pages: 'x' } }).session).toBeNull();
    expect(loadSettings({ session: 'x' }).session).toBeNull();
  });
  it('caps recentLocations at 5 strings', () => {
    const s = loadSettings({ recentLocations: ['1', 2, '3', '4', '5', '6', '7'] });
    expect(s.recentLocations).toEqual(['1', '3', '4', '5', '6']);
  });
});
