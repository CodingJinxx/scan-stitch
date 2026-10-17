import { Modal, Setting } from 'obsidian';
import type { App, ButtonComponent } from 'obsidian';
import type { SessionData } from '../types';
import {
  EXISTING_SESSION_OPTIONS,
  confirmText,
  sessionSummary,
  type ExistingSessionChoice,
} from './lifecycleLogic';

/**
 * Styles a button as destructive. `setDestructive()` exists from Obsidian 1.13;
 * on older versions fall back to the `mod-warning` class the old API added.
 */
function markDestructive(button: ButtonComponent): void {
  const b = button as unknown as { setDestructive?: () => unknown };
  if (typeof b.setDestructive === 'function') b.setDestructive();
  else button.buttonEl.addClass('mod-warning');
}

/** Shows a question with Back / confirm buttons in place of a modal's content. */
function renderConfirm(modal: Modal, question: string, confirmLabel: string, onConfirm: () => void, onBack: () => void): void {
  const { contentEl } = modal;
  contentEl.empty();
  contentEl.createEl('p', { text: question });
  new Setting(contentEl)
    .setClass('scan-stitch-modal-buttons')
    .addButton((b) => b.setButtonText('Back').onClick(onBack))
    .addButton((b) => {
      b.setButtonText(confirmLabel).onClick(onConfirm);
      markDestructive(b);
    });
}

export interface ResumePromptDeps {
  session: SessionData;
  onResume(): void;
  onDrop(): void;
}

/** Offered on startup when a session was left open. Later just closes it. */
export class ResumePromptModal extends Modal {
  constructor(
    app: App,
    private readonly deps: ResumePromptDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Scan session in progress');
    this.renderMain();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderMain(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: 'A scan session was left open last time.' });
    const dl = contentEl.createEl('dl', { cls: 'scan-stitch-summary' });
    for (const line of sessionSummary(this.deps.session, (t) => new Date(t).toLocaleString())) {
      dl.createEl('dt', { text: line.label });
      dl.createEl('dd', { text: line.value });
    }
    new Setting(contentEl)
      .setClass('scan-stitch-modal-buttons')
      .addButton((b) =>
        b
          .setButtonText('Resume')
          .setCta()
          .onClick(() => {
            this.close();
            this.deps.onResume();
          }),
      )
      .addButton((b) => b.setButtonText('Drop').onClick(() => this.renderDropConfirm()))
      .addButton((b) => b.setButtonText('Later').onClick(() => this.close()));
  }

  private renderDropConfirm(): void {
    renderConfirm(
      this,
      confirmText('drop') ?? '',
      'Drop session',
      () => {
        this.close();
        this.deps.onDrop();
      },
      () => this.renderMain(),
    );
  }
}

export interface ExistingSessionDeps {
  onChoice(choice: Exclude<ExistingSessionChoice, 'cancel'>): void;
}

/** Shown when a new session is requested while one already exists. */
export class ExistingSessionModal extends Modal {
  constructor(
    app: App,
    private readonly deps: ExistingSessionDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('A scan session is already open');
    this.renderMain();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderMain(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: 'Only one session can run at a time.' });
    const row = new Setting(contentEl).setClass('scan-stitch-modal-buttons');
    for (const opt of EXISTING_SESSION_OPTIONS) {
      row.addButton((b) => {
        b.setButtonText(opt.label);
        if (opt.id === 'resume') b.setCta();
        if (opt.destructive) markDestructive(b);
        b.onClick(() => {
          const id = opt.id;
          if (id === 'cancel') {
            this.close();
            return;
          }
          const question = confirmText(id);
          if (question !== null) {
            renderConfirm(
              this,
              question,
              opt.label,
              () => {
                this.close();
                this.deps.onChoice(id);
              },
              () => this.renderMain(),
            );
            return;
          }
          this.close();
          this.deps.onChoice(id);
        });
      });
    }
  }
}
