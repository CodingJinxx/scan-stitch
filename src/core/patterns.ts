import type { PageKind } from '../types';

const BACKSLASH = String.fromCharCode(92);
const SPECIAL = BACKSLASH + '^$.|+()[]{}';

function globToRegExp(glob: string): RegExp {
  let body = '';
  for (const c of glob) {
    if (c === '*') body += '.*';
    else if (c === '?') body += '.';
    else if (SPECIAL.includes(c)) body += BACKSLASH + c;
    else body += c;
  }
  return new RegExp('^' + body + '$', 'i');
}

function isTemp(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.startsWith('.') || lower.startsWith('~$') || lower.endsWith('.tmp');
}

export function matchesAnyPattern(fileName: string, patterns: string[]): boolean {
  if (isTemp(fileName)) return false;
  return patterns.some((p) => globToRegExp(p).test(fileName));
}

export function kindOf(fileName: string): PageKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (/\.(jpe?g|png)$/.test(lower)) return 'image';
  return null;
}
