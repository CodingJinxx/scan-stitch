export interface TemplateContext {
  now: Date;
  pages: number | null;
  counter: number;
  folder: string;
  format: (d: Date, fmt: string) => string;
}

const PLACEHOLDER = /\{(\w+)(?::([^}]+))?\}/g;

const DATE_DEFAULTS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH-mm',
  year: 'YYYY',
  month: 'MM',
  day: 'DD',
};
const OTHER_NAMES = ['pages', 'counter', 'folder'];

export function resolveTemplate(pattern: string, ctx: TemplateContext): string {
  return pattern.replace(PLACEHOLDER, (match, name: string, fmt?: string) => {
    if (name in DATE_DEFAULTS) {
      return ctx.format(ctx.now, fmt ?? DATE_DEFAULTS[name]);
    }
    if (name === 'pages') return ctx.pages === null ? '?' : String(ctx.pages);
    if (name === 'counter') return String(ctx.counter);
    if (name === 'folder') return ctx.folder;
    return match;
  });
}

export function findUnknownPlaceholders(pattern: string): string[] {
  const unknown: string[] = [];
  for (const m of pattern.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (!(name in DATE_DEFAULTS) && !OTHER_NAMES.includes(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFileName(name: string): string {
  let out = name
    // eslint-disable-next-line no-control-regex -- strip control characters on purpose
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (RESERVED.test(out)) out = `_${out}`;
  return out === '' ? 'Scan' : out;
}

export function uniqueName(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  let n = 2;
  while (exists(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function nextCounter(base: string, existing: string[]): number {
  const escaped = base
    .split('{counter}')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(\\d+)');
  const re = new RegExp(`^${escaped}(?:\\.pdf)?$`, 'i');
  const used = new Set<number>();
  for (const name of existing) {
    const m = re.exec(name);
    if (m && m[1] !== undefined) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
