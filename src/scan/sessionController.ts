import * as fs from 'fs';
import * as path from 'path';
import { SessionState } from '../core/sessionState';
import { kindOf } from '../core/patterns';
import { createFolderWatcher, type FolderWatcher, type WatcherOptions } from './folderWatcher';
import type { PageKind, PageRef, Rotation, ScanStitchSettings, SessionData } from '../types';

export interface ControllerDeps {
  settings: () => ScanStitchSettings;
  persist: (session: SessionData | null) => Promise<void>;
  countPdfPages: (path: string) => Promise<number>;
  notify: (msg: string) => void;
  now?: () => number;
  createWatcher?: (opts: WatcherOptions) => FolderWatcher;
}

export interface StartInit {
  destinationFolder: string;
  templateName: string;
  filename: string;
  appendTarget: string | null;
}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

export class SessionController {
  private session: SessionState | null = null;
  private watcher: FolderWatcher | null = null;
  private listeners = new Set<() => void>();
  private bad = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();
  private fileChain: Promise<void> = Promise.resolve();
  private generation = 0;
  private revalidateOnRestore = false;
  private swallowRootMissing = false;

  constructor(private deps: ControllerDeps) {}

  get state(): SessionState | null {
    return this.session;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  start(init: StartInit): void {
    if (this.session) throw new Error('A scan session already exists');
    const s = this.deps.settings();
    const startedAt = this.now();
    this.reset();
    this.session = new SessionState({
      id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt,
      watchRoot: s.watchRoot,
      destinationFolder: init.destinationFolder,
      templateName: init.templateName,
      filename: init.filename,
      appendTarget: init.appendTarget,
      pages: [],
      discardedPaths: [],
      phase: 'scanning',
    });
    this.startWatcher();
    this.changed();
  }

  async resume(data: SessionData): Promise<void> {
    if (this.session) throw new Error('A scan session already exists');
    const clean = this.sanitize(data);
    if (!clean) {
      this.notify('Stored scan session was unreadable and was discarded');
      await this.persistNow(null);
      return;
    }
    this.reset();
    this.revalidateOnRestore = false;
    this.swallowRootMissing = false;
    let pages = clean.pages;
    const root = clean.watchRoot || this.deps.settings().watchRoot;
    if (!this.rootAccessible(root)) {
      // unplugged drive or similar: keep everything, check again when the folder returns
      this.revalidateOnRestore = true;
      this.swallowRootMissing = true;
      this.notify('Scanner folder is unavailable');
    } else {
      pages = this.dropMissing(pages);
    }
    this.session = new SessionState({ ...clean, pages });
    const gen = this.generation;
    if (clean.phase === 'review') {
      this.changed();
      return;
    }
    const w = this.startWatcher();
    try {
      await w.rescan();
      await this.fileChain;
    } catch {
      // the watcher keeps polling; nothing to do
    }
    if (gen !== this.generation || !this.session) return;
    this.changed();
  }

  endScanning(): void {
    const s = this.session;
    if (!s || s.data.phase !== 'scanning') return;
    s.data.phase = 'review';
    this.stopWatcher();
    this.changed();
  }

  backToScanning(): void {
    const s = this.session;
    if (!s || s.data.phase !== 'review') return;
    s.data.phase = 'scanning';
    this.startWatcher();
    this.changed();
  }

  discardLast(): void {
    if (!this.session) return;
    if (this.session.discardLastFile() === null) return;
    this.changed();
  }

  /** Persist and announce edits made directly on `state` (rotate, remove, move, undo, redo). */
  commit(): void {
    if (!this.session) return;
    this.changed();
  }

  async finish(): Promise<void> {
    this.stopWatcher();
    this.generation++;
    this.session = null;
    this.bad.clear();
    this.emit();
    await this.persistNow(null);
  }

  // ---- internals ----

  private rootAccessible(root: string): boolean {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  }

  private dropMissing(pages: PageRef[]): PageRef[] {
    const exists = new Map<string, boolean>();
    let missing = 0;
    const kept = pages.filter((p) => {
      let ok = exists.get(p.path);
      if (ok === undefined) {
        ok = fs.existsSync(p.path);
        exists.set(p.path, ok);
        if (!ok) missing++;
      }
      return ok;
    });
    if (missing > 0) {
      this.notify(`${missing} scanned file${missing === 1 ? ' is' : 's are'} no longer available and ${missing === 1 ? 'was' : 'were'} skipped`);
    }
    return kept;
  }

  private revalidate(): void {
    try {
      if (!this.revalidateOnRestore || !this.session) return;
      this.revalidateOnRestore = false;
      const before = this.session.data.pages;
      const kept = this.dropMissing(before);
      if (kept.length !== before.length) {
        this.session = new SessionState({ ...this.session.toJSON(), pages: kept });
        this.changed();
      }
    } catch {
      // never throw into the watcher
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private notify(msg: string): void {
    try {
      this.deps.notify(msg);
    } catch {
      // never throw into callers
    }
  }

  private reset(): void {
    this.generation++;
    this.bad.clear();
    this.fileChain = Promise.resolve();
  }

  private startWatcher(): FolderWatcher {
    this.stopWatcher();
    const s = this.session as SessionState;
    const settings = this.deps.settings();
    const gen = this.generation;
    const opts: WatcherOptions = {
      root: s.data.watchRoot || settings.watchRoot,
      recursive: settings.includeSubfolders,
      patterns: settings.patterns,
      since: s.data.startedAt,
      stabilityDelayMs: settings.stabilityDelayMs,
      stabilityRetries: settings.stabilityRetries,
      ignore: (p) => {
        try {
          const cur = this.session;
          return this.bad.has(p) || !cur || cur.data.discardedPaths.includes(p) || cur.data.pages.some((x) => x.path === p);
        } catch {
          return true;
        }
      },
      onFile: (e) => {
        this.fileChain = this.fileChain.then(() => this.handleFile(e.path, e.seenAt, gen)).catch(() => {});
      },
      onProblem: (e) => {
        const name = e.path ? path.basename(e.path) : '';
        if (e.reason === 'unreadable') this.notify(`Cannot read ${name || 'a scanned file'}`);
        else if (e.reason === 'root-missing') {
          if (this.swallowRootMissing) this.swallowRootMissing = false;
          else this.notify('Scanner folder is unavailable');
        } else if (e.reason === 'root-restored') {
          this.notify('Scanner folder is back');
          this.revalidate();
        }
      },
    };
    const create = this.deps.createWatcher ?? createFolderWatcher;
    const w = create(opts);
    this.watcher = w;
    w.start();
    return w;
  }

  private stopWatcher(): void {
    const w = this.watcher;
    this.watcher = null;
    if (w) {
      try {
        w.stop();
      } catch {
        // ignore
      }
    }
  }

  private async handleFile(file: string, seenAt: number, gen: number): Promise<void> {
    try {
      const live = (): SessionState | null =>
        gen === this.generation && this.session && this.session.data.phase === 'scanning' ? this.session : null;
      if (!live() || this.bad.has(file)) return;
      const name = path.basename(file);
      const kind = kindOf(name);
      if (!kind) return;
      let count = 1;
      if (kind === 'pdf') {
        try {
          count = await this.deps.countPdfPages(file);
        } catch {
          this.bad.add(file);
          this.notify(`Skipped ${name}: could not read PDF`);
          return;
        }
        if (!Number.isInteger(count) || count < 1) {
          this.bad.add(file);
          this.notify(`Skipped ${name}: no pages found`);
          return;
        }
      }
      const s = live();
      if (!s) return;
      if (s.addFile(file, count, kind, seenAt).length > 0) this.changed();
    } catch {
      // never throw into the watcher
    }
  }

  private sanitize(data: unknown): SessionData | null {
    if (typeof data !== 'object' || data === null) return null;
    const d = data as Record<string, unknown>;
    const startedAt = typeof d.startedAt === 'number' && Number.isFinite(d.startedAt) ? d.startedAt : this.now();
    const pages: PageRef[] = [];
    if (Array.isArray(d.pages)) {
      d.pages.forEach((raw: unknown) => {
        if (typeof raw !== 'object' || raw === null) return;
        const r = raw as Record<string, unknown>;
        if (typeof r.path !== 'string' || r.path === '') return;
        const kind: PageKind = r.kind === 'image' || r.kind === 'pdf' ? r.kind : (kindOf(path.basename(r.path)) ?? 'pdf');
        const pageIndex = typeof r.pageIndex === 'number' && r.pageIndex >= 0 ? r.pageIndex : 0;
        pages.push({
          id: typeof r.id === 'string' ? r.id : `${r.path}#${pageIndex}`,
          path: r.path,
          pageIndex,
          kind,
          rotation: ROTATIONS.includes(r.rotation as Rotation) ? (r.rotation as Rotation) : 0,
          seenAt: typeof r.seenAt === 'number' ? r.seenAt : startedAt,
        });
      });
    }
    return {
      id: str(d.id, `${startedAt.toString(36)}`),
      startedAt,
      watchRoot: str(d.watchRoot, ''),
      destinationFolder: str(d.destinationFolder, ''),
      templateName: str(d.templateName, ''),
      filename: str(d.filename, ''),
      appendTarget: typeof d.appendTarget === 'string' ? d.appendTarget : null,
      pages,
      discardedPaths: Array.isArray(d.discardedPaths) ? d.discardedPaths.filter((x): x is string => typeof x === 'string') : [],
      phase: d.phase === 'review' ? 'review' : 'scanning',
    };
  }

  private changed(): void {
    this.emit();
    void this.persistNow(this.session ? this.session.toJSON() : null);
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // a listener must not break the controller
      }
    }
  }

  /** Serialised: writes never overlap and complete in call order, so the last state wins. */
  private persistNow(snapshot: SessionData | null): Promise<void> {
    const run = this.persistChain.then(async () => {
      try {
        await this.deps.persist(snapshot);
      } catch {
        this.notify('Could not save the scan session');
      }
    });
    this.persistChain = run;
    return run;
  }
}
