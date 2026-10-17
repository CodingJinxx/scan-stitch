import type { PageKind, PageRef, Rotation, SessionData } from '../types';

const UNDO_CAP = 200;

function clonePages(pages: PageRef[]): PageRef[] {
  return pages.map((p) => ({ ...p }));
}

/** An undo step: the page list plus the discarded paths, which a review removal can extend. */
interface Snapshot {
  pages: PageRef[];
  discardedPaths: string[];
}

export class SessionState {
  private d: SessionData;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  constructor(data: SessionData) {
    this.d = {
      ...data,
      pages: clonePages(data.pages),
      discardedPaths: [...data.discardedPaths],
    };
  }

  get data(): SessionData {
    return this.d;
  }

  addFile(path: string, pageCount: number, kind: PageKind, seenAt: number): PageRef[] {
    if (this.d.discardedPaths.includes(path) || this.d.pages.some((p) => p.path === path)) {
      return [];
    }
    const added: PageRef[] = [];
    for (let i = 0; i < pageCount; i++) {
      added.push({ id: `${path}#${i}`, path, pageIndex: i, kind, rotation: 0, seenAt });
    }
    if (added.length === 0) return added;
    this.clearHistory();
    this.d.pages.push(...added);
    return added;
  }

  discardLastFile(): string | null {
    const last = this.d.pages[this.d.pages.length - 1];
    if (!last) return null;
    const path = last.path;
    this.clearHistory();
    this.d.pages = this.d.pages.filter((p) => p.path !== path);
    this.d.discardedPaths.push(path);
    return path;
  }

  rotate(ids: string[], dir: 1 | -1): void {
    const set = new Set(ids);
    if (!this.d.pages.some((p) => set.has(p.id))) return;
    this.checkpoint();
    this.d.pages = this.d.pages.map((p) =>
      set.has(p.id) ? { ...p, rotation: (((p.rotation + dir * 90) % 360) + 360) % 360 as Rotation } : p,
    );
  }

  remove(ids: string[]): void {
    const set = new Set(ids);
    if (!this.d.pages.some((p) => set.has(p.id))) return;
    this.checkpoint();
    const removed = this.d.pages.filter((p) => set.has(p.id));
    this.d.pages = this.d.pages.filter((p) => !set.has(p.id));
    // A file with no pages left counts as discarded, so the watcher does not add it
    // again when the session goes back to scanning (undo restores it).
    for (const path of new Set(removed.map((p) => p.path))) {
      if (!this.d.pages.some((p) => p.path === path) && !this.d.discardedPaths.includes(path)) {
        this.d.discardedPaths.push(path);
      }
    }
  }

  move(id: string, toIndex: number): void {
    const from = this.d.pages.findIndex((p) => p.id === id);
    if (from < 0) return;
    const pages = [...this.d.pages];
    const [item] = pages.splice(from, 1);
    const to = Math.max(0, Math.min(toIndex, pages.length));
    if (to === from) return;
    this.checkpoint();
    pages.splice(to, 0, item);
    this.d.pages = pages;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    return true;
  }

  /** True when a review edit (rotate, remove, move) can be undone. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  countFiles(): number {
    return new Set(this.d.pages.map((p) => p.path)).size;
  }

  toJSON(): SessionData {
    return {
      ...this.d,
      pages: clonePages(this.d.pages),
      discardedPaths: [...this.d.discardedPaths],
    };
  }

  private clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private snapshot(): Snapshot {
    return { pages: clonePages(this.d.pages), discardedPaths: [...this.d.discardedPaths] };
  }

  private restore(s: Snapshot): void {
    this.d.pages = s.pages;
    this.d.discardedPaths = s.discardedPaths;
  }

  private checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
  }
}
