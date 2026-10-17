import * as fs from 'fs';
import { Notice, Plugin, loadPdfJs, type WorkspaceLeaf } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { loadSettings } from './core/settings';
import { PageRenderer } from './pdf/pageRenderer';
import { SessionController } from './scan/sessionController';
import { ScanStitchSettingTab } from './ui/SettingsTab';
import { ReviewView } from './ui/ReviewView';
import { ScanPaneView } from './ui/ScanPaneView';
import { StartDialog } from './ui/StartDialog';
import { paneModel, statusText } from './ui/paneModel';
import { REVIEW_VIEW_TYPE, SCAN_VIEW_TYPE } from './ui/viewTypes';
import type { ScanStitchSettings, SessionData } from './types';

export default class ScanStitchPlugin extends Plugin {
  declare settings: ScanStitchSettings;
  controller!: SessionController;
  renderer!: PageRenderer;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());

    this.controller = new SessionController({
      settings: () => this.settings,
      persist: async (session: SessionData | null) => {
        this.settings.session = session;
        await this.saveData(this.settings);
      },
      notify: (m) => {
        new Notice(m);
      },
      countPdfPages: async (path) => {
        const doc = await PDFDocument.load(fs.readFileSync(path));
        return doc.getPageCount();
      },
    });

    this.renderer = new PageRenderer(
      (p) => Promise.resolve(new Uint8Array(fs.readFileSync(p))),
      () => loadPdfJs(),
    );

    this.registerView(
      SCAN_VIEW_TYPE,
      (leaf) =>
        new ScanPaneView(leaf, {
          controller: this.controller,
          renderer: this.renderer,
          startSession: () => this.startSession(),
          endSession: () => this.endSession(),
        }),
    );

    this.registerView(
      REVIEW_VIEW_TYPE,
      (leaf) =>
        new ReviewView(leaf, {
          controller: this.controller,
          renderer: this.renderer,
          settings: () => this.settings,
          saveSettings: () => this.saveSettings(),
          openScanPane: () => this.openScanPane(),
          readSource: async (p) => {
            const b = await fs.promises.readFile(p);
            return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
          },
          pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
        }),
    );

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable', 'scan-stitch-statusbar');
    this.statusEl.addEventListener('click', () => this.endSession());
    this.register(this.controller.onChange(() => this.updateStatusBar()));
    this.updateStatusBar();

    this.addSettingTab(new ScanStitchSettingTab(this.app, this));

    this.addRibbonIcon('scan', 'Start scan session', () => this.startSession());

    this.addCommand({ id: 'start-session', name: 'Start scan session', callback: () => this.startSession() });
    this.addCommand({ id: 'end-session', name: 'End scan session', callback: () => this.endSession() });
    this.addCommand({
      id: 'discard-last-page',
      name: 'Discard last scanned page',
      callback: () => this.controller.discardLast(),
    });
    this.addCommand({
      id: 'resume-session',
      name: 'Resume scan session',
      callback: () => {
        const s = this.controller.state;
        if (!s) {
          new Notice('No scan session to resume');
          return;
        }
        if (s.data.phase === 'review') void this.openReview();
        else void this.openScanPane();
      },
    });
  }

  onunload(): void {
    this.renderer?.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  startSession(): void {
    const existing = this.controller.state;
    if (existing) {
      new Notice('A scan session is already open');
      if (existing.data.phase === 'review') void this.openReview();
      else void this.openScanPane();
      return;
    }
    new StartDialog(this.app, {
      settings: this.settings,
      onStart: (init) => {
        this.controller.start(init);
        void this.openScanPane();
      },
    }).open();
  }

  endSession(): void {
    const s = this.controller.state;
    if (!s || s.data.phase !== 'scanning') return;
    this.controller.endScanning();
    void this.openReview();
  }

  async openScanPane(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(SCAN_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: SCAN_VIEW_TYPE, active: true });
    }
    if (workspace.rightSplit.collapsed) workspace.rightSplit.expand();
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async openReview(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    }
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  private updateStatusBar(): void {
    const el = this.statusEl;
    if (!el) return;
    const model = paneModel(this.controller.state);
    if (model.scanning) {
      el.setText(statusText(model.count));
      el.removeClass('scan-stitch-hidden');
    } else {
      el.addClass('scan-stitch-hidden');
    }
  }
}
