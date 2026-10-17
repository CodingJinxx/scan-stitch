import { nextCounter, resolveTemplate, sanitizeFileName } from '../core/template';
import type { ScanStitchSettings, Template } from '../types';

export interface StartInit {
  destinationFolder: string;
  templateName: string;
  filename: string;
  appendTarget: string | null;
}

export type StartError = 'no-watch-root' | 'no-destination' | 'no-append-target';

export interface StartState {
  watchRoot: string;
  appendMode: boolean;
  destination: string;
  templateName: string;
  filename: string;
  appendTarget: string;
}

const FALLBACK_TEMPLATE: Template = { name: 'Scan', pattern: 'Scan {date} {time}' };

/** The named template, else the default, else the first, else a built-in fallback. */
export function pickTemplate(settings: ScanStitchSettings, name?: string): Template {
  const list = settings.templates;
  return (
    list.find((t) => t.name === name) ??
    list.find((t) => t.name === settings.defaultTemplate) ??
    list[0] ??
    FALLBACK_TEMPLATE
  );
}

/** Newest recent, else the template's stored folder, else empty. */
export function defaultDestination(settings: ScanStitchSettings, template: Template): string {
  return settings.recentLocations[0] ?? template.folder ?? '';
}

/** Last path segment; the vault root ('' or '/') has no name. */
export function folderName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? '';
}

export function parentFolder(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export interface PreviewOptions {
  now: Date;
  folder: string;
  /** File names already present in the destination folder (with or without .pdf). */
  existingNames: string[];
  format: (d: Date, fmt: string) => string;
}

const COUNTER_SENTINEL = 'COUNTER';
const PAGES_SENTINEL = 'PAGES';

/**
 * Live preview of the resulting name. `{pages}` is unknown until saving, so it
 * is shown as `?` (a character sanitising would otherwise strip).
 */
export function previewFilename(pattern: string, opts: PreviewOptions): string {
  const ctx = { now: opts.now, pages: null, folder: opts.folder, format: opts.format };
  const marked = pattern
    .replace(/\{counter\}/g, COUNTER_SENTINEL)
    .replace(/\{pages(?::[^}]*)?\}/g, PAGES_SENTINEL);
  const probe = sanitizeFileName(resolveTemplate(marked, { ...ctx, counter: 0 }))
    .split(COUNTER_SENTINEL)
    .join('{counter}');
  const counter = nextCounter(probe.split(PAGES_SENTINEL).join('?'), opts.existingNames);
  const out = sanitizeFileName(resolveTemplate(marked, { ...ctx, counter }).split(COUNTER_SENTINEL).join(String(counter)));
  return out.split(PAGES_SENTINEL).join('?');
}

export function validateStart(s: StartState): StartError | null {
  if (s.watchRoot.trim() === '') return 'no-watch-root';
  if (s.appendMode) return s.appendTarget.trim() === '' ? 'no-append-target' : null;
  return s.destination.trim() === '' ? 'no-destination' : null;
}

export function buildInit(s: StartState): StartInit | null {
  if (validateStart(s) !== null) return null;
  if (s.appendMode) {
    const target = s.appendTarget.trim();
    const file = target.slice(target.lastIndexOf('/') + 1);
    return {
      destinationFolder: parentFolder(target),
      templateName: s.templateName,
      filename: file.replace(/\.pdf$/i, ''),
      appendTarget: target,
    };
  }
  const dest = s.destination.trim();
  return {
    destinationFolder: dest === '/' ? '' : dest,
    templateName: s.templateName,
    filename: s.filename,
    appendTarget: null,
  };
}

export const START_ERROR_TEXT: Record<StartError, string> = {
  'no-watch-root': 'Set the scanner folder in the plugin settings first.',
  'no-destination': 'Choose a destination folder.',
  'no-append-target': 'Choose the PDF to append to.',
};
