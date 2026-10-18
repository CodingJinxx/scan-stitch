import * as fs from 'fs';
import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';
import { findUnknownPlaceholders } from '../core/template';
import type ScanStitchPlugin from '../main';
import { formatDate } from './dateFormat';
import { FolderSuggest } from './FolderSuggest';
import { renderSections, toDefinitions, type SectionItem, type SettingRow, type SettingSection } from './settingSections';
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
  /** Set once Obsidian (1.13+) asks for definitions: it then renders them and never calls display(). */
  private declarative = false;

  constructor(
    app: App,
    private readonly plugin: ScanStitchPlugin,
  ) {
    super(app, plugin);
  }

  /** Obsidian 1.13+: rendered from these definitions and indexed for the settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    this.declarative = true;
    return toDefinitions(this.sections());
  }

  /** Obsidian < 1.13: the same sections, drawn imperatively. */
  display(): void {
    this.renderImperative();
  }

  hide(): void {
    this.editing = null;
    this.closeSuggesters();
    super.hide();
    this.containerEl.empty();
  }

  /** Redraws after a structural change (template added, edited or removed, recents cleared). */
  private rerender(): void {
    // update() exists from 1.13, the only versions that call getSettingDefinitions().
    const tab = this as unknown as { update?: () => void };
    if (this.declarative && typeof tab.update === 'function') tab.update();
    else this.renderImperative();
  }

  private renderImperative(): void {
    this.closeSuggesters();
    const { containerEl } = this;
    containerEl.empty();
    renderSections(containerEl, this.sections(), (parent) => new Setting(parent));
  }

  private sections(): SettingSection[] {
    return [
      { heading: 'Scanner folder', items: this.folderItems() },
      { heading: 'File types', items: this.fileTypeItems() },
      { heading: 'Detecting new scans', items: this.stabilityItems() },
      { heading: 'Filename templates', items: this.templateItems() },
      { heading: 'Recent locations', items: this.recentItems() },
    ];
  }

  private closeSuggesters(): void {
    for (const s of this.suggesters) s.close();
    this.suggesters = [];
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  // --- Scanner folder -------------------------------------------------------------

  private folderItems(): SectionItem[] {
    const settings = this.plugin.settings;
    const watchDesc = 'Absolute path of the folder your scanner saves into.';
    const subfolderDesc =
      'Also watch folders inside the watch folder, including ones created during a session. Applies from the next scan session.';
    return [
      {
        kind: 'row',
        name: 'Watch folder',
        desc: watchDesc,
        aliases: ['scanner folder'],
        render: (watch) => {
          watch.setName('Watch folder');
          watch.descEl.empty();
          const statusEl = watch.descEl.createDiv({ cls: 'scan-stitch-status' });
          watch.descEl.createDiv({ text: watchDesc });
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
        },
      },
      {
        kind: 'row',
        name: 'Include subfolders',
        desc: subfolderDesc,
        aliases: ['scanner folder'],
        render: (s) => {
          s.setName('Include subfolders')
            .setDesc(subfolderDesc)
            .addToggle((t) =>
              t.setValue(settings.includeSubfolders).onChange(async (v) => {
                settings.includeSubfolders = v;
                await this.save();
              }),
            );
        },
      },
    ];
  }

  private browse(onPick: (path: string) => void): void {
    // Preferred: the native folder dialog. It also works for empty folders, which an <input> picker cannot select.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is only reachable through require
      const electron = require('electron') as {
        remote?: { dialog?: { showOpenDialog(o: object): Promise<{ canceled: boolean; filePaths: string[] }> } };
      };
      const dialog = electron.remote?.dialog;
      if (dialog) {
        void dialog.showOpenDialog({ properties: ['openDirectory'] }).then((r) => {
          if (!r.canceled && r.filePaths[0]) onPick(r.filePaths[0]);
        });
        return;
      }
    } catch {
      // fall back to the input picker
    }
    const picker = createEl('input', { type: 'file' });
    picker.setAttribute('webkitdirectory', '');
    picker.addClass('scan-stitch-hidden-picker');
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      const full = file ? filePath(file) : '';
      picker.remove();
      if (!file || full === '') {
        new Notice('Could not read the folder (it may be empty). Type the folder path instead.');
        return;
      }
      onPick(selectedDirFromFile(full, file.webkitRelativePath));
    });
    // Attached to the DOM so the click is honoured on every Obsidian build.
    document.body.appendChild(picker);
    picker.click();
  }

  // --- File types -----------------------------------------------------------------

  private fileTypeItems(): SectionItem[] {
    const settings = this.plugin.settings;
    const toggles = togglesFromPatterns(settings.patterns);

    const item = (key: keyof PatternToggles, name: string, desc: string): SettingRow => ({
      kind: 'row',
      name,
      desc,
      aliases: ['file types'],
      render: (s) => {
        let toggle: { setValue(v: boolean): unknown } | null = null;
        s.setName(name)
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
      },
    });
    const later = ' Applies from the next scan session.';
    return [
      item('pdf', 'PDF files', `Files matching *.pdf.${later}`),
      item('jpeg', 'JPEG images', `Files matching *.jpg and *.jpeg, embedded as full pages.${later}`),
      item('png', 'PNG images', `Files matching *.png, embedded as full pages.${later}`),
    ];
  }

  // --- Detecting new scans --------------------------------------------------------

  private stabilityItems(): SectionItem[] {
    const settings = this.plugin.settings;

    const numeric = (
      name: string,
      desc: string,
      min: number,
      max: number,
      get: () => number,
      set: (n: number) => void,
    ): SettingRow => ({
      kind: 'row',
      name,
      desc,
      aliases: ['detecting new scans'],
      render: (row) => {
        const s = row.setName(name).setDesc(desc);
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
      },
    });
    return [
      numeric(
        'Stability delay (ms)',
        'How long a new file must stay unchanged before it counts. Applies from the next scan session.',
        100,
        30000,
        () => settings.stabilityDelayMs,
        (n) => {
          settings.stabilityDelayMs = n;
        },
      ),
      numeric(
        'Stability retries',
        'How many times to re-check a file that is still being written. Applies from the next scan session.',
        1,
        20,
        () => settings.stabilityRetries,
        (n) => {
          settings.stabilityRetries = n;
        },
      ),
    ];
  }

  // --- Filename templates ---------------------------------------------------------

  private templateItems(): SectionItem[] {
    const settings = this.plugin.settings;
    const items: SectionItem[] = [
      {
        kind: 'block',
        name: 'Supported placeholders',
        build: (el) => {
          const help = el.createEl('details', { cls: 'scan-stitch-help' });
          help.createEl('summary', { text: 'Supported placeholders' });
          const list = help.createEl('ul');
          for (const p of describePlaceholders()) {
            const li = list.createEl('li');
            li.createEl('code', { text: p.token });
            li.appendText(` ${p.description}`);
          }
        },
      },
    ];

    for (const t of settings.templates) {
      if (this.editing?.original === t.name) continue;
      const isDefault = t.name === settings.defaultTemplate;
      const name = isDefault ? `${t.name} (default)` : t.name;
      const desc = t.folder ? `${t.pattern}  \u2192  ${t.folder}` : t.pattern;
      items.push({
        kind: 'row',
        name,
        desc,
        aliases: ['filename templates'],
        render: (row) => {
          row.setName(name).setDesc(desc);
          if (!isDefault) {
            row.addExtraButton((b) =>
              b
                .setIcon('star')
                .setTooltip('Set as default')
                .onClick(async () => {
                  settings.defaultTemplate = t.name;
                  await this.save();
                  this.rerender();
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
                this.rerender();
              }),
          );
          row.addExtraButton((b) => {
            b.setIcon('trash')
              .setTooltip(settings.templates.length <= 1 ? 'The last template cannot be deleted' : 'Delete')
              .onClick(async () => {
                if (!deleteTemplate(settings, t.name)) return;
                await this.save();
                this.rerender();
              });
            if (settings.templates.length <= 1) b.setDisabled(true);
          });
        },
      });
    }

    const editing = this.editing;
    if (editing) {
      items.push({
        kind: 'block',
        name: 'Edit template',
        build: (el) => {
          this.buildEditor(el, editing);
          return () => this.closeSuggesters();
        },
      });
    } else {
      items.push({
        kind: 'row',
        name: 'Add template',
        aliases: ['filename templates'],
        render: (row) => {
          row.setName('').addButton((b) =>
            b.setButtonText('Add template').onClick(() => {
              this.editing = { original: null, name: '', pattern: 'Scan {date} {time}', folder: '' };
              this.rerender();
            }),
          );
        },
      });
    }
    return items;
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
        format: formatDate,
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
          this.rerender();
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
            this.rerender();
          }),
      );

    refresh(false);
  }

  // --- Recent locations -----------------------------------------------------------

  private recentItems(): SectionItem[] {
    const settings = this.plugin.settings;
    const n = settings.recentLocations.length;
    const desc = n === 1 ? '1 location stored' : `${n} locations stored`;
    return [
      {
        kind: 'row',
        name: 'Recent destination folders',
        desc,
        aliases: ['recent locations'],
        render: (row) => {
          row
            .setName('Recent destination folders')
            .setDesc(desc)
            .addButton((b) =>
              b
                .setButtonText('Clear')
                .setDisabled(n === 0)
                .onClick(async () => {
                  settings.recentLocations = [];
                  await this.save();
                  this.rerender();
                }),
            );
        },
      },
    ];
  }
}
