import { nextCounter, resolveTemplate, sanitizeFileName } from '../core/template';
import type { ScanStitchSettings, Template } from '../types';

export interface StartInit {
  destinationFolder: string;
  templateName: string;
  filename: string;
  appendTarget: string | null;
}

export type StartError = 'no-watch-root' | 'no-destination' | 'no-append-target' | 'append-target-invalid';

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

/**
 * Segments of a vault-relative path: backslashes count as slashes, empty and `.`
 * segments are dropped, a leading slash is ignored. Returns null for a path that
 * could leave the vault or is not vault-relative: a `..` segment (or any segment
 * made only of dots and spaces, which Windows may shorten to `..`) or a `:`
 * (a drive such as `C:\x`). Obsidian's `normalizePath` resolves neither.
 */
export function vaultSegments(raw: string): string[] | null {
  const parts = raw
    .trim()
    .replace(/[\\]/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.');
  return parts.some((p) => /^[. ]+$/.test(p) || p.includes(':')) ? null : parts;
}

/**
 * Canonical UI form of a destination: trimmed, single slashes, no leading or
 * trailing slash, no `.` segments. The vault root is '/'. Empty input stays empty
 * (not chosen); so does a path that is not inside the vault (see `vaultSegments`).
 */
export function normalizeDestination(raw: string): string {
  if (raw.trim() === '') return '';
  const parts = vaultSegments(raw);
  if (parts === null) return '';
  return parts.length === 0 ? '/' : parts.join('/');
}

/** Newest recent, else the template's stored folder, else empty. The root is '/'. */
export function defaultDestination(settings: ScanStitchSettings, template: Template): string {
  const recent = settings.recentLocations[0];
  if (recent !== undefined) return recent === '' ? '/' : normalizeDestination(recent);
  return normalizeDestination(template.folder ?? '');
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

/** `isPdf` reports whether a vault path is an existing PDF; omit to skip that check. */
export function validateStart(s: StartState, isPdf?: (path: string) => boolean): StartError | null {
  if (s.watchRoot.trim() === '') return 'no-watch-root';
  if (s.appendMode) {
    if (s.appendTarget.trim() === '') return 'no-append-target';
    const target = appendTargetPath(s.appendTarget);
    if (target === null) return 'append-target-invalid';
    return isPdf && !isPdf(target) ? 'append-target-invalid' : null;
  }
  return normalizeDestination(s.destination) === '' ? 'no-destination' : null;
}

/** Vault path of the PDF to append to, or null when it is not a file path inside the vault. */
function appendTargetPath(raw: string): string | null {
  const parts = vaultSegments(raw);
  return parts === null || parts.length === 0 ? null : parts.join('/');
}

export function buildInit(s: StartState, isPdf?: (path: string) => boolean): StartInit | null {
  if (validateStart(s, isPdf) !== null) return null;
  if (s.appendMode) {
    const target = appendTargetPath(s.appendTarget) ?? '';
    const file = target.slice(target.lastIndexOf('/') + 1);
    return {
      destinationFolder: parentFolder(target),
      templateName: s.templateName,
      filename: file.replace(/\.pdf$/i, ''),
      appendTarget: target,
    };
  }
  const dest = normalizeDestination(s.destination);
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
  'append-target-invalid': 'Choose an existing PDF.',
};
