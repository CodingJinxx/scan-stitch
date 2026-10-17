import type { PageKind, PageRef, Rotation, SessionData } from '../types';

const UNDO_CAP = 200;

function clonePages(pages: PageRef[]): PageRef[] {
  return pages.map((p) => ({ ...p }));
}

export class SessionState {
  private d: SessionData;
  private undoStack: PageRef[][] = [];
  private redoStack: PageRef[][] = [];

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
    this.d.pages = this.d.pages.filter((p) => !set.has(p.id));
  }

  move(id: string, toIndex: number): void {
    const from = this.d.pages.findIndex((p) => p.id === id);
    if (from < 0) return;
    this.checkpoint();
    const pages = [...this.d.pages];
    const [item] = pages.splice(from, 1);
    const to = Math.max(0, Math.min(toIndex, pages.length));
    pages.splice(to, 0, item);
    this.d.pages = pages;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(clonePages(this.d.pages));
    this.d.pages = prev;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(clonePages(this.d.pages));
    this.d.pages = next;
    return true;
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

  private checkpoint(): void {
    this.undoStack.push(clonePages(this.d.pages));
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
  }
}
