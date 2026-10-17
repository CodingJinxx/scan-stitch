import type { Setting, SettingDefinitionItem, SettingDefinitionRender } from 'obsidian';

/**
 * The settings tab is described once as sections of items and drawn two ways:
 * imperatively by `display()` on Obsidian < 1.13 (`renderSections`), and as
 * declarative definitions on 1.13+ (`toDefinitions`), where Obsidian renders
 * the tab itself and indexes it for the settings search. Both call the same
 * item functions, so the two paths cannot drift apart.
 */

type Cleanup = void | (() => void);

/** One Setting row. `render` sets the row's own name and description. */
export interface SettingRow {
  kind: 'row';
  /** Name for the settings search (1.13+). */
  name: string;
  /** Description for the settings search (1.13+). */
  desc?: string;
  /** Extra search terms (1.13+). */
  aliases?: string[];
  searchable?: boolean;
  render(setting: Setting): Cleanup;
}

/** Free-form content that is not a Setting row (help text, the template editor). */
export interface SettingBlock {
  kind: 'block';
  name: string;
  aliases?: string[];
  /** Defaults to false: a block has no row name for the search to point at. */
  searchable?: boolean;
  build(parent: HTMLElement): Cleanup;
}

export type SectionItem = SettingRow | SettingBlock;

export interface SettingSection {
  heading: string;
  items: SectionItem[];
}

/** Class on a declarative row that hosts a block instead of its own name and control. */
export const BLOCK_HOST_CLASS = 'scan-stitch-block';

function toDefinition(item: SectionItem): SettingDefinitionRender {
  const meta = {
    name: item.name,
    ...(item.kind === 'row' && item.desc !== undefined ? { desc: item.desc } : {}),
    ...(item.aliases ? { aliases: item.aliases } : {}),
  };
  if (item.kind === 'row') {
    return {
      ...meta,
      ...(item.searchable !== undefined ? { searchable: item.searchable } : {}),
      render: (setting) => item.render(setting),
    };
  }
  return {
    ...meta,
    searchable: item.searchable ?? false,
    render: (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass(BLOCK_HOST_CLASS);
      return item.build(setting.settingEl);
    },
  };
}

/** Declarative definitions for Obsidian 1.13+ (`getSettingDefinitions`). */
export function toDefinitions(sections: SettingSection[]): SettingDefinitionItem[] {
  return sections.map((section) => ({
    type: 'group' as const,
    heading: section.heading,
    items: section.items.map(toDefinition),
  }));
}

/** Imperative rendering for Obsidian < 1.13 (`display`). */
export function renderSections(
  containerEl: HTMLElement,
  sections: SettingSection[],
  newSetting: (parent: HTMLElement) => Setting,
): void {
  for (const section of sections) {
    newSetting(containerEl).setName(section.heading).setHeading();
    for (const item of section.items) {
      if (item.kind === 'row') item.render(newSetting(containerEl));
      else item.build(containerEl);
    }
  }
}
