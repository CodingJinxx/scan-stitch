import { ItemView, Modal, Notice, Platform, Scope, TFile, TFolder, moment, normalizePath, type App, type WorkspaceLeaf } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { pushRecent } from '../core/recents';
import type { SessionState } from '../core/sessionState';
import { sanitizeFileName } from '../core/template';
import type { PageRenderer } from '../pdf/pageRenderer';
import type { ReplaceIO } from '../pdf/safeReplace';
import type { SessionController } from '../scan/sessionController';
import type { PageRef, ScanStitchSettings } from '../types';
import {
  ReviewCursor,
  autoFilename,
  chooseFilename,
  counterText,
  dropSlot,
  mapKey,
  reorderTarget,
  rotationDelta,
  type ReviewAction,
} from './reviewLogic';
import { savePages, type SaveVault } from './saveFlow';
import { folderName, parentFolder } from './startLogic';
import { REVIEW_VIEW_TYPE } from './viewTypes';

const MAIN_EDGE = 1400;
const THUMB_EDGE = 160;
const MAX_UPSCALE = 1.5;
/** Drag payload type: a page id, never offered as plain text to editors. */
const DRAG_MIME = 'application/x-scan-stitch-page';

export interface ReviewDeps {
  controller: SessionController;
  renderer: PageRenderer;
  settings(): ScanStitchSettings;
  saveSettings(): Promise<void>;
  openScanPane(): Promise<void>;
  /** Read a scanned file (outside the vault) from disk. */
  readSource(path: string): Promise<Uint8Array>;
  /** Vault-relative folder of this plugin; append backups go to `<pluginDir>/backups`. */
  pluginDir: string;
}

interface Thumb {
  el: HTMLElement;
  box: HTMLElement;
  num: HTMLElement;
  img: HTMLImageElement | null;
  requested: boolean;
  retried: boolean;
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
  return b.slice().buffer;
}

