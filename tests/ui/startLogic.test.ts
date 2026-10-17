import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { ScanStitchSettings } from '../../src/types';
import {
  buildInit,
  defaultDestination,
  folderName,
  normalizeDestination,
  parentFolder,
  pickTemplate,
  previewFilename,
  validateStart,
  type StartState,
} from '../../src/ui/startLogic';

const fmt = (d: Date, f: string): string => `${f}@${d.getFullYear()}`;
const now = new Date(2026, 9, 17, 14, 5);

function settings(over: Partial<ScanStitchSettings> = {}): ScanStitchSettings {
  return { ...DEFAULT_SETTINGS, watchRoot: 'C:/Scans', ...over };
}

describe('pickTemplate', () => {
  it('returns the default template', () => {
    const s = settings({
      templates: [{ name: 'A', pattern: 'a' }, { name: 'B', pattern: 'b' }],
      defaultTemplate: 'B',
    });
    expect(pickTemplate(s).name).toBe('B');
  });
  it('falls back to the first template when the default is unknown', () => {
    const s = settings({ templates: [{ name: 'A', pattern: 'a' }], defaultTemplate: 'zzz' });
    expect(pickTemplate(s).name).toBe('A');
  });
  it('falls back to a built-in template when the list is empty', () => {
    const t = pickTemplate(settings({ templates: [] }));
    expect(t.name).toBe('Scan');
    expect(t.pattern).toContain('{date}');
  });
  it('finds a template by name', () => {
    const s = settings({ templates: [{ name: 'A', pattern: 'a' }, { name: 'B', pattern: 'b' }] });
    expect(pickTemplate(s, 'A').pattern).toBe('a');
  });
});

describe('defaultDestination', () => {
  it('prefers the newest recent', () => {
    const s = settings({ recentLocations: ['Docs/New', 'Docs/Old'] });
    expect(defaultDestination(s, { name: 'x', pattern: 'x', folder: 'Stored' })).toBe('Docs/New');
  });
  it('uses the template folder without recents', () => {
    expect(defaultDestination(settings(), { name: 'x', pattern: 'x', folder: 'Stored' })).toBe('Stored');
  });
  it('is empty otherwise', () => {
    expect(defaultDestination(settings(), { name: 'x', pattern: 'x' })).toBe('');
  });
});

describe('folder helpers', () => {
  it('takes the last segment as folder name', () => {
    expect(folderName('A/B/Invoices')).toBe('Invoices');
    expect(folderName('Invoices')).toBe('Invoices');
    expect(folderName('')).toBe('');
    expect(folderName('/')).toBe('');
  });
  it('computes the parent folder', () => {
    expect(parentFolder('A/B/file.pdf')).toBe('A/B');
    expect(parentFolder('file.pdf')).toBe('');
  });
});

describe('previewFilename', () => {
  const base = { now, folder: 'Invoices', existingNames: [] as string[], format: fmt };
  it('renders pages as ? and sanitises', () => {
    expect(previewFilename('Scan {pages}p: x', base)).toBe('Scan ?p x');
  });
  it('uses the folder name', () => {
    expect(previewFilename('{folder} scan', base)).toBe('Invoices scan');
  });
  it('uses the format function', () => {
    expect(previewFilename('{date}', base)).toBe('YYYY-MM-DD@2026');
  });
  it('uses the next free counter', () => {
    expect(previewFilename('Scan {counter}', { ...base, existingNames: ['Scan 1.pdf', 'Scan 2.pdf'] })).toBe('Scan 3');
    expect(previewFilename('Scan {counter}', base)).toBe('Scan 1');
  });
});

describe('validateStart / buildInit', () => {
  const ok: StartState = {
    watchRoot: 'C:/Scans',
    appendMode: false,
    destination: 'Docs',
    templateName: 'Scan',
    filename: 'Scan 1',
    appendTarget: '',
  };
  it('accepts a complete state', () => {
    expect(validateStart(ok)).toBeNull();
    expect(buildInit(ok)).toEqual({
      destinationFolder: 'Docs',
      templateName: 'Scan',
      filename: 'Scan 1',
      appendTarget: null,
    });
  });
  it('requires a watch root first', () => {
    expect(validateStart({ ...ok, watchRoot: '  ' })).toBe('no-watch-root');
    expect(buildInit({ ...ok, watchRoot: '' })).toBeNull();
  });
  it('requires a destination when not appending', () => {
    expect(validateStart({ ...ok, destination: '  ' })).toBe('no-destination');
  });
  it('treats / as the vault root and normalises it to empty', () => {
    expect(validateStart({ ...ok, destination: '/' })).toBeNull();
    expect(buildInit({ ...ok, destination: '/' })?.destinationFolder).toBe('');
  });
  it('requires an append target in append mode', () => {
    expect(validateStart({ ...ok, appendMode: true, appendTarget: '' })).toBe('no-append-target');
  });
  it('ignores destination in append mode and derives it from the file', () => {
    const s = { ...ok, appendMode: true, destination: '', appendTarget: 'A/B/Report 1.pdf' };
    expect(validateStart(s)).toBeNull();
    expect(buildInit(s)).toEqual({
      destinationFolder: 'A/B',
      templateName: 'Scan',
      filename: 'Report 1',
      appendTarget: 'A/B/Report 1.pdf',
    });
  });
});

