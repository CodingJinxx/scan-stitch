import type { ScanStitchSettings, Template } from '../types';

export interface PatternToggles {
  pdf: boolean;
  jpeg: boolean;
  png: boolean;
}

export function togglesFromPatterns(patterns: string[]): PatternToggles {
  const has = (p: string): boolean => patterns.some((x) => x.toLowerCase() === p);
  return { pdf: has('*.pdf'), jpeg: has('*.jpg') || has('*.jpeg'), png: has('*.png') };
}

/** Never returns an empty list: at least PDF stays enabled. */
export function patternsFromToggles(t: PatternToggles): string[] {
  const out: string[] = [];
  if (t.pdf) out.push('*.pdf');
  if (t.jpeg) out.push('*.jpg', '*.jpeg');
  if (t.png) out.push('*.png');
  return out.length === 0 ? ['*.pdf'] : out;
}

export type IntResult = { ok: true; value: number } | { ok: false };

export function parseBoundedInt(raw: string, min: number, max: number): IntResult {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return { ok: false };
  const value = Number(s);
  return value >= min && value <= max ? { ok: true, value } : { ok: false };
}

export type TemplateError = 'name-required' | 'name-duplicate' | 'pattern-required';

export const TEMPLATE_ERROR_TEXT: Record<TemplateError, string> = {
  'name-required': 'Enter a name',
  'name-duplicate': 'A template with this name already exists',
  'pattern-required': 'Enter a pattern',
};

export interface TemplateDraft {
  name: string;
  pattern: string;
  folder?: string;
}

export function validateTemplate(
  templates: Template[],
  candidate: TemplateDraft,
  editingName?: string,
): TemplateError | null {
  const name = candidate.name.trim();
  if (name === '') return 'name-required';
  const lower = name.toLowerCase();
  const clash = templates.some(
    (t) => t.name.toLowerCase() === lower && (editingName === undefined || t.name !== editingName),
  );
  if (clash) return 'name-duplicate';
  if (candidate.pattern.trim() === '') return 'pattern-required';
  return null;
}

function toTemplate(d: TemplateDraft): Template {
  const t: Template = { name: d.name.trim(), pattern: d.pattern.trim() };
  const folder = d.folder?.trim();
  if (folder) t.folder = folder;
  return t;
}

export function addTemplate(settings: ScanStitchSettings, draft: TemplateDraft): void {
  settings.templates.push(toTemplate(draft));
}

export function updateTemplate(settings: ScanStitchSettings, oldName: string, draft: TemplateDraft): void {
  const i = settings.templates.findIndex((t) => t.name === oldName);
  if (i < 0) return;
  const next = toTemplate(draft);
  settings.templates[i] = next;
  if (settings.defaultTemplate === oldName) settings.defaultTemplate = next.name;
}

/** Returns false (and changes nothing) when it would remove the last template. */
export function deleteTemplate(settings: ScanStitchSettings, name: string): boolean {
  if (settings.templates.length <= 1) return false;
  const i = settings.templates.findIndex((t) => t.name === name);
  if (i < 0) return false;
  settings.templates.splice(i, 1);
  if (settings.defaultTemplate === name) settings.defaultTemplate = settings.templates[0].name;
  return true;
}

export function describePlaceholders(): { token: string; description: string }[] {
  return [
    { token: '{date}', description: 'Date, YYYY-MM-DD by default. Add a format such as {date:YYYY-MM-DD}.' },
    { token: '{time}', description: 'Time, HH-mm by default. Add a format such as {time:HH-mm-ss}.' },
    { token: '{year}', description: 'Four-digit year.' },
    { token: '{month}', description: 'Two-digit month.' },
    { token: '{day}', description: 'Two-digit day.' },
    { token: '{pages}', description: 'Number of pages, filled in when saving.' },
    { token: '{counter}', description: 'Next unused number for that name in the destination folder.' },
    { token: '{folder}', description: 'Name of the destination folder.' },
  ];
}

/**
 * Folder picked through `<input webkitdirectory>`: `fullPath` is a file inside it and
 * `relativePath` is that file's `webkitRelativePath` ("Picked/sub/file.pdf").
 */
export function selectedDirFromFile(fullPath: string, relativePath: string): string {
  const parts = relativePath.split('/').filter((p) => p !== '');
  // Segments below the picked folder, ending with the file name (all of them when no relative path).
  const strip = parts.length === 0 ? 1 : parts.length - 1;
  let dir = fullPath;
  for (let i = 0; i < strip; i++) {
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf(BACKSLASH));
    if (cut < 0) break;
    dir = dir.slice(0, cut);
  }
  return dir;
}

const BACKSLASH = String.fromCharCode(92);
