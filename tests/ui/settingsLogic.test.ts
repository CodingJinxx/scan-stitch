import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { ScanStitchSettings } from '../../src/types';
import {
  addTemplate,
  deleteTemplate,
  describePlaceholders,
  parseBoundedInt,
  selectedDirFromFile,
  patternsFromToggles,
  togglesFromPatterns,
  updateTemplate,
  validateTemplate,
} from '../../src/ui/settingsLogic';

function base(): ScanStitchSettings {
  return {
    ...DEFAULT_SETTINGS,
    templates: [
      { name: 'Scan', pattern: 'Scan {date}' },
      { name: 'Invoice', pattern: 'Invoice {counter}', folder: 'Invoices' },
    ],
    defaultTemplate: 'Scan',
    recentLocations: [],
    session: null,
  };
}

describe('patterns and toggles', () => {
  it('maps patterns to toggles', () => {
    expect(togglesFromPatterns(['*.pdf'])).toEqual({ pdf: true, jpeg: false, png: false });
    expect(togglesFromPatterns(['*.jpg', '*.jpeg', '*.png'])).toEqual({ pdf: false, jpeg: true, png: true });
    expect(togglesFromPatterns(['*.JPG'])).toEqual({ pdf: false, jpeg: true, png: false });
  });

  it('maps toggles to patterns', () => {
    expect(patternsFromToggles({ pdf: true, jpeg: false, png: false })).toEqual(['*.pdf']);
    expect(patternsFromToggles({ pdf: true, jpeg: true, png: true })).toEqual(['*.pdf', '*.jpg', '*.jpeg', '*.png']);
  });

  it('keeps at least one pattern enabled', () => {
    expect(patternsFromToggles({ pdf: false, jpeg: false, png: false })).toEqual(['*.pdf']);
  });
});

describe('parseBoundedInt', () => {
  it('accepts integers in range', () => {
    expect(parseBoundedInt('1000', 100, 30000)).toEqual({ ok: true, value: 1000 });
    expect(parseBoundedInt(' 100 ', 100, 30000)).toEqual({ ok: true, value: 100 });
  });
  it('rejects out of range, decimals and junk', () => {
    expect(parseBoundedInt('99', 100, 30000).ok).toBe(false);
    expect(parseBoundedInt('30001', 100, 30000).ok).toBe(false);
    expect(parseBoundedInt('1.5', 1, 20).ok).toBe(false);
    expect(parseBoundedInt('abc', 1, 20).ok).toBe(false);
    expect(parseBoundedInt('', 1, 20).ok).toBe(false);
  });
});

describe('validateTemplate', () => {
  const t = base().templates;
  it('requires a name and a pattern', () => {
    expect(validateTemplate(t, { name: ' ', pattern: 'x' })).toBe('name-required');
    expect(validateTemplate(t, { name: 'New', pattern: '  ' })).toBe('pattern-required');
  });
  it('requires a unique name, case-insensitively', () => {
    expect(validateTemplate(t, { name: 'scan', pattern: 'x' })).toBe('name-duplicate');
  });
  it('allows keeping the name when editing', () => {
    expect(validateTemplate(t, { name: 'SCAN', pattern: 'x' }, 'Scan')).toBeNull();
  });
  it('accepts a valid new template', () => {
    expect(validateTemplate(t, { name: 'New', pattern: 'x' })).toBeNull();
  });
});

describe('template mutations', () => {
  it('adds a template without touching the default', () => {
    const s = base();
    addTemplate(s, { name: 'New', pattern: 'N {date}', folder: '' });
    expect(s.templates.map((x) => x.name)).toEqual(['Scan', 'Invoice', 'New']);
    expect(s.templates[2]).toEqual({ name: 'New', pattern: 'N {date}' });
    expect(s.defaultTemplate).toBe('Scan');
  });

  it('updates a template and follows a renamed default', () => {
    const s = base();
    updateTemplate(s, 'Scan', { name: 'Daily', pattern: 'D', folder: 'F' });
    expect(s.templates[0]).toEqual({ name: 'Daily', pattern: 'D', folder: 'F' });
    expect(s.defaultTemplate).toBe('Daily');
  });

  it('drops an empty stored folder', () => {
    const s = base();
    updateTemplate(s, 'Invoice', { name: 'Invoice', pattern: 'I', folder: '  ' });
    expect(s.templates[1]).toEqual({ name: 'Invoice', pattern: 'I' });
  });

  it('deleting the default promotes the first remaining', () => {
    const s = base();
    deleteTemplate(s, 'Scan');
    expect(s.templates.map((x) => x.name)).toEqual(['Invoice']);
    expect(s.defaultTemplate).toBe('Invoice');
  });

  it('deleting a non-default keeps the default', () => {
    const s = base();
    deleteTemplate(s, 'Invoice');
    expect(s.defaultTemplate).toBe('Scan');
  });

  it('refuses to delete the last template', () => {
    const s = base();
    deleteTemplate(s, 'Invoice');
    expect(deleteTemplate(s, 'Scan')).toBe(false);
    expect(s.templates).toHaveLength(1);
  });
});

describe('describePlaceholders', () => {
  it('lists every supported placeholder', () => {
    const names = describePlaceholders().map((p) => p.token);
    expect(names).toEqual(['{date}', '{time}', '{year}', '{month}', '{day}', '{pages}', '{counter}', '{folder}']);
    expect(describePlaceholders()[0].description).toContain('{date:YYYY-MM-DD}');
  });
});

const win = (s: string): string => s.split('|').join(String.fromCharCode(92));

describe('selectedDirFromFile', () => {
  it('strips the relative part below the picked folder', () => {
    expect(selectedDirFromFile(win('C:|Dev|Scans|a|b.pdf'), 'Scans/a/b.pdf')).toBe(win('C:|Dev|Scans'));
    expect(selectedDirFromFile('/home/u/Scans/b.pdf', 'Scans/b.pdf')).toBe('/home/u/Scans');
  });
  it('falls back to the parent directory without a relative path', () => {
    expect(selectedDirFromFile(win('C:|Dev|Scans|b.pdf'), '')).toBe(win('C:|Dev|Scans'));
  });
});

describe('template folder guard', () => {
  it('rejects a stored folder that leaves the vault', () => {
    const t = base().templates;
    for (const folder of ['../outside', 'a/../../b', 'C:\\x', '..\\x']) {
      expect(validateTemplate(t, { name: 'New', pattern: 'x', folder }), folder).toBe('folder-invalid');
    }
    expect(validateTemplate(t, { name: 'New', pattern: 'x', folder: '  ' })).toBeNull();
    expect(validateTemplate(t, { name: 'New', pattern: 'x', folder: './Docs/' })).toBeNull();
  });
  it('stores the normalised folder', () => {
    const s = base();
    addTemplate(s, { name: 'New', pattern: 'x', folder: '/Docs/./Inbox\\2026/' });
    expect(s.templates[2]).toEqual({ name: 'New', pattern: 'x', folder: 'Docs/Inbox/2026' });
    addTemplate(s, { name: 'Bad', pattern: 'x', folder: '../outside' });
    expect(s.templates[3]).toEqual({ name: 'Bad', pattern: 'x' });
  });
});
