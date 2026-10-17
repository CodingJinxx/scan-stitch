import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout, setInterval as nodeSetInterval, clearInterval as nodeClearInterval } from 'timers';
import { matchesAnyPattern } from '../core/patterns';

export interface WatcherOptions {
  root: string;
  recursive: boolean;
  patterns: string[];
  since: number;
  stabilityDelayMs: number;
  stabilityRetries: number;
  pollIntervalMs?: number;
  ignore: (path: string) => boolean;
  onFile: (e: { path: string; seenAt: number }) => void;
  onProblem: (e: { path?: string; reason: 'unreadable' | 'root-missing' | 'root-restored' }) => void;
}

export interface FolderWatcher {
  start(): void;
  stop(): void;
  rescan(): Promise<void>;
}

const DEFAULT_POLL_MS = 3000;

/**
 * Watches a scanner folder (read only: nothing is ever written, renamed or
 * deleted there). Uses fs.watch when it works plus a periodic rescan as the
 * polling fallback.
 */
export function createFolderWatcher(opts: WatcherOptions): FolderWatcher {
  const emitted = new Set<string>();
  const inFlight = new Set<string>();
  // paths we reported as unreadable, with the size seen when giving up
  const gaveUp = new Map<string, number>();
  const sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  let running = false;
  let rootOk = true;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = {
        timer: nodeSetTimeout(() => {
          sleepers.delete(entry);
          resolve();
        }, ms),
        resolve,
      };
      sleepers.add(entry);
    });
  }

  function rootAccessible(): boolean {
    try {
      return fs.statSync(opts.root).isDirectory();
    } catch {
      return false;
    }
  }

  function closeFsWatcher(): void {
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        // ignore
      }
      fsWatcher = null;
    }
  }

  function openFsWatcher(): void {
    if (fsWatcher || !running) return;
    try {
      const w = fs.watch(opts.root, { recursive: opts.recursive }, () => {
        void rescan();
      });
      w.on('error', () => {
        if (fsWatcher === w) closeFsWatcher();
      });
      fsWatcher = w;
    } catch {
      fsWatcher = null; // polling still covers us
    }
  }

  function walk(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (opts.recursive) walk(full, out);
      } else if (e.isFile() && matchesAnyPattern(e.name, opts.patterns)) {
        out.push(full);
      }
    }
  }

  /** True once the size is non-zero and stable; false if it gave up (problem reported where relevant). */
  async function waitStable(file: string): Promise<boolean> {
    const retries = Math.max(1, opts.stabilityRetries);
    const maxChecks = Math.max(retries * 20, 100);
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < maxChecks; i++) {
      await sleep(opts.stabilityDelayMs);
      if (!running) return false;
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // vanished
        gaveUp.set(file, -1);
        opts.onProblem({ path: file, reason: 'unreadable' });
        return false;
      }
      if (size === prev) stable++;
      else {
        stable = 0;
        prev = size;
      }
      if (stable >= retries) {
        if (size === 0) {
          gaveUp.set(file, 0);
          opts.onProblem({ path: file, reason: 'unreadable' });
          return false;
        }
        return true;
      }
    }
    gaveUp.set(file, prev);
    opts.onProblem({ path: file, reason: 'unreadable' });
    return false;
  }

  async function process(file: string): Promise<void> {
    inFlight.add(file);
    try {
      if (await waitStable(file)) {
        if (running && !emitted.has(file)) {
          emitted.add(file);
          gaveUp.delete(file);
          opts.onFile({ path: file, seenAt: Date.now() });
        }
      }
    } finally {
      inFlight.delete(file);
    }
  }

  async function rescan(): Promise<void> {
    if (!running) return;
    const ok = rootAccessible();
    if (!ok) {
      if (rootOk) {
        rootOk = false;
        closeFsWatcher();
        opts.onProblem({ reason: 'root-missing' });
      }
      return;
    }
    if (!rootOk) {
      rootOk = true;
      opts.onProblem({ reason: 'root-restored' });
    }
    openFsWatcher();

    const found: string[] = [];
    walk(opts.root, found);
    const work: Array<Promise<void>> = [];
    for (const file of found) {
      if (emitted.has(file) || inFlight.has(file)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (Math.max(st.birthtimeMs, st.mtimeMs) < opts.since) continue;
      if (opts.ignore(file)) continue;
      const gave = gaveUp.get(file);
      if (gave !== undefined) {
        if (gave === st.size) continue;
        gaveUp.delete(file);
      }
      work.push(process(file));
    }
    await Promise.all(work);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      rootOk = rootAccessible();
      if (!rootOk) opts.onProblem({ reason: 'root-missing' });
      else openFsWatcher();
      pollTimer = nodeSetInterval(() => {
        void rescan();
      }, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
      void rescan();
    },
    stop(): void {
      running = false;
      closeFsWatcher();
      if (pollTimer) {
        nodeClearInterval(pollTimer);
        pollTimer = null;
      }
      for (const s of sleepers) {
        nodeClearTimeout(s.timer);
        s.resolve();
      }
      sleepers.clear();
    },
    rescan,
  };
}
