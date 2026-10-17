import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { SessionController } from '../scan/sessionController';
import type { PageRenderer } from '../pdf/pageRenderer';
import type { PageRef } from '../types';
import { paneModel } from './paneModel';
import { SCAN_VIEW_TYPE } from './viewTypes';

const THUMB_BOX = 200;

export interface ScanPaneDeps {
  controller: SessionController;
  renderer: PageRenderer;
  startSession(): void;
  endSession(): void;
}

export class ScanPaneView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private renderToken = 0;
  private mode: 'empty' | 'session' | null = null;
  private thumbId: string | null = null;
  private thumbRetriedId: string | null = null;
  private thumbImg: HTMLImageElement | null = null;
  private thumbSize: { w: number; h: number } | null = null;
  private rootEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private countEl!: HTMLElement;
  private labelEl!: HTMLElement;
  private thumbEl!: HTMLElement;
  private discardBtn!: HTMLButtonElement;
  private endBtn!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: ScanPaneDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SCAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Scan stitch';
  }

  getIcon(): string {
    return 'scan';
  }

  onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('scan-stitch-pane-host');
    this.rootEl = this.contentEl.createDiv({ cls: 'scan-stitch-pane' });
    this.mode = null;
    this.unsubscribe = this.deps.controller.onChange(() => this.refresh());
    this.refresh();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.renderToken++;
    return Promise.resolve();
  }

  private refresh(): void {
    const state = this.deps.controller.state;
    const model = paneModel(state);
    const mode = state ? 'session' : 'empty';
    if (mode !== this.mode) {
      this.mode = mode;
      this.build(mode);
    }
    if (mode === 'empty') return;

    this.statusEl.empty();
    if (model.scanning) {
      this.statusEl.createSpan({ cls: 'scan-stitch-dot' });
      this.statusEl.createSpan({ cls: 'scan-stitch-status-text', text: 'Scanning' });
    } else {
      this.statusEl.createSpan({ cls: 'scan-stitch-status-text scan-stitch-status-idle', text: 'In review' });
    }
    this.countEl.setText(String(model.count));
    this.labelEl.setText(model.count === 1 ? 'page' : 'pages');
    this.discardBtn.disabled = !model.canDiscard;
    this.endBtn.disabled = !model.scanning;
    this.updateThumb(model.lastPage);
  }

  private build(mode: 'empty' | 'session'): void {
    const root = this.rootEl;
    root.empty();
    this.renderToken++;
    this.thumbId = null;
    if (mode === 'empty') {
      const empty = root.createDiv({ cls: 'scan-stitch-empty' });
      empty.createDiv({ cls: 'scan-stitch-empty-title', text: 'No scan session running' });
      empty.createDiv({ cls: 'scan-stitch-empty-hint', text: 'Start a session to collect pages from your scanner.' });
      const btn = empty.createEl('button', { cls: 'mod-cta', text: 'Start scan session' });
      btn.addEventListener('click', () => this.deps.startSession());
      return;
    }
    this.statusEl = root.createDiv({ cls: 'scan-stitch-status' });
    const counter = root.createDiv({ cls: 'scan-stitch-counter' });
    this.countEl = counter.createDiv({ cls: 'scan-stitch-count' });
    this.labelEl = counter.createDiv({ cls: 'scan-stitch-count-label' });
    this.thumbEl = root.createDiv({ cls: 'scan-stitch-thumb' });
    const actions = root.createDiv({ cls: 'scan-stitch-actions' });
    this.discardBtn = actions.createEl('button', { text: 'Discard last' });
    this.discardBtn.addEventListener('click', () => this.deps.controller.discardLast());
    this.endBtn = actions.createEl('button', { cls: 'mod-cta', text: 'End session' });
    this.endBtn.addEventListener('click', () => this.deps.endSession());
  }

  private updateThumb(page: PageRef | null): void {
    const id = page ? page.id : null;
    if (id === this.thumbId) {
      if (page && this.thumbImg) this.applyImage(page);
      return;
    }
    this.thumbId = id;
    if (this.thumbRetriedId !== id) this.thumbRetriedId = null;
    this.thumbImg = null;
    this.renderToken++;
    const token = this.renderToken;
    this.thumbEl.empty();
    if (!page) {
      this.thumbEl.addClass('is-empty');
      this.thumbEl.createDiv({ cls: 'scan-stitch-thumb-placeholder', text: 'Waiting for the first page' });
      return;
    }
    this.thumbEl.removeClass('is-empty');
    this.thumbEl.createDiv({ cls: 'scan-stitch-thumb-placeholder', text: 'Loading preview' });
    this.deps.renderer.render(page, 240).then(
      (img) => {
        if (token !== this.renderToken) return;
        this.thumbEl.empty();
        this.thumbSize = { w: img.width, h: img.height };
        const el = this.thumbEl.createEl('img', {
          cls: 'scan-stitch-thumb-img',
          attr: { alt: 'Last scanned page' },
        });
        el.addEventListener('error', () => {
          // The shared cache released this image URL: render once more.
          if (token !== this.renderToken || this.thumbRetriedId === id) return;
          this.thumbRetriedId = id;
          this.thumbId = null;
          this.updateThumb(this.currentLast());
        });
        el.src = img.url;
        this.thumbImg = el;
        this.applyImage(this.currentLast() ?? page);
      },
      () => {
        if (token !== this.renderToken) return;
        this.thumbEl.empty();
        this.thumbEl.createDiv({ cls: 'scan-stitch-thumb-placeholder', text: 'Preview unavailable' });
      },
    );
  }

  private currentLast(): PageRef | null {
    return paneModel(this.deps.controller.state).lastPage;
  }

  /** Fit the (possibly sideways) page inside a square box and rotate it with CSS. */
  private applyImage(page: PageRef): void {
    const img = this.thumbImg;
    if (!img || !this.thumbSize) return;
    const { w, h } = this.thumbSize;
    const sideways = page.rotation === 90 || page.rotation === 270;
    const dispW = sideways ? h : w;
    const dispH = sideways ? w : h;
    const scale = Math.min(THUMB_BOX / dispW, THUMB_BOX / dispH);
    img.style.width = `${Math.round(w * scale)}px`;
    img.style.height = `${Math.round(h * scale)}px`;
    img.style.transform = `rotate(${page.rotation}deg)`;
  }
}
