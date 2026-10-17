import type { ScanStitchSettings, SessionData, Template } from '../types';

export const DEFAULT_SETTINGS: ScanStitchSettings = {
  watchRoot: '',
  includeSubfolders: true,
  patterns: ['*.pdf'],
  stabilityDelayMs: 1000,
  stabilityRetries: 3,
  templates: [{ name: 'Scan', pattern: 'Scan {date} {time}' }],
  defaultTemplate: 'Scan',
  recentLocations: [],
  session: null,
};

const MAX_RECENTS = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function nonNegNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
}

function stringArray(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...fallback];
}

function cleanTemplates(v: unknown): Template[] {
  if (!Array.isArray(v)) return [];
  const out: Template[] = [];
  for (const t of v) {
    if (!isRecord(t)) continue;
    if (typeof t.name !== 'string' || t.name === '' || typeof t.pattern !== 'string') continue;
    const tpl: Template = { name: t.name, pattern: t.pattern };
    if (typeof t.folder === 'string') tpl.folder = t.folder;
    out.push(tpl);
  }
  return out;
}

function validSession(v: unknown): SessionData | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !Array.isArray(v.pages)) return null;
  return v as unknown as SessionData;
}

export function loadSettings(raw: unknown): ScanStitchSettings {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  let templates = cleanTemplates(r.templates);
  if (templates.length === 0) templates = d.templates.map((t) => ({ ...t }));
  const wanted = str(r.defaultTemplate, d.defaultTemplate);
  const defaultTemplate = templates.some((t) => t.name === wanted) ? wanted : templates[0].name;
  return {
    watchRoot: str(r.watchRoot, d.watchRoot),
    includeSubfolders: typeof r.includeSubfolders === 'boolean' ? r.includeSubfolders : d.includeSubfolders,
    patterns: stringArray(r.patterns, d.patterns),
    stabilityDelayMs: nonNegNumber(r.stabilityDelayMs, d.stabilityDelayMs),
    stabilityRetries: nonNegInt(r.stabilityRetries, d.stabilityRetries),
    templates,
    defaultTemplate,
    recentLocations: stringArray(r.recentLocations, d.recentLocations).slice(0, MAX_RECENTS),
    session: validSession(r.session),
  };
}
