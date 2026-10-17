# Scan Stitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Scan Stitch Obsidian plugin (scan session, live side pane, keyboard-first review, merged PDF save, append mode, templates) together with a polished public repo (logo, screenshots, demo GIF, README, GitHub Pages).

**Architecture:** Pure, Obsidian-free core modules (`src/core`, `src/scan`, `src/pdf/merge.ts`) are built test-first with vitest. Thin Obsidian-bound UI (`src/ui`, `src/main.ts`) sits on top and is verified by running it in a demo vault against a fake scanner folder. Session state is one serialisable object persisted to plugin data on every change.

**Tech Stack:** TypeScript, esbuild (official sample-plugin setup), vitest, eslint + `eslint-plugin-obsidianmd`, pdf-lib (only bundled runtime dependency), pdf.js via `loadPdfJs` from `obsidian`, moment (provided by `obsidian`, dev dependency for tests), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-17-scan-stitch-design.md` (read it first; section numbers below refer to it).

**Repo:** `C:\Dev\ObsidianPDFScannerPlugin\scan-stitch` (clone of `git@github.com:CodingJinxx/scan-stitch.git`, branch `main`, already holds `LICENSE` (MIT, Jay Leimer) and a stub `README.md`). Package manager: npm.

## Global Constraints

- `manifest.json`: `"id": "scan-stitch"`, `"name": "Scan Stitch"`, `"isDesktopOnly": true`, `"author": "Jay Leimer"`, `"authorUrl": "https://github.com/CodingJinxx"`, `minAppVersion` `"1.5.0"` (my call; raise if an API used needs more). Description under 250 characters, ends with a period.
- Id must not contain "obsidian"; name must not end in "plugin". MIT licence stays.
- No network calls, no telemetry, no `innerHTML`/`outerHTML` with dynamic content (use `createEl`/`setText`). All watchers, timers, DOM listeners released on unload (`registerEvent`, `registerInterval`, `registerDomEvent`).
- UI strings in sentence case; command names without the plugin name prefix; **no default hotkeys on commands**.
- Styling only through Obsidian CSS variables in `styles.css`, working in light and dark themes, prefix every class `scan-stitch-`.
- The scanner folder is read only. Nothing in it is ever written, moved or deleted (spec 2, anti-goals).
- Never overwrite an existing vault file silently; name collisions get ` 2`, ` 3`.
- Page order = time the plugin saw each file finish writing, tie-break by full path. Page identity = full path plus page index. Never order or identify by file name alone (spec 3, 4.3).
- Defaults: stability delay 1000 ms, 3 retries, file pattern `*.pdf` (images `*.jpg`, `*.jpeg`, `*.png` optional), include subfolders on, 5 recent locations, `{date}` = `YYYY-MM-DD`, `{time}` = `HH-mm`.
- Windows is the only fully tested platform; macOS/Linux best effort (polling fallback, `path` module for all path handling).
- No TIFF input. No auto-rotation. No mobile.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Creating/pushing remote state beyond the author's already-created repo (pushing branches, enabling Pages, publishing a release, the store PR) needs the author's go-ahead at that moment.

## Review Focus

Each line is pinned by a test in the task named in brackets.

1. Same file names in different day folders (`2026_06_29\IMG_0001.pdf` and `2026_10_13\IMG_0001.pdf`) must stay two distinct pages in the right order. [Task 4, Task 6]
2. Corrupt, zero-byte or locked scanner file: skipped with a notice, never crashes the session, never blocks later pages. [Task 6, Task 8]
3. Watch root missing or unplugged (network drive) at start or mid-session: clear notice, session and pages kept, watcher recovers when the path returns. [Task 6]
4. Ending a session with zero pages (everything discarded): no empty PDF is written; Save is disabled and the user is offered to cancel. [Task 4, Task 12]
5. Append target that is encrypted, corrupt or missing: refused with a message, original file byte-identical afterwards; and a template result with illegal characters or a reserved Windows name (`CON`) is sanitised. [Task 8, Task 2]

---

## File structure

```
manifest.json  package.json  tsconfig.json  esbuild.config.mjs  vitest.config.ts
versions.json  version-bump.mjs  eslint.config.mjs  styles.css  .gitignore
src/main.ts                      plugin lifecycle, commands, ribbon, view registration
src/types.ts                     shared types (below)
src/core/template.ts             placeholder engine, sanitising, unique names
src/core/patterns.ts             file-pattern matching
src/core/sessionState.ts         pure session model + undo/redo
src/core/recents.ts              recent-locations list
src/core/settings.ts             defaults + loadSettings migration
src/scan/folderWatcher.ts        recursive watch, stability, polling fallback
src/scan/sessionController.ts    watcher + state + persistence + resume
src/pdf/merge.ts                 pdf-lib merge, image embedding, append verify
src/pdf/safeReplace.ts           append replace with backup copy
src/pdf/pageRenderer.ts          pdf.js / image rendering, thumbnail cache
src/ui/StartDialog.ts  ScanPaneView.ts  ReviewView.ts  SettingsTab.ts  FolderSuggest.ts
tests/**                         vitest, mirrors src
scripts/make-demo-scans.mjs      synthetic sample pages + fake scanner tree
assets/  docs/site/  .github/    logo, screenshots, GIF, Pages site, workflows
```

### Shared types (`src/types.ts`, created in Task 2, used by all later tasks)

```ts
export type Rotation = 0 | 90 | 180 | 270;
export type PageKind = 'pdf' | 'image';
export interface PageRef { id: string; path: string; pageIndex: number; kind: PageKind; rotation: Rotation; seenAt: number; }
export interface SessionData {
  id: string; startedAt: number; watchRoot: string; destinationFolder: string;
  templateName: string; filename: string; appendTarget: string | null;
  pages: PageRef[]; discardedPaths: string[]; phase: 'scanning' | 'review';
}
export interface Template { name: string; pattern: string; folder?: string; }
export interface ScanStitchSettings {
  watchRoot: string; includeSubfolders: boolean; patterns: string[];
  stabilityDelayMs: number; stabilityRetries: number;
  templates: Template[]; defaultTemplate: string; recentLocations: string[];
  session: SessionData | null;
}
```

---

### Task 1: Scaffold, tooling, CI

**Files:**
- Create: all root config files listed above, `src/main.ts` (empty `Plugin` subclass), `tests/smoke.test.ts`, `.github/workflows/ci.yml`
- Modify: `README.md` (leave stub), `.gitignore` (node_modules, `main.js`, `.superpowers/`, `data.json`)
- Commit existing: `docs/superpowers/specs/*`, this plan

**Interfaces:** Produces: npm scripts `build`, `dev`, `test`, `lint`, `typecheck`; `ci.yml` runs `npm ci && npm run lint && npm run typecheck && npm test && npm run build` on push/PR.

- [ ] **Step 1: Write the failing smoke test** `tests/smoke.test.ts`: `import { DEFAULT_SETTINGS } from '../src/core/settings'`; `expect(DEFAULT_SETTINGS.stabilityDelayMs).toBe(1000)` (fails: module missing).
- [ ] **Step 2: Run `npx vitest run`.** Expected: FAIL, cannot resolve `../src/core/settings`.
- [ ] **Step 3: Scaffold** from the official sample plugin layout (esbuild bundling `src/main.ts` to `main.js`, externals `obsidian`/`electron`/builtins, `tsconfig` strict). Install dev deps `typescript esbuild vitest eslint eslint-plugin-obsidianmd moment @types/node obsidian`, runtime dep `pdf-lib`. Create `src/core/settings.ts` exporting `DEFAULT_SETTINGS: ScanStitchSettings` with the Global Constraints defaults and one default template `{ name: 'Scan', pattern: 'Scan {date} {time}' }`; create `src/types.ts` exactly as above.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run typecheck && npm run build`. Expected: all exit 0 and `main.js` exists.
- [ ] **Step 5: Commit** `chore: scaffold plugin tooling and CI` (include spec and plan).

### Task 2: Template engine

**Files:** Create `src/core/template.ts`; Test `tests/core/template.test.ts`

**Interfaces:** Produces:
```ts
export interface TemplateContext { now: Date; pages: number | null; counter: number; folder: string; format: (d: Date, fmt: string) => string; }
export function resolveTemplate(pattern: string, ctx: TemplateContext): string;
export function findUnknownPlaceholders(pattern: string): string[];
export function sanitizeFileName(name: string): string;
export function uniqueName(base: string, exists: (candidate: string) => boolean): string;
export function nextCounter(base: string, existing: string[]): number;
```

- [ ] **Step 1: Write failing tests** (use `moment` for `format`): `{date}`→`2026-10-17`; `{time}`→`14-05`; `{date:DD.MM.YYYY}`→`17.10.2026`; `{year}{month}{day}`; `{folder}` and `{pages}` (null renders as `?`); `{counter}` uses ctx.counter; unknown `{foo}` stays literal and `findUnknownPlaceholders('A {foo} {date}')` returns `['foo']`; `sanitizeFileName('a/b:c*?"<>|')` has none of those characters; `sanitizeFileName('CON')` and `'nul.pdf'` get a safe prefix/suffix; trailing dots/spaces stripped; result never empty (falls back to `Scan`); `uniqueName('Scan', n => ['Scan','Scan 2'].includes(n))` → `Scan 3`; `nextCounter('Scan {counter}'...)` returns next unused integer.
- [ ] **Step 2: Run** `npx vitest run tests/core/template.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above in `src/core/template.ts` (regex over `\{(\w+)(?::([^}]+))?\}`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: filename template engine`.

### Task 3: File-pattern matching

**Files:** Create `src/core/patterns.ts`; Test `tests/core/patterns.test.ts`

**Interfaces:** Produces `export function matchesAnyPattern(fileName: string, patterns: string[]): boolean`; `export function kindOf(fileName: string): PageKind | null`.

- [ ] **Step 1: Tests:** `matchesAnyPattern('IMG_0001.PDF', ['*.pdf'])` true (case-insensitive); `'a.jpg'` false for `['*.pdf']`, true for `['*.jpg','*.jpeg']`; `'~$tmp.pdf'`, `'.hidden.pdf'` and `'IMG_0001.pdf.tmp'` false; `kindOf('x.png')` → `'image'`, `kindOf('x.pdf')` → `'pdf'`, `kindOf('x.tif')` → `null`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** glob (`*`, `?`) to anchored case-insensitive regex.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: scan file pattern matching`.

### Task 4: Session state with undo/redo

**Files:** Create `src/core/sessionState.ts`; Test `tests/core/sessionState.test.ts`

**Interfaces:** Produces:
```ts
export class SessionState {
  constructor(data: SessionData);
  get data(): SessionData;
  addFile(path: string, pageCount: number, kind: PageKind, seenAt: number): PageRef[]; // ignores discarded/duplicate paths
  discardLastFile(): string | null;                // removes last file's pages, remembers path in discardedPaths
  rotate(ids: string[], dir: 1 | -1): void;        // undoable
  remove(ids: string[]): void;                     // undoable
  move(id: string, toIndex: number): void;         // undoable
  undo(): boolean; redo(): boolean;
  countFiles(): number;                            // distinct paths
  toJSON(): SessionData;
}
```
Review-phase mutations (`rotate/remove/move`) are undoable; `addFile/discardLastFile` are not.

- [ ] **Step 1: Tests:** adding `C:\Scans\2026_06_29\IMG_0001.pdf` then `C:\Scans\2026_10_13\IMG_0001.pdf` gives two distinct pages in arrival order (Review Focus 1); same path added twice is ignored; a 3-page file yields ids `path#0..2` and counts as one file; `discardLastFile()` removes it, returns the path, and a later `addFile` of that same path is ignored while a new path is accepted; repeated discards work down to zero pages and return `null` when empty; `rotate(['x'], 1)` ×4 returns to 0 and `-1` from 0 gives 270; rotate range of ids rotates all; `remove` then `undo()` restores position; `move` then `undo`/`redo`; a new mutation after `undo` clears redo; `toJSON()` round-trips through `new SessionState(JSON.parse(JSON.stringify(...)))`; zero pages after removing all (Review Focus 4: `data.pages.length === 0`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with a snapshot stack of `pages` arrays for undo (cap 200).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: session state with undo and redo`.

### Task 5: Recents and settings loading

**Files:** Create `src/core/recents.ts`; Modify `src/core/settings.ts`; Test `tests/core/recents.test.ts`, `tests/core/settings.test.ts`

**Interfaces:** Produces `pushRecent(list: string[], folder: string, max?: number): string[]` (dedupes case-insensitively, newest first, default max 5); `loadSettings(raw: unknown): ScanStitchSettings` (fills missing fields from defaults, drops invalid template entries, ensures `defaultTemplate` exists).

- [ ] **Step 1: Tests:** push moves existing entry to front without duplicating; cap at 5; `loadSettings(undefined)` equals defaults; partial raw keeps user values and fills the rest; template with empty name dropped; missing default template falls back to first template.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: recent locations and settings migration`.

### Task 6: Folder watcher

**Files:** Create `src/scan/folderWatcher.ts`; Test `tests/scan/folderWatcher.test.ts` (use a real temp directory under `os.tmpdir()`)

**Interfaces:** Produces:
```ts
export interface WatcherOptions {
  root: string; recursive: boolean; patterns: string[]; since: number;
  stabilityDelayMs: number; stabilityRetries: number; pollIntervalMs?: number;
  ignore: (path: string) => boolean;
  onFile: (e: { path: string; seenAt: number }) => void;
  onProblem: (e: { path?: string; reason: 'unreadable' | 'root-missing' | 'root-restored' }) => void;
}
export interface FolderWatcher { start(): void; stop(): void; rescan(): Promise<void>; }
export function createFolderWatcher(opts: WatcherOptions): FolderWatcher;
```
A file counts when its birth/mtime ≥ `since`, it matches the patterns, `ignore` is false, and its size is unchanged and non-zero across `stabilityRetries` checks spaced `stabilityDelayMs`. `rescan()` walks the tree once (used on start for the cutoff rule and on resume). Uses `fs.watch(root,{recursive})` when available plus a periodic `rescan` (default every 3000 ms) as the polling fallback. Emits each path once.

- [ ] **Step 1: Tests (small delays, e.g. 20 ms):** a file written after `start()` fires once; a file older than `since` never fires; a file still growing fires only after it stops; zero-byte file never fires and reports `unreadable` (Review Focus 2); a file matching `ignore` never fires; non-matching extension ignored; a new subfolder created after start with `IMG_0001.pdf` fires (recursive); the same relative name in two day folders fires twice with distinct paths (Review Focus 1); removing the root reports `root-missing`, recreating it reports `root-restored` and later files fire (Review Focus 3); `stop()` ends events and timers.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS** (run 3 times to catch flakiness).
- [ ] **Step 5: Commit** `feat: recursive folder watcher with stability checks`.

### Task 7: Session controller

**Files:** Create `src/scan/sessionController.ts`; Test `tests/scan/sessionController.test.ts`

**Interfaces:** Consumes Tasks 4–6. Produces:
```ts
export interface ControllerDeps {
  settings: () => ScanStitchSettings;
  persist: (session: SessionData | null) => Promise<void>;
  countPdfPages: (path: string) => Promise<number>;   // injected; real impl in main.ts via pdf-lib; throws on corrupt
  notify: (msg: string) => void;
  now?: () => number;
}
export class SessionController {
  constructor(deps: ControllerDeps);
  readonly state: SessionState | null;
  start(init: { destinationFolder: string; templateName: string; filename: string; appendTarget: string | null }): void;
  resume(data: SessionData): Promise<void>;   // missing files skipped with a notice; picks up files with time ≥ startedAt
  endScanning(): void;                         // phase → 'review', watcher stopped
  backToScanning(): void;
  discardLast(): void;
  finish(): Promise<void>;                     // clears session, persists null
  onChange(cb: () => void): () => void;
}
```
Images count as 1 page; a PDF whose `countPdfPages` throws is skipped with a notice and stays ignored (Review Focus 2). Every state change calls `persist`.

- [ ] **Step 1: Tests (fake watcher via injected factory, in-memory persist):** `start()` creates `phase: 'scanning'`, persists; arriving file adds pages in order; corrupt PDF → notice, no page, later file still added; `discardLast()` lowers count; `endScanning()` sets phase review and stops the watcher; `resume()` with a missing path skips it and notifies; `resume()` rescans and adds files newer than `startedAt`; `finish()` persists `null`; `start()` while a session exists throws.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** (watcher factory is an optional dep defaulting to `createFolderWatcher`). **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: scan session controller with persistence and resume`.

### Task 8: PDF merge, images, append, safe replace

**Files:** Create `src/pdf/merge.ts`, `src/pdf/safeReplace.ts`; Test `tests/pdf/merge.test.ts`, `tests/pdf/safeReplace.test.ts`; fixtures built in-test with pdf-lib and a tiny JPEG/PNG buffer in `tests/fixtures/`

**Interfaces:** Produces:
```ts
export interface MergeSource { bytes: Uint8Array; kind: PageKind; pageIndex: number; rotation: Rotation; }
export interface MergeResult { bytes: Uint8Array; pageCount: number; }
export class AppendTargetError extends Error {}   // encrypted / corrupt / unreadable
export function mergePages(sources: MergeSource[], appendTo?: Uint8Array): Promise<MergeResult>;
// safeReplace
export interface ReplaceIO { read(): Promise<Uint8Array>; write(bytes: Uint8Array): Promise<void>; saveBackup(bytes: Uint8Array): Promise<void>; removeBackup(): Promise<void>; }
export function replaceWithVerify(io: ReplaceIO, build: (existing: Uint8Array) => Promise<MergeResult>, expectedPages: number): Promise<void>;
```
Rotation: final `/Rotate` = (existing page rotation + `rotation`) mod 360. Image pages: apply EXIF orientation first; page size = pixels × 72 / DPI (DPI from file, else 150); PNG alpha flattened onto white. Append keeps existing pages first, untouched.

- [ ] **Step 1: Tests:** merging three single-page PDFs gives `pageCount` 3 in order; rotation 90 on a page with existing `/Rotate` 90 yields 180; a multi-page source honours `pageIndex`; a JPEG page becomes one page with size from DPI (150 DPI, 1500×1000 px → 720×480 pt) and EXIF orientation 6 swaps dimensions; PNG with alpha embeds without throwing; `appendTo` result has existing pages first (count = old + new) and the first old page's content is unchanged; encrypted or garbage `appendTo` throws `AppendTargetError` (Review Focus 5); `replaceWithVerify` writes only after `build` succeeded and result page count equals `expectedPages`, saves backup before write and removes it after success; if `build` throws or page count mismatches, `write` is never called, the backup is kept, and the original bytes are unchanged; if `write` throws, the backup remains.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** with pdf-lib (`PDFDocument.load(bytes, { ignoreEncryption: false })`, `copyPages`, `embedJpg/embedPng`). Read EXIF orientation and DPI with a minimal parser in `merge.ts`. **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: pdf merge, image pages and verified append`.

### Task 9: Page renderer

**Files:** Create `src/pdf/pageRenderer.ts`; Test `tests/pdf/pageRenderer.test.ts` (cache logic only; rendering is verified in Task 15)

**Interfaces:** Produces:
```ts
export interface PageImage { url: string; width: number; height: number; }
export class PageRenderer {
  constructor(loadBytes: (path: string) => Promise<Uint8Array>, loadPdfJs: () => Promise<any>);
  render(page: PageRef, maxEdge: number): Promise<PageImage>;   // cached by id+maxEdge, rotation NOT baked in (CSS rotates)
  dispose(): void;                                              // revokes object URLs, destroys pdf docs
}
```
LRU cache of 60 entries; one open pdf.js document per source path, reused across its pages; images via `Blob` object URLs.

- [ ] **Step 1: Tests with fake `loadPdfJs`:** same page+size rendered once (second call hits cache); different `maxEdge` renders again; two pages of one path open the document once; cache evicts oldest beyond 60 and revokes its URL; `dispose()` revokes all.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: cached page renderer`.

### Task 10: Start dialog

**Files:** Create `src/ui/StartDialog.ts`, `src/ui/FolderSuggest.ts`; Modify `styles.css`

**Interfaces:** Consumes Tasks 2, 5, 7. Produces `class StartDialog extends Modal` with `constructor(app, deps: { settings: ScanStitchSettings; onStart(init): void })`. Contents (spec 4.2): folder fuzzy-search field (`FuzzySuggestModal`-style suggest over `app.vault.getAllFolders()`), a **Recent** list under it (newest preselected, Enter starts), template dropdown that also preselects a template's stored folder, live filename preview via `resolveTemplate` (`{pages}` shows `?`), "Append to existing PDF" toggle revealing a PDF picker and hiding folder/template, Start button. Validation: watch root must be set (else a notice pointing to settings).

- [ ] **Step 1: Implement** the dialog and styles. **Step 2: Typecheck/lint** (`npm run typecheck && npm run lint`, exit 0).
- [ ] **Step 3: Manual check** deferred to Task 15 (list the checks in the QA checklist there).
- [ ] **Step 4: Commit** `feat: start dialog with recents and template preview`.

### Task 11: Scan side pane, status bar, commands

**Files:** Create `src/ui/ScanPaneView.ts`; Modify `src/main.ts`, `styles.css`

**Interfaces:** Consumes Task 7, 9. Produces `class ScanPaneView extends ItemView` (view type `scan-stitch-pane`, right leaf): red "Scanning" indicator, large page counter, thumbnail of last page, **Discard last** and **End session** buttons; updates on `controller.onChange`. Status bar item `Scanning: N pages` while a session runs, click ends scanning. Commands (ids): `start-session`, `end-session`, `discard-last-page`, `resume-session`; ribbon icon "scan" starting a session.

- [ ] **Step 1: Implement.** **Step 2: `npm run typecheck && npm run lint && npm run build`** exit 0.
- [ ] **Step 3: Commit** `feat: scanning side pane, status bar and commands`.

### Task 12: Review view

**Files:** Create `src/ui/ReviewView.ts`; Modify `styles.css`, `src/main.ts`

**Interfaces:** Consumes Tasks 4, 8, 9. Produces `class ReviewView extends ItemView` (view type `scan-stitch-review`, opens in a main-area tab). Layout (spec 4.5): top bar (editable filename hidden in append mode; "Appending to <file> (N existing pages)" instead; "Page i / n"; **Save** and **Save and open**), large current page (CSS-rotated), filmstrip below with rotated markers. Keys while the view is active: `R`/`Shift+R` rotate, `←/→` navigate, `Delete` remove, `Enter` save, `Esc` cancel (confirm if any change; returns to scanning, session kept), `Ctrl+Z`/`Ctrl+Y` undo/redo; click thumbnail jumps; drag thumbnails reorder (HTML5 drag events); `Shift+click` range-selects so `R` rotates the range. Save: read page bytes, `mergePages`, write via `app.vault.createBinary` into the destination folder (create folder if missing) with `uniqueName`; append mode uses `replaceWithVerify` with `ReplaceIO` backed by the vault and the plugin folder; success → `controller.finish()`, `pushRecent`, notice with name and page count; **Save and open** then opens the file in a leaf. With zero pages Save buttons are disabled (Review Focus 4).

- [ ] **Step 1: Implement** the view and keyboard map as a pure function `mapKey(e: {key; shiftKey; ctrlKey; metaKey}): ReviewAction | null` exported from `ReviewView.ts`.
- [ ] **Step 2: Write test** `tests/ui/mapKey.test.ts`: `r`→rotateCw, `R` with shift→rotateCcw, `ArrowLeft/Right`, `Delete`, `Enter`→save, `Escape`→cancel, `ctrl+z`→undo, `ctrl+y` and `ctrl+shift+z`→redo, `r` with ctrl→`null`. Run `npx vitest run tests/ui/mapKey.test.ts`, expect PASS after implementing.
- [ ] **Step 3: `npm run typecheck && npm run lint && npm run build`** exit 0.
- [ ] **Step 4: Commit** `feat: review view with keyboard flow, reorder and save`.

### Task 13: Settings tab

**Files:** Create `src/ui/SettingsTab.ts`; Modify `src/main.ts`

**Interfaces:** Consumes Tasks 2, 5. Fields (spec 4.1): watch root (text + browse via Electron `dialog` obtained from `require('electron').remote` is NOT allowed; use a text field plus an `<input type="file" webkitdirectory>` fallback and validate the path exists), include subfolders, file patterns (checkbox per `*.pdf`, `*.jpg`/`*.jpeg`, `*.png`), stability delay and retries, templates list (add, edit name/pattern/stored folder, delete, set default; unknown placeholders flagged via `findUnknownPlaceholders`), "Clear recent locations". Uses `new Setting(el).setHeading()` for sections.

- [ ] **Step 1: Implement.** **Step 2: `npm run typecheck && npm run lint`** exit 0. **Step 3: Commit** `feat: settings tab`.

### Task 14: Plugin wiring, resume, unload

**Files:** Modify `src/main.ts`

**Interfaces:** Consumes everything. `onload`: `loadSettings(await this.loadData())`, build `SessionController` with `persist` writing `settings.session` via `saveData`, `countPdfPages` via pdf-lib reading the file with Node `fs`, register views/commands/ribbon/status bar/settings tab; if `settings.session` exists, show a notice with actions to **Resume** (scanning pane or review by `phase`) or **Drop**; starting a session while one exists prompts resume or replace (spec 4.7). `onunload`: stop watcher, dispose renderer, detach leaves.

- [ ] **Step 1: Implement.** **Step 2: `npm test && npm run lint && npm run typecheck && npm run build`** all exit 0.
- [ ] **Step 3: Commit** `feat: wire plugin lifecycle, resume and cleanup`.

### Task 15: Demo data and manual QA

**Files:** Create `scripts/make-demo-scans.mjs`, `docs/qa-checklist.md`

**Interfaces:** `node scripts/make-demo-scans.mjs <outDir>` creates `<outDir>/2026_10_13/IMG_0001.pdf …` plus a second day folder (numbering restarting) of **synthetic** pages (headline, text lines, page number; a few drawn upside-down or rotated via `/Rotate`), using pdf-lib. Never uses the author's real scans.

- [ ] **Step 1: Implement the script; run it** into `C:\Dev\scan-stitch-demo\scanner`. Expected: 2 day folders, files open in a PDF viewer.
- [ ] **Step 2: Create a demo vault** `C:\Dev\scan-stitch-demo\vault`, install the built plugin (copy `main.js`, `manifest.json`, `styles.css` into `.obsidian/plugins/scan-stitch/`), set the watch root.
- [ ] **Step 3: Run `docs/qa-checklist.md`** and fix what fails. It must cover: start dialog (recents order, Enter path, template preview, append toggle); files copied into the scanner folder during a session bump the counter and thumbnail; a file dropped into a brand-new day folder is picked up; Discard last then rescan lands at the end and the scanner folder is byte-for-byte unchanged afterwards; End session opens review on page 1; every key in Task 12; reorder by drag; range rotate; undo/redo; Save and Save and open output the right pages and rotations (open the PDF and check); name collision gives ` 2`; append adds after existing pages and an encrypted target is refused with the original unchanged; quit Obsidian mid-session and resume; root renamed mid-session shows notice then recovers; light and dark theme; narrow pane width.
- [ ] **Step 4: Commit** `test: demo data generator and QA checklist`.

### Task 16: Logo

**Files:** Create `assets/logo.svg`, `assets/logo.png` (512×512), `assets/social-preview.png` (1280×640)

- [ ] **Step 1:** Use `Artifact` `action: "quickstart"` with `intent: "design"`, then build the logo as a Design artifact: simple mark combining stacked pages and a stitch, works on light and dark backgrounds, readable at 32 px.
- [ ] **Step 2:** Export SVG and PNGs into `assets/`; check the SVG renders at 32 px and 512 px (open both in the browser tool).
- [ ] **Step 3:** Show the author the logo and wait for approval before using it. **Step 4: Commit** `docs: add logo and social preview`.

### Task 17: Screenshots and demo GIF

**Files:** Create `assets/screenshots/{start-dialog,scan-pane,review,settings}-{light,dark}.png`, `assets/demo.gif`

- [ ] **Step 1:** Launch the demo vault from Task 15 (Obsidian with `--remote-debugging-port=9222` if a script-driven capture is wanted, otherwise computer-use capture). Capture each screen in both themes at consistent window size.
- [ ] **Step 2:** Record the GIF of one full session: start dialog → copy demo pages into the scanner folder one by one (use a small script with delays) → counter rises → Discard last → End session → R on two pages → Save and open. Keep under 6 MB and ~15 s; export with the `gif_creator` or ffmpeg.
- [ ] **Step 3:** Check no real personal data appears; show the author the GIF and screenshots for approval. **Step 4: Commit** `docs: add screenshots and demo gif`.

### Task 18: README, community files, GitHub Pages

**Files:** Create/replace `README.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`, `.github/pull_request_template.md`, `docs/site/index.html` (+ assets copied from `assets/`), `.github/workflows/pages.yml`

- [ ] **Step 1: README:** logo header, one-line pitch, `assets/demo.gif`, feature list, install (community store once listed; manual: copy three files), usage walkthrough, settings table, keyboard shortcut table (from Task 12), template placeholder table, FAQ (desktop only, why folder is read only, supported scanners/files), licence. Relative image paths must resolve on GitHub.
- [ ] **Step 2: Landing page** `docs/site/index.html` (single static page via the `frontend-design`/`artifact-design` guidance: logo, GIF, three feature blocks, screenshots with light/dark pairs, install link, GitHub link; works at phone width; no external scripts).
- [ ] **Step 3: `pages.yml`** deploys `docs/site` with the official `actions/upload-pages-artifact` and `actions/deploy-pages` (pinned versions at least two weeks old).
- [ ] **Step 4: Verify** open `docs/site/index.html` locally and check mobile and desktop widths; check README renders (preview). **Step 5: Commit** `docs: readme, community files and pages site`.

### Task 19: Release workflow and store readiness

**Files:** Create `.github/workflows/release.yml`; Modify `manifest.json`, `versions.json`, `package.json`

- [ ] **Step 1:** `release.yml` on tag `v*`: `npm ci`, `npm test`, `npm run build`, create a GitHub release attaching `main.js`, `manifest.json`, `styles.css`. Tag name must equal `manifest.json` version (add a check step that fails otherwise).
- [ ] **Step 2: Store checklist** in `docs/store-submission.md`: verify against the current Obsidian plugin guidelines (use Context7 or the web for the latest) the points in Global Constraints, README present, licence, `versions.json`, no forbidden patterns (`innerHTML`, global `app`, `console.log` noise), description rules; run `eslint-plugin-obsidianmd` clean.
- [ ] **Step 3: Dry run:** `npm run build` and confirm the three release files exist and `manifest.json` version matches `package.json` and `versions.json`.
- [ ] **Step 4: Commit** `ci: release workflow and store checklist`.
- [ ] **Step 5: Stop and ask the author** before: pushing `main`, enabling Pages, tagging `v1.0.0`, and opening the PR to `obsidianmd/obsidian-releases`. Do each only on an explicit yes.

---

## Self-review notes

- Spec coverage: 4.1 settings (T13), 4.2 start dialog (T10), 4.3 scanning pane and discard (T7, T11), 4.4 templates (T2, T10, T13), 4.5 review (T12), 4.6 saving/append (T8, T12), 4.7 resilience (T7, T14), 5a repo presentation (T16–T19), 5b calls (T6, T7, T8), non-goals respected (no OCR, no TIFF, no mobile).
- Type names used across tasks: `PageRef`, `SessionData`, `SessionState`, `SessionController`, `PageRenderer`, `MergeSource`, `MergeResult`, `Template`, `ScanStitchSettings` are defined once above.
- Known uncertainty the implementer should verify rather than assume: `fs.watch` `recursive` behaviour on Linux inside Electron, and `loadPdfJs` availability at `minAppVersion` 1.5.0.