export class ReviewView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private mode: 'empty' | 'review' | null = null;
  private sessionId: string | null = null;
  private closed = false;
  private cursor = new ReviewCursor();

  private rootEl!: HTMLElement;
  private nameInput: HTMLInputElement | null = null;
  private appendEl: HTMLElement | null = null;
  private counterEl!: HTMLElement;
  private saveBtn!: HTMLButtonElement;
  private saveOpenBtn!: HTMLButtonElement;
  private stageEl!: HTMLElement;
  private frameEl!: HTMLElement;
  private messageEl!: HTMLElement;
  private stripEl!: HTMLElement;

  private thumbs = new Map<string, Thumb>();
  private thumbObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private mainImg: HTMLImageElement | null = null;
  private mainSize: { w: number; h: number } | null = null;
  private shownId: string | null = null;
  private shownRotation = 0;
  private rotationDeg = 0;
  private mainToken = 0;
  private scrolledId: string | null = null;

  /** The template-generated name, the fallback when the field is blank. */
  private autoNameValue = '';
  private filenameEdited = false;
  private existingPages: number | 'loading' | 'error' = 'loading';
  private saving: 'save' | 'open' | null = null;
  private drag: { id: string; target: string | null; after: boolean } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: ReviewDeps,
  ) {
    super(leaf);
    // Obsidian's global keymap handles Escape in the capture phase (it activates the last
    // markdown tab) before our element listener runs. A scope pushed while the review has
    // focus is asked first, so Escape stays ours (View.scope needs a newer minAppVersion).
    this.keyScope = new Scope(this.app.scope);
    this.keyScope.register([], 'Escape', (evt) => {
      this.onKeyDown(evt);
      return false;
    });
  }

  private readonly keyScope: Scope;
  private scopePushed = false;

  private readonly onFocusIn = (): void => {
    if (this.scopePushed) return;
    this.app.keymap.pushScope(this.keyScope);
    this.scopePushed = true;
  };

  private readonly onFocusOut = (e: FocusEvent): void => {
    const to = e.relatedTarget as Node | null;
    if (to && this.rootEl.contains(to)) return;
    this.popKeyScope();
  };

  private popKeyScope(): void {
    if (!this.scopePushed) return;
    this.app.keymap.popScope(this.keyScope);
    this.scopePushed = false;
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Review scan';
  }

  getIcon(): string {
    return 'file-text';
  }

  onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass('scan-stitch-review-host');
    this.rootEl = this.contentEl.createDiv({ cls: 'scan-stitch-review', attr: { tabindex: '0', 'aria-label': 'Review scan' } });
    this.rootEl.addEventListener('keydown', this.onKeyDown);
    this.rootEl.addEventListener('focusin', this.onFocusIn);
    this.rootEl.addEventListener('focusout', this.onFocusOut);
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf) this.focusView();
      }),
    );
    this.mode = null;
    this.unsubscribe = this.deps.controller.onChange(() => this.refresh());
    this.refresh();
    window.setTimeout(() => this.focusView(), 0);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.rootEl?.removeEventListener('keydown', this.onKeyDown);
    this.rootEl?.removeEventListener('focusin', this.onFocusIn);
    this.rootEl?.removeEventListener('focusout', this.onFocusOut);
    this.popKeyScope();
    this.releaseObservers();
    this.thumbs.clear();
    this.mainToken++;
    this.contentEl.empty();
    return Promise.resolve();
  }

  // ---- state ----

  /** Always re-read: the controller may replace the state object. */
  private state(): SessionState | null {
    const s = this.deps.controller.state;
    return s && s.data.phase === 'review' ? s : null;
  }

  private refresh(): void {
    if (this.closed) return;
    const s = this.state();
    if (!s) {
      if (this.mode !== 'empty') this.buildEmpty();
      return;
    }
    if (this.mode !== 'review' || this.sessionId !== s.data.id) this.buildReview(s);
    const pages = s.data.pages;
    this.cursor.sync(pages.map((p) => p.id));
    this.counterEl.setText(counterText(this.cursor.index, pages.length, this.cursor.selectedIds().length));
    this.updateFilename(s);
    this.updateButtons(pages.length);
    this.updateStrip(pages);
    this.updateStage(this.cursor.index >= 0 ? pages[this.cursor.index] : null, pages.length);
  }

  private focusView(): void {
    if (this.closed || !this.rootEl) return;
    const active = this.rootEl.doc.activeElement;
    if (active && active !== this.rootEl && this.rootEl.contains(active)) return;
    this.rootEl.focus({ preventScroll: true });
  }

  // ---- layout ----

  private releaseObservers(): void {
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private resetView(): void {
    this.releaseObservers();
    this.thumbs.clear();
    this.mainToken++;
    this.mainImg = null;
    this.mainSize = null;
    this.shownId = null;
    this.scrolledId = null;
    this.nameInput = null;
    this.appendEl = null;
    this.drag = null;
    this.rootEl.empty();
  }

  private buildEmpty(): void {
    this.mode = 'empty';
    this.sessionId = null;
    this.resetView();
    this.rootEl.removeClass('is-saving');
    const empty = this.rootEl.createDiv({ cls: 'scan-stitch-empty scan-stitch-review-empty' });
    empty.createDiv({ cls: 'scan-stitch-empty-title', text: 'No review in progress' });
    empty.createDiv({ cls: 'scan-stitch-empty-hint', text: 'End a scan session to review its pages here.' });
  }

  private buildReview(s: SessionState): void {
    this.mode = 'review';
    this.sessionId = s.data.id;
    this.resetView();
    this.cursor = new ReviewCursor();
    this.filenameEdited = false;
    this.autoNameValue = '';
    const root = this.rootEl;

    const bar = root.createDiv({ cls: 'scan-stitch-review-bar' });
    const title = bar.createDiv({ cls: 'scan-stitch-review-title' });
    const target = s.data.appendTarget;
    if (target !== null) {
      this.appendEl = title.createDiv({ cls: 'scan-stitch-review-append' });
      this.existingPages = 'loading';
      this.renderAppendLabel(target);
      void this.loadExistingCount(target, s.data.id);
    } else {
      const field = title.createDiv({ cls: 'scan-stitch-review-name' });
      const input = field.createEl('input', {
        type: 'text',
        cls: 'scan-stitch-review-filename',
        attr: { 'aria-label': 'File name', spellcheck: 'false', autocomplete: 'off' },
      });
      field.createSpan({ cls: 'scan-stitch-review-ext', text: '.pdf' });
      input.addEventListener('input', () => {
        this.filenameEdited = true;
      });
      this.nameInput = input;
    }

    const meta = bar.createDiv({ cls: 'scan-stitch-review-meta' });
    this.counterEl = meta.createDiv({ cls: 'scan-stitch-review-counter', attr: { 'aria-live': 'polite' } });
    const actions = meta.createDiv({ cls: 'scan-stitch-review-actions' });
    this.saveOpenBtn = actions.createEl('button', { text: 'Save and open' });
    this.saveOpenBtn.addEventListener('click', () => void this.save(true));
    this.saveBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Save' });
    this.saveBtn.addEventListener('click', () => void this.save(false));

    this.stageEl = root.createDiv({ cls: 'scan-stitch-review-stage' });
    this.frameEl = this.stageEl.createDiv({ cls: 'scan-stitch-review-page' });
    this.messageEl = this.stageEl.createDiv({ cls: 'scan-stitch-review-message scan-stitch-hidden' });

    this.stripEl = root.createDiv({
      cls: 'scan-stitch-filmstrip',
      attr: { role: 'listbox', 'aria-label': 'Pages', 'aria-multiselectable': 'true' },
    });
    this.wireStrip(this.stripEl);

    this.buildHints(root);

    if (typeof IntersectionObserver === 'function') {
      this.thumbObserver = new IntersectionObserver((entries) => this.onThumbsVisible(entries), {
        root: this.stripEl,
        rootMargin: '0px 320px',
      });
    }
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.fitMain());
      this.resizeObserver.observe(this.stageEl);
    }
  }

  onResize(): void {
    if (!this.resizeObserver) this.fitMain();
  }

  private buildHints(root: HTMLElement): void {
    const mod = Platform.isMacOS ? '⌘' : 'Ctrl+';
    const hints: [string, string][] = [
      ['R', 'rotate'],
      ['Shift+R', 'rotate back'],
      ['← →', 'page'],
      ['Shift+click', 'range'],
      ['Del', 'remove'],
      [`${mod}Z`, 'undo'],
      ['Enter', 'save'],
      ['Esc', 'back to scanning'],
    ];
    const el = root.createDiv({ cls: 'scan-stitch-review-hints', attr: { 'aria-hidden': 'true' } });
    for (const [k, label] of hints) {
      const item = el.createSpan({ cls: 'scan-stitch-review-hint' });
      item.createEl('kbd', { text: k });
      item.createSpan({ text: label });
    }
  }

  // ---- header ----

  private renderAppendLabel(target: string): void {
    if (!this.appendEl) return;
    const n = this.existingPages;
    const count = n === 'loading' ? '… existing pages' : n === 'error' ? 'existing pages could not be counted' : `${plural(n, 'existing page')}`;
    this.appendEl.empty();
    this.appendEl.createSpan({ cls: 'scan-stitch-review-append-label', text: 'Appending to ' });
    this.appendEl.createSpan({ cls: 'scan-stitch-review-append-file', text: baseName(target) });
    this.appendEl.createSpan({ cls: 'scan-stitch-review-append-count', text: ` (${count})` });
    this.appendEl.setAttribute('title', target);
  }

  private async loadExistingCount(target: string, sessionId: string): Promise<void> {
    let result: number | 'error';
    try {
      const f = this.app.vault.getAbstractFileByPath(target);
      if (!(f instanceof TFile)) throw new Error('missing');
      const bytes = await this.app.vault.readBinary(f);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      result = doc.getPageCount();
    } catch {
      result = 'error';
    }
    if (this.closed || this.sessionId !== sessionId) return;
    this.existingPages = result;
    this.renderAppendLabel(target);
  }

  private autoName(s: SessionState): string {
    const count = s.data.pages.length;
    const template = this.deps.settings().templates.find((t) => t.name === s.data.templateName);
    if (!template) {
      // The template was renamed or deleted: fall back to the name previewed at start,
      // where '?' can only stand for {pages} (sanitising strips every other '?').
      return sanitizeFileName(s.data.filename.split('?').join(String(count)));
    }
    const folder = s.data.destinationFolder;
    const found = folder === '' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folder);
    const existingNames = found instanceof TFolder ? found.children.map((c) => c.name) : [];
    return autoFilename(template.pattern, {
      // The start time, so the name matches the one previewed when the session started.
      now: new Date(s.data.startedAt),
      pages: count,
      folder: folderName(folder),
      existingNames,
      format: (d, fmt) => moment(d).format(fmt),
    });
  }

  private updateFilename(s: SessionState): void {
    const input = this.nameInput;
    if (!input) return;
    const name = this.autoName(s);
    this.autoNameValue = name;
    if (!this.filenameEdited && input.value !== name) input.value = name;
  }

  private updateButtons(count: number): void {
    const disabled = count === 0 || this.saving !== null;
    this.saveBtn.disabled = disabled;
    this.saveOpenBtn.disabled = disabled;
    this.saveBtn.setText(this.saving === 'save' ? 'Saving…' : 'Save');
    this.saveOpenBtn.setText(this.saving === 'open' ? 'Saving…' : 'Save and open');
    this.rootEl.toggleClass('is-saving', this.saving !== null);
    this.rootEl.setAttribute('aria-busy', String(this.saving !== null));
    if (this.nameInput) this.nameInput.disabled = this.saving !== null;
  }

  // ---- filmstrip ----

  private updateStrip(pages: PageRef[]): void {
    const strip = this.stripEl;
    const live = new Set<string>();
    pages.forEach((p, i) => {
      live.add(p.id);
      let t = this.thumbs.get(p.id);
      if (!t) t = this.createThumb(p);
      const at = strip.children[i];
      if (at !== t.el) strip.insertBefore(t.el, at ?? null);
      t.num.setText(String(i + 1));
      const current = i === this.cursor.index;
      const selected = this.cursor.isSelected(p.id);
      t.el.toggleClass('is-current', current);
      t.el.toggleClass('is-selected', selected);
      t.el.toggleClass('is-rotated', p.rotation !== 0);
      t.el.setAttribute('aria-selected', String(current || selected));
      t.el.setAttribute('aria-label', `Page ${i + 1}${p.rotation !== 0 ? `, rotated ${p.rotation}°` : ''}`);
      t.el.setCssProps({ '--scan-stitch-rotation': `${p.rotation}deg` });
    });
    for (const [id, t] of [...this.thumbs]) {
      if (live.has(id)) continue;
      this.thumbObserver?.unobserve(t.el);
      t.el.remove();
      this.thumbs.delete(id);
    }
    const currentId = this.cursor.currentId;
    if (currentId !== this.scrolledId) {
      this.scrolledId = currentId;
      if (currentId) this.scrollThumbIntoView(currentId);
    }
  }

  private createThumb(p: PageRef): Thumb {
    const el = createDiv({ cls: 'scan-stitch-film-item', attr: { role: 'option', draggable: 'true' } });
    el.dataset.id = p.id;
    const box = el.createDiv({ cls: 'scan-stitch-film-thumb' });
    box.createDiv({ cls: 'scan-stitch-film-placeholder' });
    const foot = el.createDiv({ cls: 'scan-stitch-film-foot' });
    const num = foot.createSpan({ cls: 'scan-stitch-film-num' });
    foot.createSpan({ cls: 'scan-stitch-film-rotated', text: '↻', attr: { 'aria-hidden': 'true' } });
    const t: Thumb = { el, box, num, img: null, requested: false, retried: false };
    this.thumbs.set(p.id, t);
    if (this.thumbObserver) this.thumbObserver.observe(el);
    else this.loadThumb(p.id);
    return t;
  }

  private onThumbsVisible(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = (e.target as HTMLElement).dataset.id;
      if (id) this.loadThumb(id);
    }
  }

  private pageById(id: string): PageRef | null {
    return this.state()?.data.pages.find((p) => p.id === id) ?? null;
  }

  private loadThumb(id: string): void {
    const t = this.thumbs.get(id);
    const page = this.pageById(id);
    if (!t || !page || t.requested) return;
    t.requested = true;
    this.deps.renderer.render(page, THUMB_EDGE).then(
      (img) => {
        if (this.thumbs.get(id) !== t) return;
        t.box.empty();
        const el = t.box.createEl('img', { cls: 'scan-stitch-film-img', attr: { alt: '', draggable: 'false' } });
        el.addEventListener('error', () => {
          // The cached image URL was released: render once more.
          if (t.retried || this.thumbs.get(id) !== t) return;
          t.retried = true;
          t.requested = false;
          this.loadThumb(id);
        });
        el.src = img.url;
        t.img = el;
        if (this.thumbObserver) this.thumbObserver.unobserve(t.el);
      },
      () => {
        if (this.thumbs.get(id) !== t) return;
        t.box.empty();
        t.box.createDiv({ cls: 'scan-stitch-film-placeholder is-error', text: '!' });
      },
    );
  }

  private scrollThumbIntoView(id: string): void {
    const t = this.thumbs.get(id);
    if (!t) return;
    const strip = this.stripEl;
    const pad = 24;
    const left = t.el.offsetLeft;
    const right = left + t.el.offsetWidth;
    let next: number | null = null;
    if (left - pad < strip.scrollLeft) next = left - pad;
    else if (right + pad > strip.scrollLeft + strip.clientWidth) next = right + pad - strip.clientWidth;
    if (next === null) return;
    strip.scrollTo({ left: Math.max(0, next), behavior: this.reducedMotion() ? 'auto' : 'smooth' });
  }

  private reducedMotion(): boolean {
    try {
      return this.rootEl.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  private itemFrom(e: Event): HTMLElement | null {
    const el = e.target as HTMLElement | null;
    return el?.closest?.('.scan-stitch-film-item') ?? null;
  }

  private indexOf(id: string): number {
    return this.state()?.data.pages.findIndex((p) => p.id === id) ?? -1;
  }

  private wireStrip(strip: HTMLElement): void {
    strip.addEventListener('click', (e) => {
      const item = this.itemFrom(e);
      const id = item?.dataset.id;
      if (!id || this.saving) return;
      const i = this.indexOf(id);
      if (i < 0) return;
      this.cursor.click(i, e.shiftKey);
      this.refresh();
      this.rootEl.focus({ preventScroll: true });
    });

    strip.addEventListener('dragstart', (e) => {
      const id = this.itemFrom(e)?.dataset.id;
      if (!id || this.saving) {
        e.preventDefault();
        return;
      }
      this.drag = { id, target: null, after: false };
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_MIME, id);
      }
      this.thumbs.get(id)?.el.addClass('is-dragging');
    });

    strip.addEventListener('dragover', (e) => {
      if (!this.drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // Hit-test against every item, so gaps and padding resolve to the nearest slot.
      const items = Array.from(strip.children) as HTMLElement[];
      const slot = dropSlot(
        items.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
        e.clientX,
      );
      const target = slot ? (items[slot.index]?.dataset.id ?? null) : null;
      const after = slot?.after ?? false;
      if (target === this.drag.target && after === this.drag.after) return;
      this.drag.target = target;
      this.drag.after = after;
      this.showDropIndicator();
    });

    strip.addEventListener('dragleave', (e) => {
      if (!this.drag) return;
      const to = e.relatedTarget as Node | null;
      if (to && strip.contains(to)) return;
      this.drag.target = null;
      this.showDropIndicator();
    });

    strip.addEventListener('drop', (e) => {
      if (!this.drag) return;
      e.preventDefault();
      const { id, target, after } = this.drag;
      this.endDrag();
      const s = this.state();
      if (!s || target === null || this.saving) return;
      const from = this.indexOf(id);
      const onto = this.indexOf(target);
      if (from < 0 || onto < 0) return;
      const to = reorderTarget(from, onto, after);
      if (to === from) return;
      s.move(id, to);
      this.cursor.sync(s.data.pages.map((p) => p.id));
      this.cursor.go(to);
      this.deps.controller.commit();
      this.rootEl.focus({ preventScroll: true });
    });

    strip.addEventListener('dragend', () => this.endDrag());
  }

  private showDropIndicator(): void {
    for (const t of this.thumbs.values()) t.el.removeClass('is-drop-before', 'is-drop-after');
    const d = this.drag;
    if (!d || d.target === null) return;
    this.thumbs.get(d.target)?.el.addClass(d.after ? 'is-drop-after' : 'is-drop-before');
  }

  private endDrag(): void {
    this.drag = null;
    for (const t of this.thumbs.values()) t.el.removeClass('is-drop-before', 'is-drop-after', 'is-dragging');
  }

  // ---- main page ----

  private updateStage(page: PageRef | null, total: number): void {
    if (!page) {
      this.mainToken++;
      this.shownId = null;
      this.mainImg = null;
      this.frameEl.empty();
      this.frameEl.addClass('scan-stitch-hidden');
      this.showMessage(
        total === 0 ? 'No pages left' : 'Nothing to show',
        `Press ${Platform.isMacOS ? '⌘Z' : 'Ctrl+Z'} to undo, or Esc to go back to scanning.`,
      );
      return;
    }
    this.frameEl.removeClass('scan-stitch-hidden');
    if (page.id !== this.shownId) {
      this.shownId = page.id;
      this.shownRotation = page.rotation;
      this.rotationDeg = page.rotation;
      this.loadMain(page);
      return;
    }
    // The same page can move (undo, reorder): keep its label in step with the counter.
    if (this.mainImg) this.mainImg.alt = `Page ${this.cursor.index + 1}`;
    if (page.rotation !== this.shownRotation) {
      this.rotationDeg += rotationDelta(this.shownRotation, page.rotation);
      this.shownRotation = page.rotation;
      this.fitMain();
    }
  }

  private showMessage(title: string, hint: string): void {
    this.messageEl.empty();
    this.messageEl.removeClass('scan-stitch-hidden');
    this.messageEl.createDiv({ cls: 'scan-stitch-empty-title', text: title });
    if (hint) this.messageEl.createDiv({ cls: 'scan-stitch-empty-hint', text: hint });
  }

  private hideMessage(): void {
    this.messageEl.addClass('scan-stitch-hidden');
  }

  private loadMain(page: PageRef): void {
    const token = ++this.mainToken;
    this.frameEl.addClass('is-loading');
    this.hideMessage();
    this.deps.renderer.render(page, MAIN_EDGE).then(
      async (img) => {
        if (token !== this.mainToken) return;
        const el = createEl('img', {
          cls: 'scan-stitch-review-img',
          attr: { alt: `Page ${this.cursor.index + 1}`, draggable: 'false' },
        });
        el.src = img.url;
        try {
          await el.decode();
        } catch {
          // show it anyway; the browser will paint it when ready
        }
        if (token !== this.mainToken) return;
        this.frameEl.empty();
        this.frameEl.appendChild(el);
        this.mainImg = el;
        this.mainSize = { w: img.width, h: img.height };
        // A new page appears in its rotation without spinning into it.
        this.frameEl.addClass('is-instant');
        this.fitMain();
        window.requestAnimationFrame(() => this.frameEl.removeClass('is-instant'));
        this.frameEl.removeClass('is-loading');
        this.prefetchNext();
      },
      () => {
        if (token !== this.mainToken) return;
        this.frameEl.removeClass('is-loading');
        this.frameEl.empty();
        this.mainImg = null;
        this.showMessage('Preview unavailable', 'The page is still included when you save.');
      },
    );
  }

  private prefetchNext(): void {
    const s = this.state();
    const next = s?.data.pages[this.cursor.index + 1];
    if (next) this.deps.renderer.render(next, MAIN_EDGE).catch(() => {});
  }

  /** Fit the (possibly sideways) page into the stage and apply its rotation. */
  private fitMain(): void {
    const img = this.mainImg;
    const size = this.mainSize;
    if (!img || !size || this.closed) return;
    const style = this.stageEl.win.getComputedStyle(this.stageEl);
    const availW = this.stageEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availH = this.stageEl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const sideways = this.shownRotation === 90 || this.shownRotation === 270;
    const dispW = sideways ? size.h : size.w;
    const dispH = sideways ? size.w : size.h;
    const scale = Math.min(availW / dispW, availH / dispH, MAX_UPSCALE);
    this.frameEl.setCssProps({
      '--scan-stitch-page-w': `${Math.round(size.w * scale)}px`,
      '--scan-stitch-page-h': `${Math.round(size.h * scale)}px`,
      '--scan-stitch-rotation': `${this.rotationDeg}deg`,
    });
  }

  // ---- keyboard and actions ----

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Already handled through the view scope (Escape), which sees the event first.
    if (e.isComposing || e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // Typing a file name: only Enter (save) and Escape (back to the page) are ours.
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.save(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.rootEl.focus({ preventScroll: true });
      }
      return;
    }
    // A focused button handles its own Enter and Space.
    if (tag === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    const action = mapKey(e);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    this.run(action);
  };

  private run(action: ReviewAction): void {
    if (this.saving) return;
    const s = this.state();
    if (!s) return;
    const c = this.cursor;
    switch (action) {
      case 'rotateCw':
      case 'rotateCcw': {
        const ids = c.targetIds();
        if (ids.length === 0) return;
        s.rotate(ids, action === 'rotateCw' ? 1 : -1);
        this.deps.controller.commit();
        return;
      }
      case 'remove': {
        const ids = c.targetIds();
        if (ids.length === 0) return;
        s.remove(ids);
        this.deps.controller.commit();
        return;
      }
      case 'undo':
        if (s.undo()) this.deps.controller.commit();
        return;
      case 'redo':
        if (s.redo()) this.deps.controller.commit();
        return;
      case 'prev':
        c.prev();
        break;
      case 'next':
        c.next();
        break;
      case 'first':
        c.first();
        break;
      case 'last':
        c.last();
        break;
      case 'selectAll':
        c.selectAll();
        break;
      case 'save':
        void this.save(false);
        return;
      case 'cancel':
        this.cancel();
        return;
    }
    this.refresh();
  }

  private cancel(): void {
    const s = this.state();
    if (!s) {
      this.leaf.detach();
      return;
    }
    if (!s.canUndo()) {
      this.keepScanning();
      return;
    }
    new LeaveReviewModal(this.app, {
      keepScanning: () => this.keepScanning(),
      discard: () => this.discard(),
      dismissed: () => this.focusView(),
    }).open();
  }

  private keepScanning(): void {
    const deps = this.deps;
    this.leaf.detach();
    deps.controller.backToScanning();
    void deps.openScanPane();
  }

  private discard(): void {
    const { controller } = this.deps;
    this.leaf.detach();
    void controller.finish();
    new Notice('Scan session discarded');
  }

  // ---- saving ----

  private currentFilename(): string {
    return chooseFilename(this.nameInput?.value ?? '', this.autoNameValue);
  }

  private async save(open: boolean): Promise<void> {
    const s = this.state();
    if (this.saving || !s || s.data.pages.length === 0) return;
    const data = s.toJSON();
    const filename = this.currentFilename();
    this.saving = open ? 'open' : 'save';
    this.updateButtons(data.pages.length);
    const { app } = this;
    const { controller } = this.deps;
    const append = data.appendTarget !== null ? this.appendIO(data.appendTarget) : null;
    try {
      const result = await savePages({
        pages: data.pages,
        readSource: (p) => this.deps.readSource(p),
        destinationFolder: data.destinationFolder,
        filename,
        appendTarget: data.appendTarget,
        vault: this.vaultIO(),
        appendIO: append?.io,
        appendBackupPath: append?.backupPath,
      });

      // Recent locations are folders only, recorded on a successful save.
      const folder = data.appendTarget !== null ? parentFolder(data.appendTarget) : data.destinationFolder;
      const settings = this.deps.settings();
      settings.recentLocations = pushRecent(settings.recentLocations, folder === '' ? '/' : folder);
      try {
        await this.deps.saveSettings();
      } catch {
        // the PDF is saved; a lost recent entry is not worth an error
      }

      if (controller.state?.data.id === data.id) await controller.finish();
      this.saving = null;
      this.leaf.detach();
      const name = baseName(result.path);
      new Notice(
        data.appendTarget !== null
          ? `Added ${plural(result.added, 'page')} to ${name} (${plural(result.pageCount, 'page')})`
          : `Saved ${name} (${plural(result.pageCount, 'page')})`,
      );
      if (open) {
        try {
          const file = app.vault.getAbstractFileByPath(result.path);
          if (!(file instanceof TFile)) throw new Error('not found');
          await app.workspace.getLeaf(true).openFile(file);
        } catch {
          new Notice(`Saved, but could not open ${name}`);
        }
      }
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 10000);
    } finally {
      this.saving = null;
      if (!this.closed) {
        this.refresh();
        this.focusView();
      }
    }
  }

  private vaultIO(): SaveVault {
    const vault = this.app.vault;
    return {
      exists: (path) => {
        if (vault.getAbstractFileByPath(path)) return true;
        // Also catch names that differ only in case (Windows and macOS file systems).
        const parent = parentFolder(path);
        const folder = parent === '' ? vault.getRoot() : vault.getAbstractFileByPath(parent);
        if (!(folder instanceof TFolder)) return false;
        const lower = baseName(path).toLowerCase();
        return folder.children.some((c) => c.name.toLowerCase() === lower);
      },
      ensureFolder: async (path) => {
        let cur = '';
        for (const part of path.split('/')) {
          cur = cur === '' ? part : `${cur}/${part}`;
          const f = vault.getAbstractFileByPath(cur);
          if (f instanceof TFolder) continue;
          if (f) throw new Error(`${cur} is a file, not a folder`);
          await vault.createFolder(cur);
        }
      },
      createBinary: async (path, bytes) => {
        await vault.createBinary(path, toArrayBuffer(bytes));
      },
    };
  }

  private appendIO(target: string): { io: ReplaceIO; backupPath: string } {
    const vault = this.app.vault;
    const adapter = vault.adapter;
    const file = (): TFile => {
      const f = vault.getAbstractFileByPath(target);
      if (!(f instanceof TFile)) throw new Error('the file no longer exists');
      return f;
    };
    const dir = normalizePath(`${this.deps.pluginDir}/backups`);
    const backup = normalizePath(`${dir}/${moment().format('YYYYMMDD-HHmmss')}-${baseName(target)}`);
    const io: ReplaceIO = {
      read: async () => new Uint8Array(await vault.readBinary(file())),
      write: async (bytes) => {
        await vault.modifyBinary(file(), toArrayBuffer(bytes));
      },
      saveBackup: async (bytes) => {
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.writeBinary(backup, toArrayBuffer(bytes));
      },
      removeBackup: async () => {
        await adapter.remove(backup);
      },
    };
    return { io, backupPath: backup };
  }
}

interface LeaveChoices {
  keepScanning(): void;
  discard(): void;
  /** Closed without a choice (Cancel, Esc, click outside). */
  dismissed(): void;
}

class LeaveReviewModal extends Modal {
  private chosen = false;

  constructor(
    app: App,
    private readonly choices: LeaveChoices,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Leave the review?');
    contentEl.addClass('scan-stitch-leave');
    contentEl.createEl('p', {
      text: 'Your changes stay with the session if you keep scanning. Discarding drops the whole session; the scanned files are not touched.',
    });
    const actions = contentEl.createDiv({ cls: 'scan-stitch-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const discard = actions.createEl('button', { cls: 'mod-warning', text: 'Discard session' });
    discard.addEventListener('click', () => {
      this.chosen = true;
      this.close();
      this.choices.discard();
    });
    const keep = actions.createEl('button', { cls: 'mod-cta', text: 'Keep scanning' });
    keep.addEventListener('click', () => {
      this.chosen = true;
      this.close();
      this.choices.keepScanning();
    });
    window.setTimeout(() => keep.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    // After the modal has released focus, hand it back to the review view.
    if (!this.chosen) window.setTimeout(() => this.choices.dismissed(), 0);
  }
}
