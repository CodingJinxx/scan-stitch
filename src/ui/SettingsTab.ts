import * as fs from 'fs';
import { Notice, PluginSettingTab, Setting, moment } from 'obsidian';
import type { App } from 'obsidian';
import { findUnknownPlaceholders } from '../core/template';
import type ScanStitchPlugin from '../main';
import { FolderSuggest } from './FolderSuggest';
import {
  addTemplate,
  deleteTemplate,
  describePlaceholders,
  parseBoundedInt,
  patternsFromToggles,
  selectedDirFromFile,
  TEMPLATE_ERROR_TEXT,
  togglesFromPatterns,
  updateTemplate,
  validateTemplate,
  type PatternToggles,
} from './settingsLogic';
import { previewFilename } from './startLogic';

interface Editing {
  /** Name of the template being edited, or null for a new one. */
  original: string | null;
  name: string;
  pattern: string;
  folder: string;
}

function folderExists(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort absolute path of a File chosen in the renderer. */
function filePath(file: File): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is only reachable through require
    const electron = require('electron') as { webUtils?: { getPathForFile(f: File): string } };
    const p = electron.webUtils?.getPathForFile(file);
    if (p) return p;
  } catch {
    // fall through to the legacy property
  }
  return (file as File & { path?: string }).path ?? '';
}

export class ScanStitchSettingTab extends PluginSettingTab {
  private editing: Editing | null = null;
  private suggesters: { close(): void }[] = [];

  constructor(
    app: App,
    private readonly plugin: ScanStitchPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.closeSuggesters();
    const { containerEl } = this;
    containerEl.empty();
    this.buildFolder(containerEl);
    this.buildFileTypes(containerEl);
    this.buildStability(containerEl);
    this.buildTemplates(containerEl);
    this.buildRecents(containerEl);
  }

  hide(): void {
    this.editing = null;
    this.closeSuggesters();
    this.containerEl.empty();
  }

