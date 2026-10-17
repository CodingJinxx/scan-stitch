import { nextCounter, resolveTemplate, sanitizeFileName } from '../core/template';

/** Pure decision logic for the review screen (no Obsidian imports). */

export type ReviewAction =
  | 'rotateCw'
  | 'rotateCcw'
  | 'prev'
  | 'next'
  | 'first'
  | 'last'
  | 'remove'
  | 'save'
  | 'cancel'
  | 'undo'
  | 'redo'
  | 'selectAll';

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
}

export function mapKey(e: KeyLike): ReviewAction | null {
  // Alt (and AltGr, which arrives as ctrl+alt on Windows) never maps to a review action.
  if (e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y') return 'redo';
    if (k === 'a') return 'selectAll';
    return null;
  }
  switch (k) {
    case 'r':
      return e.shiftKey || e.key === 'R' ? 'rotateCcw' : 'rotateCw';
    case 'ArrowLeft':
      return 'prev';
    case 'ArrowRight':
      return 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Delete':
    case 'Backspace':
      return 'remove';
    case 'Enter':
      return 'save';
    case 'Escape':
      return 'cancel';
    default:
      return null;
  }
}

/**
 * Current page and selection over an ordered list of page ids. Call `sync` with the
 * current order after every change to the page list; the cursor follows the current
 * page by id and clamps when it disappears.
 */
export class ReviewCursor {
  private ids: string[] = [];
  private cur = -1;
  private selected = new Set<string>();
  private anchor: string | null = null;

  get index(): number {
    return this.cur;
  }

  get currentId(): string | null {
    return this.cur >= 0 ? this.ids[this.cur] : null;
  }

  get count(): number {
    return this.ids.length;
  }

  sync(next: string[]): void {
    const prevIds = this.ids;
    const prevCur = this.cur;
    const currentId = this.currentId;
    this.ids = [...next];
    const present = new Set(this.ids);
    for (const id of [...this.selected]) if (!present.has(id)) this.selected.delete(id);
    if (this.anchor !== null && !present.has(this.anchor)) this.anchor = null;
    if (this.ids.length === 0) {
      this.cur = -1;
      return;
    }
    if (currentId !== null && present.has(currentId)) {
      this.cur = this.ids.indexOf(currentId);
      return;
    }
    if (prevCur < 0) {
      this.cur = 0;
      return;
    }
    // The current page is gone: land on the first surviving page that followed it,
    // which is the number of survivors before its old position.
    let before = 0;
    for (let i = 0; i < prevCur && i < prevIds.length; i++) if (present.has(prevIds[i])) before++;
    this.cur = Math.min(before, this.ids.length - 1);
  }

  go(i: number): void {
    if (this.ids.length === 0) return;
    this.cur = Math.max(0, Math.min(i, this.ids.length - 1));
    this.selected.clear();
    this.anchor = this.currentId;
  }

  prev(): void {
    this.go(this.cur - 1);
  }

  next(): void {
    this.go(this.cur + 1);
  }

  first(): void {
    this.go(0);
  }

  last(): void {
    this.go(this.ids.length - 1);
  }

  /** Plain click jumps to the page; shift+click selects the range from the anchor. */
  click(i: number, shift: boolean): void {
    if (this.ids.length === 0) return;
    const target = Math.max(0, Math.min(i, this.ids.length - 1));
    if (!shift) {
      this.go(target);
      return;
    }
    const anchorId = this.anchor ?? this.currentId;
    const from = anchorId === null ? target : this.ids.indexOf(anchorId);
    this.anchor = anchorId;
    this.cur = target;
    this.selected = new Set(this.ids.slice(Math.min(from, target), Math.max(from, target) + 1));
  }

  selectAll(): void {
    if (this.ids.length === 0) return;
    this.selected = new Set(this.ids);
  }

  isSelected(id: string): boolean {
    return this.selected.has(id);
  }

  /** Selected ids in page order. */
  selectedIds(): string[] {
    return this.ids.filter((id) => this.selected.has(id));
  }

  /** What an action applies to: the selection, else the current page. */
  targetIds(): string[] {
    const sel = this.selectedIds();
    if (sel.length > 0) return sel;
    const id = this.currentId;
    return id === null ? [] : [id];
  }
}

/**
 * Final index for `SessionState.move` when the page at `fromIndex` is dropped on the
 * page at `dropIndex`, before it or (`dropAfter`) after it.
 */
export function reorderTarget(fromIndex: number, dropIndex: number, dropAfter: boolean): number {
  const insertAt = dropIndex + (dropAfter ? 1 : 0);
  return insertAt > fromIndex ? insertAt - 1 : insertAt;
}

/** Signed shortest turn from one rotation to another (-90, 0, 90 or 180). */
export function rotationDelta(from: number, to: number): number {
  const d = (((to - from) % 360) + 360) % 360;
  return d === 270 ? -90 : d;
}

export function counterText(index: number, total: number, selected: number): string {
  if (total === 0 || index < 0) return 'No pages';
  const base = `Page ${index + 1} / ${total}`;
  return selected > 1 ? `${base} (${selected} selected)` : base;
}

export interface AutoNameOptions {
  now: Date;
  pages: number;
  folder: string;
  /** File names already in the destination folder (with or without .pdf). */
  existingNames: string[];
  format: (d: Date, fmt: string) => string;
}

const COUNTER_SENTINEL = 'COUNTER';

/** The template's file name with the real page count and the next free counter, sanitised. */
export function autoFilename(pattern: string, opts: AutoNameOptions): string {
  const ctx = { now: opts.now, pages: opts.pages, folder: opts.folder, format: opts.format };
  const probe = sanitizeFileName(resolveTemplate(pattern.replace(/\{counter\}/g, COUNTER_SENTINEL), { ...ctx, counter: 0 }))
    .split(COUNTER_SENTINEL)
    .join('{counter}');
  const counter = nextCounter(probe, opts.existingNames);
  return sanitizeFileName(resolveTemplate(pattern, { ...ctx, counter }));
}
