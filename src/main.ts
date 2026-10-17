import * as fs from 'fs';
import { Notice, Plugin, loadPdfJs, type Modal, type WorkspaceLeaf } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { loadSettings } from './core/settings';
import { PageRenderer } from './pdf/pageRenderer';
import { SessionController } from './scan/sessionController';
import { ScanStitchSettingTab } from './ui/SettingsTab';
import { ExistingSessionModal, ResumePromptModal } from './ui/LifecycleModals';
import { ReviewView } from './ui/ReviewView';
import { ScanPaneView } from './ui/ScanPaneView';
import { StartDialog } from './ui/StartDialog';
import { resumeChoice } from './ui/lifecycleLogic';
import { paneModel, statusText } from './ui/paneModel';
import { REVIEW_VIEW_TYPE, SCAN_VIEW_TYPE } from './ui/viewTypes';
import type { ScanStitchSettings, SessionData } from './types';

async function readBytes(path: string): Promise<Uint8Array> {
  const b = await fs.promises.readFile(path);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default class ScanStitchPlugin extends Plugin {
  declare settings: ScanStitchSettings;
  controller!: SessionController;
  renderer!: PageRenderer;
  private statusEl: HTMLElement | null = null;
  private modal: Modal | null = null;

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
        const doc = await PDFDocument.load(await fs.promises.readFile(path));
        return doc.getPageCount();
      },
    });

    this.renderer = new PageRenderer(readBytes, () => loadPdfJs());

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
          readSource: readBytes,
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
    this.addCommand({
      id: 'end-session',
      name: 'End scan session',
      checkCallback: (checking) => {
        if (!paneModel(this.controller.state).scanning) return false;
        if (!checking) this.endSession();
        return true;
      },
    });
    this.addCommand({
      id: 'discard-last-page',
      name: 'Discard last scanned page',
      checkCallback: (checking) => {
        if (!paneModel(this.controller.state).canDiscard) return false;
        if (!checking) this.controller.discardLast();
        return true;
      },
    });
    this.addCommand({
      id: 'resume-session',
      name: 'Resume scan session',
      callback: () => void this.resumeSession(),
    });

    this.app.workspace.onLayoutReady(() => this.offerResume());
  }

  onunload(): void {
    this.modal?.close();
    this.modal = null;
    // Stops the watcher and flushes pending writes; the stored session stays for the next start.
    void this.controller?.shutdown();
    this.renderer?.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** A session exists if one is running or one is stored and not yet resumed. */
  private hasSession(): boolean {
    return this.controller.state !== null || this.settings.session !== null;
  }

  private openModal(modal: Modal): void {
    this.modal?.close();
    this.modal = modal;
    modal.open();
  }

  private offerResume(): void {
    const session = this.settings.session;
    if (this.controller.state || !session || resumeChoice(session) === 'none') return;
    this.openModal(
      new ResumePromptModal(this.app, {
        session,
        onResume: () => void this.resumeSession(),
        onDrop: () => void this.dropSession(),
      }),
    );
  }

  /** Opens the running session, or restores the stored one first. */
  async resumeSession(): Promise<void> {
    try {
      if (!this.controller.state) {
        const stored = this.settings.session;
        if (!stored || resumeChoice(stored) === 'none') {
          new Notice('No scan session to resume');
          return;
        }
        await this.controller.resume(stored);
      }
      const state = this.controller.state;
      if (!state) return;
      if (resumeChoice(state.data) === 'review') await this.openReview();
      else await this.openScanPane();
    } catch (e) {
      new Notice(`Could not resume the scan session: ${errorText(e)}`);
    }
  }

  private async dropSession(): Promise<boolean> {
    try {
      await this.controller.finish();
      return true;
    } catch (e) {
      new Notice(`Could not drop the scan session: ${errorText(e)}`);
      return false;
    }
  }

  startSession(): void {
    if (!this.hasSession()) {
      this.openStartDialog();
      return;
    }
    this.openModal(
      new ExistingSessionModal(this.app, {
        onChoice: (choice) => {
          if (choice === 'resume') void this.resumeSession();
          else void this.dropSession().then((ok) => ok && this.openStartDialog());
        },
      }),
    );
  }

  private openStartDialog(): void {
    this.openModal(
      new StartDialog(this.app, {
        settings: this.settings,
        onStart: (init) => {
          try {
            this.controller.start(init);
          } catch (e) {
            new Notice(`Could not start the scan session: ${errorText(e)}`);
            return;
          }
          void this.openScanPane();
        },
      }),
    );
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