  private closeSuggesters(): void {
    for (const s of this.suggesters) s.close();
    this.suggesters = [];
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  // --- Scanner folder -------------------------------------------------------------

  private buildFolder(el: HTMLElement): void {
    new Setting(el).setName('Scanner folder').setHeading();
    const settings = this.plugin.settings;

    const watch = new Setting(el).setName('Watch folder');
    const statusEl = watch.descEl.createDiv({ cls: 'scan-stitch-status' });
    watch.descEl.createDiv({ text: 'Absolute path of the folder your scanner saves into.' });
    let input!: HTMLInputElement;
    const showStatus = (path: string): void => {
      statusEl.removeClass('is-ok', 'is-bad');
      if (path === '') {
        statusEl.setText('');
        return;
      }
      const ok = folderExists(path);
      statusEl.setText(ok ? 'Folder found' : 'Folder not found');
      statusEl.addClass(ok ? 'is-ok' : 'is-bad');
    };
    const commit = async (raw: string): Promise<void> => {
      const path = raw.trim();
      input.value = path;
      showStatus(path);
      if (path === settings.watchRoot) return;
      settings.watchRoot = path;
      await this.save();
    };
    watch.addText((t) => {
      input = t.inputEl;
      t.setPlaceholder('Path to the scanner folder').setValue(settings.watchRoot);
      t.inputEl.spellcheck = false;
      t.inputEl.addEventListener('input', () => showStatus(t.inputEl.value.trim()));
      t.inputEl.addEventListener('change', () => void commit(t.inputEl.value));
    });
    watch.addButton((b) =>
      b.setButtonText('Browse').onClick(() => {
        this.browse((path) => {
          input.value = path;
          void commit(path);
        });
      }),
    );
    showStatus(settings.watchRoot.trim());

    new Setting(el)
      .setName('Include subfolders')
      .setDesc('Also watch folders inside the watch folder, including ones created during a session. Applies from the next scan session.')
      .addToggle((t) =>
        t.setValue(settings.includeSubfolders).onChange(async (v) => {
          settings.includeSubfolders = v;
          await this.save();
        }),
      );
  }

  private browse(onPick: (path: string) => void): void {
    const picker = createEl('input', { type: 'file' });
    picker.setAttribute('webkitdirectory', '');
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      const full = file ? filePath(file) : '';
      if (!file || full === '') {
        new Notice('Type the folder path instead');
        return;
      }
      onPick(selectedDirFromFile(full, file.webkitRelativePath));
    });
    picker.click();
  }

  // --- File types -----------------------------------------------------------------

  private buildFileTypes(el: HTMLElement): void {
    new Setting(el).setName('File types').setHeading();
    const settings = this.plugin.settings;
    const toggles = togglesFromPatterns(settings.patterns);

    const add = (key: keyof PatternToggles, name: string, desc: string): void => {
      let toggle: { setValue(v: boolean): unknown } | null = null;
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => {
          toggle = t;
          t.setValue(toggles[key]).onChange(async (v) => {
            const next = { ...toggles, [key]: v };
            if (!next.pdf && !next.jpeg && !next.png) {
              // At least one type must stay on.
              toggle?.setValue(true);
              new Notice('At least one file type must stay enabled');
              return;
            }
            toggles[key] = v;
            settings.patterns = patternsFromToggles(toggles);
            await this.save();
          });
        });
    };
    const later = ' Applies from the next scan session.';
    add('pdf', 'PDF files', `Files matching *.pdf.${later}`);
    add('jpeg', 'JPEG images', `Files matching *.jpg and *.jpeg, embedded as full pages.${later}`);
    add('png', 'PNG images', `Files matching *.png, embedded as full pages.${later}`);
  }

  // --- Detecting new scans --------------------------------------------------------

  private buildStability(el: HTMLElement): void {
    new Setting(el).setName('Detecting new scans').setHeading();
    const settings = this.plugin.settings;

    const numeric = (
      name: string,
      desc: string,
      min: number,
      max: number,
      get: () => number,
      set: (n: number) => void,
    ): void => {
      const s = new Setting(el).setName(name).setDesc(desc);
      const msg = s.descEl.createDiv({ cls: 'scan-stitch-status is-bad' });
      s.addText((t) => {
        t.setValue(String(get()));
        t.inputEl.inputMode = 'numeric';
        t.inputEl.addEventListener('change', () => {
          const r = parseBoundedInt(t.inputEl.value, min, max);
          if (r.ok) {
            msg.setText('');
            set(r.value);
            t.inputEl.value = String(r.value);
            void this.save();
          } else {
            msg.setText(`Enter a whole number from ${min} to ${max}`);
            t.inputEl.value = String(get());
          }
        });
      });
    };
    numeric(
      'Stability delay (ms)',
      'How long a new file must stay unchanged before it counts. Applies from the next scan session.',
      100,
      30000,
      () => settings.stabilityDelayMs,
      (n) => {
        settings.stabilityDelayMs = n;
      },
    );
    numeric(
      'Stability retries',
      'How many times to re-check a file that is still being written. Applies from the next scan session.',
      1,
      20,
      () => settings.stabilityRetries,
      (n) => {
        settings.stabilityRetries = n;
      },
    );
  }

  // --- Filename templates ---------------------------------------------------------

  private buildTemplates(el: HTMLElement): void {
    new Setting(el).setName('Filename templates').setHeading();
    const settings = this.plugin.settings;

    const help = el.createEl('details', { cls: 'scan-stitch-help' });
    help.createEl('summary', { text: 'Supported placeholders' });
    const list = help.createEl('ul');
    for (const p of describePlaceholders()) {
      const li = list.createEl('li');
      li.createEl('code', { text: p.token });
      li.appendText(` ${p.description}`);
    }

    for (const t of settings.templates) {
      if (this.editing?.original === t.name) continue;
      const isDefault = t.name === settings.defaultTemplate;
      const row = new Setting(el)
        .setName(isDefault ? `${t.name} (default)` : t.name)
        .setDesc(t.folder ? `${t.pattern}  \u2192  ${t.folder}` : t.pattern);
      if (!isDefault) {
        row.addExtraButton((b) =>
          b
            .setIcon('star')
            .setTooltip('Set as default')
            .onClick(async () => {
              settings.defaultTemplate = t.name;
              await this.save();
              this.display();
            }),
        );
      }
      row.addExtraButton((b) =>
        b
          .setIcon('pencil')
          .setTooltip('Edit')
          .onClick(() => {
            if (this.editing) return;
            this.editing = { original: t.name, name: t.name, pattern: t.pattern, folder: t.folder ?? '' };
            this.display();
          }),
      );
      row.addExtraButton((b) => {
        b.setIcon('trash')
          .setTooltip(settings.templates.length <= 1 ? 'The last template cannot be deleted' : 'Delete')
          .onClick(async () => {
            if (!deleteTemplate(settings, t.name)) return;
            await this.save();
            this.display();
          });
        if (settings.templates.length <= 1) b.setDisabled(true);
      });
    }

    if (this.editing) {
      this.buildEditor(el, this.editing);
    } else {
      new Setting(el).addButton((b) =>
        b.setButtonText('Add template').onClick(() => {
          this.editing = { original: null, name: '', pattern: 'Scan {date} {time}', folder: '' };
          this.display();
        }),
      );
    }
  }

  private buildEditor(el: HTMLElement, ed: Editing): void {
    const settings = this.plugin.settings;
    const form = el.createDiv({ cls: 'scan-stitch-template-form' });

    const warnEl = form.createDiv({ cls: 'scan-stitch-warning' });
    const previewEl = form.createDiv({ cls: 'scan-stitch-preview' });
    const errorEl = form.createDiv({ cls: 'scan-stitch-error' });
    errorEl.setAttribute('role', 'alert');

    const refresh = (showError: boolean): void => {
      const unknown = findUnknownPlaceholders(ed.pattern);
      warnEl.setText(unknown.map((u) => `Unknown placeholder: {${u}}`).join('\n'));
      const folderName = ed.folder.trim().split('/').filter(Boolean).pop() ?? '';
      const preview = previewFilename(ed.pattern, {
        now: new Date(),
        folder: folderName,
        existingNames: [],
        format: (d, fmt) => moment(d).format(fmt),
      });
      previewEl.setText(`Preview: ${preview}.pdf`);
      const err = validateTemplate(settings.templates, ed, ed.original ?? undefined);
      errorEl.setText(showError && err ? TEMPLATE_ERROR_TEXT[err] : '');
    };

    new Setting(form).setName('Name').addText((t) =>
      t.setValue(ed.name).onChange((v) => {
        ed.name = v;
        refresh(false);
      }),
    );
    new Setting(form).setName('Pattern').addText((t) => {
      t.setValue(ed.pattern).onChange((v) => {
        ed.pattern = v;
        refresh(false);
      });
      t.inputEl.spellcheck = false;
    });
    new Setting(form)
      .setName('Destination folder')
      .setDesc('Optional. Preselected in the start dialog when this template is used.')
      .addText((t) => {
        t.setPlaceholder('Search for a folder').setValue(ed.folder).onChange((v) => {
          ed.folder = v;
          refresh(false);
        });
        this.suggesters.push(
          new FolderSuggest(this.app, t.inputEl, (path) => {
            ed.folder = path;
            refresh(false);
          }),
        );
      });

    new Setting(form)
      .addButton((b) =>
        b.setButtonText('Cancel').onClick(() => {
          this.editing = null;
          this.display();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText('Save template')
          .setCta()
          .onClick(async () => {
            const err = validateTemplate(settings.templates, ed, ed.original ?? undefined);
            if (err) {
              refresh(true);
              return;
            }
            if (ed.original === null) addTemplate(settings, ed);
            else updateTemplate(settings, ed.original, ed);
            this.editing = null;
            await this.save();
            this.display();
          }),
      );

    refresh(false);
  }

  // --- Recent locations -----------------------------------------------------------

  private buildRecents(el: HTMLElement): void {
    new Setting(el).setName('Recent locations').setHeading();
    const settings = this.plugin.settings;
    const n = settings.recentLocations.length;
    new Setting(el)
      .setName('Recent destination folders')
      .setDesc(n === 1 ? '1 location stored' : `${n} locations stored`)
      .addButton((b) =>
        b
          .setButtonText('Clear')
          .setDisabled(n === 0)
          .onClick(async () => {
            settings.recentLocations = [];
            await this.save();
            this.display();
          }),
      );
  }
}