describe('root and normalisation (review fixes)', () => {
  const st: StartState = {
    watchRoot: 'C:/Scans', appendMode: false, destination: 'Docs',
    templateName: 'Scan', filename: 'x', appendTarget: '',
  };
  it('defaultDestination maps a root recent to /', () => {
    const s = settings({ recentLocations: ['', 'A'] });
    expect(defaultDestination(s, { name: 'x', pattern: 'x' })).toBe('/');
  });
  it('root is startable and emits an empty folder', () => {
    expect(validateStart({ ...st, destination: '/' })).toBeNull();
    expect(buildInit({ ...st, destination: '/' })?.destinationFolder).toBe('');
  });
  it('normalises typed destinations', () => {
    expect(normalizeDestination('Docs/')).toBe('Docs');
    expect(normalizeDestination(' Docs ')).toBe('Docs');
    expect(normalizeDestination('/Docs')).toBe('Docs');
    expect(normalizeDestination('//A//B/')).toBe('A/B');
    expect(normalizeDestination('/')).toBe('/');
    expect(normalizeDestination('  ')).toBe('');
    expect(buildInit({ ...st, destination: 'Docs/' })?.destinationFolder).toBe('Docs');
    expect(buildInit({ ...st, destination: ' Docs ' })?.destinationFolder).toBe('Docs');
    expect(buildInit({ ...st, destination: '/Docs' })?.destinationFolder).toBe('Docs');
  });
  it('rejects an append target that is not an existing pdf', () => {
    const a = { ...st, appendMode: true, appendTarget: 'A/x.pdf' };
    expect(validateStart(a, () => false)).toBe('append-target-invalid');
    expect(buildInit(a, () => false)).toBeNull();
    expect(validateStart(a, () => true)).toBeNull();
  });
});

describe('path traversal guard', () => {
  const st: StartState = {
    watchRoot: 'C:/Scans', appendMode: false, destination: 'Docs',
    templateName: 'Scan', filename: 'x', appendTarget: '',
  };
  it('rejects any .. segment', () => {
    for (const raw of ['..', '../outside', 'a/../../b', 'Docs/..', '..\\outside', 'a\\..\\..\\b', '/../x', 'a/.. /b']) {
      expect(normalizeDestination(raw), raw).toBe('');
      expect(validateStart({ ...st, destination: raw }), raw).toBe('no-destination');
      expect(buildInit({ ...st, destination: raw }), raw).toBeNull();
    }
  });
  it('drops . segments', () => {
    expect(normalizeDestination('./Docs')).toBe('Docs');
    expect(normalizeDestination('Docs/./x')).toBe('Docs/x');
    expect(normalizeDestination('.\\Docs')).toBe('Docs');
    expect(normalizeDestination('Docs\\.\\x')).toBe('Docs/x');
    expect(normalizeDestination('./')).toBe('/');
  });
  it('rejects absolute Windows paths and keeps a leading slash vault-relative', () => {
    expect(normalizeDestination('C:\\x')).toBe('');
    expect(normalizeDestination('C:/x')).toBe('');
    expect(normalizeDestination('\\\\server\\share')).toBe('server/share');
    expect(normalizeDestination('/Docs/x')).toBe('Docs/x');
    expect(normalizeDestination('\\Docs')).toBe('Docs');
  });
  it('defaultDestination ignores an unsafe template folder or recent', () => {
    expect(defaultDestination(settings(), { name: 'x', pattern: 'x', folder: '../outside' })).toBe('');
    expect(defaultDestination(settings({ recentLocations: ['a/../../b'] }), { name: 'x', pattern: 'x' })).toBe('');
  });
  it('rejects an append target outside the vault', () => {
    for (const t of ['../outside/x.pdf', 'a\\..\\..\\x.pdf', 'C:\\x.pdf', './']) {
      const a = { ...st, appendMode: true, appendTarget: t };
      expect(validateStart(a, () => true), t).toBe('append-target-invalid');
      expect(buildInit(a, () => true), t).toBeNull();
    }
  });
  it('normalises an append target before checking and using it', () => {
    const seen: string[] = [];
    const a = { ...st, appendMode: true, appendTarget: '/A\\./B/x.pdf' };
    const init = buildInit(a, (p) => (seen.push(p), true));
    expect(seen).toContain('A/B/x.pdf');
    expect(init).toEqual({ destinationFolder: 'A/B', templateName: 'Scan', filename: 'x', appendTarget: 'A/B/x.pdf' });
  });
});
