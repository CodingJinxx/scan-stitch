import { describe, expect, it } from 'vitest';
type MomentFn = (d: Date) => { format: (f: string) => string };
const moment = ((await import('moment')) as unknown as { default: MomentFn }).default;
import {
  findUnknownPlaceholders,
  nextCounter,
  resolveTemplate,
  sanitizeFileName,
  uniqueName,
  type TemplateContext,
} from '../../src/core/template';

const ctx: TemplateContext = {
  now: new Date(2026, 9, 17, 14, 5),
  pages: 7,
  counter: 3,
  folder: 'Receipts',
  format: (d, fmt) => moment(d).format(fmt),
};

describe('resolveTemplate', () => {
  it('formats date and time with defaults', () => {
    expect(resolveTemplate('{date}', ctx)).toBe('2026-10-17');
    expect(resolveTemplate('{time}', ctx)).toBe('14-05');
  });
  it('honours a custom format', () => {
    expect(resolveTemplate('{date:DD.MM.YYYY}', ctx)).toBe('17.10.2026');
  });
  it('resolves year, month, day', () => {
    expect(resolveTemplate('{year}{month}{day}', ctx)).toBe('20261017');
  });
  it('resolves folder, pages and counter', () => {
    expect(resolveTemplate('{folder}-{pages}-{counter}', ctx)).toBe('Receipts-7-3');
  });
  it('renders ? for unknown page count', () => {
    expect(resolveTemplate('{pages}', { ...ctx, pages: null })).toBe('?');
  });
  it('leaves unknown placeholders literal', () => {
    expect(resolveTemplate('A {foo}', ctx)).toBe('A {foo}');
  });
});

describe('findUnknownPlaceholders', () => {
  it('lists unknown names only', () => {
    expect(findUnknownPlaceholders('A {foo} {date}')).toEqual(['foo']);
  });
});

describe('sanitizeFileName', () => {
  it('removes illegal characters', () => {
    expect(sanitizeFileName('a/b:c*?"<>|\\d')).not.toMatch(/[\\/:*?"<>|]/);
  });
  it('removes control characters', () => {
    expect(sanitizeFileName('a\u0001b\nc')).toBe('abc');
  });
  it('makes reserved device names safe', () => {
    expect(sanitizeFileName('CON')).not.toBe('CON');
    expect(sanitizeFileName('CON').toLowerCase()).toContain('con');
    expect(sanitizeFileName('nul.pdf')).not.toMatch(/^nul(\.|$)/i);
    expect(sanitizeFileName('COM1')).not.toBe('COM1');
    expect(sanitizeFileName('lpt9.txt')).not.toMatch(/^lpt9(\.|$)/i);
  });
  it('strips trailing dots and spaces', () => {
    expect(sanitizeFileName('abc. . ')).toBe('abc');
  });
  it('never returns an empty string', () => {
    expect(sanitizeFileName('')).toBe('Scan');
    expect(sanitizeFileName('...')).toBe('Scan');
    expect(sanitizeFileName('???')).toBe('Scan');
  });
  it('keeps normal names', () => {
    expect(sanitizeFileName('Scan 2026-10-17')).toBe('Scan 2026-10-17');
  });
});

describe('uniqueName', () => {
  it('returns base when free', () => {
    expect(uniqueName('Scan', () => false)).toBe('Scan');
  });
  it('appends the next free number', () => {
    expect(uniqueName('Scan', (n) => ['Scan', 'Scan 2'].includes(n))).toBe('Scan 3');
  });
});

describe('nextCounter', () => {
  it('returns 1 when nothing matches', () => {
    expect(nextCounter('Scan {counter}', ['Other'])).toBe(1);
  });
  it('returns the next unused integer', () => {
    expect(nextCounter('Scan {counter}', ['Scan 1', 'Scan 2', 'Other'])).toBe(3);
    expect(nextCounter('Scan {counter}', ['Scan 1', 'Scan 3'])).toBe(2);
  });
  it('ignores a .pdf extension on existing names', () => {
    expect(nextCounter('Scan {counter}', ['Scan 1.pdf'])).toBe(2);
  });
});
