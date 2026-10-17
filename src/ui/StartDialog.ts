import { Modal, Setting, TFile, TFolder, moment } from 'obsidian';
import type { App } from 'obsidian';
import type { ScanStitchSettings } from '../types';
import { FolderSuggest, PdfSuggest } from './FolderSuggest';
import {
  buildInit,
  defaultDestination,
  folderName,
  normalizeDestination,
  pickTemplate,
  previewFilename,
  START_ERROR_TEXT,
  validateStart,
  type StartInit,
  type StartState,
} from './startLogic';

export type { StartInit } from './startLogic';

export interface StartDialogDeps {
  settings: ScanStitchSettings;
  onStart(init: StartInit): void;
}

export class StartDialog extends Modal {
  private appendMode = false;
  private destination = '';
  private templateName: string;
  private appendTarget = '';
  private showErrors = false;

  private folderSection!: HTMLElement;
  private appendSection!: HTMLElement;
  private recentEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private folderInput!: HTMLInputElement;
  private pdfInput!: HTMLInputElement;
  private startBtn!: HTMLButtonElement;
  private suggesters: { close(): void }[] = [];

  constructor(
    app: App,
    private readonly deps: StartDialogDeps,
  ) {
    super(app);
    const template = pickTemplate(deps.settings);
    this.templateName = template.name;
    this.destination = defaultDestination(deps.settings, template);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.addClass('scan-stitch-start');
    titleEl.setText('Start scanning');

    // Enter starts when valid, unless a button or select has focus (the suggestion
    // popover handles its own Enter first).
    this.scope.register([], 'Enter', (evt) => {
      const tag = (evt.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'SELECT') return true;
      this.submit();
      return false;
    });

    this.buildFolderSection(contentEl);
    this.buildAppendSection(contentEl);
    this.buildToggle(contentEl);

    this.errorEl = contentEl.createDiv({ cls: 'scan-stitch-error' });
    this.errorEl.setAttribute('role', 'alert');

    const actions = contentEl.createDiv({ cls: 'scan-stitch-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    this.startBtn = actions.createEl('button', { text: 'Start', cls: 'mod-cta' });
    this.startBtn.addEventListener('click', () => this.submit());

    this.refresh();
    // One keypress for the common path: a valid default focuses Start (Enter activates it),
    // and the suggester is not opened by programmatic focus.
    window.setTimeout(() => this.focusInitial(), 0);
  }

  private focusInitial(): void {
    if (this.isValid()) this.startBtn.focus();
    else this.folderInput.focus();
  }

  private isValid(): boolean {
    return validateStart(this.state(), this.isPdf) === null;
  }

  private readonly isPdf = (path: string): boolean => {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile && f.extension.toLowerCase() === 'pdf';
  };

  onClose(): void {
    for (const sg of this.suggesters) sg.close();
    this.suggesters = [];
    this.contentEl.empty();
  }

  private buildFolderSection(parent: HTMLElement): void {
    this.folderSection = parent.createDiv({ cls: 'scan-stitch-section' });
    const root = this.folderSection;

    const field = root.createDiv({ cls: 'scan-stitch-field' });
    const label = field.createEl('label', { text: 'Destination folder', cls: 'scan-stitch-label' });
    this.folderInput = field.createEl('input', {
      type: 'text',
      cls: 'scan-stitch-input',
      attr: { placeholder: 'Search for a folder', spellcheck: 'false' },
    });
    this.folderInput.id = 'scan-stitch-folder';
    label.htmlFor = this.folderInput.id;
    this.folderInput.value = this.destination;
    this.folderInput.addEventListener('input', () => {
      this.destination = this.folderInput.value;
      this.refresh();
    });
    this.suggesters.push(
      new FolderSuggest(this.app, this.folderInput, (path) => {
        this.destination = path;
        this.refresh();
      }),
    );

    this.recentEl = root.createDiv({ cls: 'scan-stitch-recent' });

    new Setting(root)
      .setName('Template')
      .setClass('scan-stitch-template-setting')
      .addDropdown((dd) => {
        const templates = this.deps.settings.templates;
        if (templates.length === 0) dd.addOption(this.templateName, this.templateName);
        for (const t of templates) dd.addOption(t.name, t.name);
        dd.setValue(this.templateName);
        dd.onChange((name) => {
          this.templateName = name;
          const stored = pickTemplate(this.deps.settings, name).folder;
          if (stored !== undefined && stored !== '') {
            this.destination = stored;
            this.folderInput.value = stored;
          }
          this.refresh();
        });
      });

    const preview = root.createDiv({ cls: 'scan-stitch-preview' });
    preview.createSpan({ text: 'File name', cls: 'scan-stitch-preview-label' });
    this.previewEl = preview.createSpan({ cls: 'scan-stitch-preview-name' });
    this.previewEl.setAttribute('aria-live', 'polite');
  }

  private buildAppendSection(parent: HTMLElement): void {
    this.appendSection = parent.createDiv({ cls: 'scan-stitch-section' });
    const field = this.appendSection.createDiv({ cls: 'scan-stitch-field' });
    const label = field.createEl('label', { text: 'PDF to append to', cls: 'scan-stitch-label' });
    this.pdfInput = field.createEl('input', {
      type: 'text',
      cls: 'scan-stitch-input',
      attr: { placeholder: 'Search for a PDF', spellcheck: 'false' },
    });
    this.pdfInput.id = 'scan-stitch-pdf';
    label.htmlFor = this.pdfInput.id;
    this.pdfInput.addEventListener('input', () => {
      this.appendTarget = this.pdfInput.value;
      this.refresh();
    });
    this.suggesters.push(
      new PdfSuggest(this.app, this.pdfInput, (path) => {
        this.appendTarget = path;
        this.refresh();
      }),
    );
  }

  private buildToggle(parent: HTMLElement): void {
    new Setting(parent)
      .setName('Append to existing PDF')
      .setDesc('Add the new pages after the pages of a PDF already in your vault.')
      .setClass('scan-stitch-append-setting')
      .addToggle((t) =>
        t.setValue(this.appendMode).onChange((v) => {
          this.appendMode = v;
          this.refresh();
          window.setTimeout(() => (v ? this.pdfInput : this.folderInput).focus(), 0);
        }),
      );
  }

  private state(): StartState {
    return {
      watchRoot: this.deps.settings.watchRoot,
      appendMode: this.appendMode,
      destination: normalizeDestination(this.destination),
      templateName: this.templateName,
      filename: this.currentFilename(),
      appendTarget: this.appendTarget,
    };
  }

  private currentFilename(): string {
    const template = pickTemplate(this.deps.settings, this.templateName);
    const dest = normalizeDestination(this.destination);
    const found = dest === '/' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(dest);
    const folder = found instanceof TFolder ? found : null;
    const existing = folder ? folder.children.map((c) => c.name) : [];
    return previewFilename(template.pattern, {
      now: new Date(),
      folder: folderName(dest),
      existingNames: existing,
      format: (d, fmt) => moment(d).format(fmt),
    });
  }

  private refresh(): void {
    this.folderSection.toggleClass('scan-stitch-hidden', this.appendMode);
    this.appendSection.toggleClass('scan-stitch-hidden', !this.appendMode);

    this.previewEl.setText(this.currentFilename() + '.pdf');
    this.renderRecents();

    const err = validateStart(this.state(), this.isPdf);
    const message = this.showErrors && err ? START_ERROR_TEXT[err] : '';
    this.errorEl.setText(message);
    this.errorEl.toggleClass('scan-stitch-hidden', message === '');
  }

  private renderRecents(): void {
    this.recentEl.empty();
    const recents = this.deps.settings.recentLocations;
    this.recentEl.toggleClass('scan-stitch-hidden', recents.length === 0);
    if (recents.length === 0) return;
    this.recentEl.createSpan({ text: 'Recent', cls: 'scan-stitch-recent-label' });
    const list = this.recentEl.createDiv({ cls: 'scan-stitch-chips' });
    for (const path of recents) {
      const canonical = path === '' ? '/' : normalizeDestination(path);
      const selected = canonical === normalizeDestination(this.destination);
      const chip = list.createEl('button', { text: canonical, cls: 'scan-stitch-chip' });
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(selected));
      chip.toggleClass('is-selected', selected);
      chip.addEventListener('click', () => {
        this.destination = canonical;
        this.folderInput.value = canonical;
        this.refresh();
        if (this.isValid()) this.startBtn.focus();
        else this.folderInput.focus();
      });
    }
  }

  private submit(): void {
    this.showErrors = true;
    const init = buildInit(this.state(), this.isPdf);
    if (!init) {
      this.refresh();
      return;
    }
    this.close();
    this.deps.onStart(init);
  }
}
