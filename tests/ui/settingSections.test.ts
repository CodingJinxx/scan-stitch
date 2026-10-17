import { describe, expect, it, vi } from 'vitest';
import type { Setting } from 'obsidian';
import { BLOCK_HOST_CLASS, renderSections, toDefinitions, type SettingSection } from '../../src/ui/settingSections';

// Local shapes for reading the definitions back; the obsidian 1.13 types are
// flagged by the minAppVersion lint rule even in tests.
interface Def {
  name: string;
  desc?: string;
  aliases?: string[];
  searchable?: boolean;
  render(setting: Setting, group: unknown): unknown;
}
interface Group {
  type: string;
  heading?: string;
  items?: Def[];
}
const groups = (s: SettingSection[]): Group[] => toDefinitions(s) as unknown as Group[];

interface FakeEl {
  empty: ReturnType<typeof vi.fn>;
  addClass: ReturnType<typeof vi.fn>;
}

function fakeSetting(): { setting: Setting; settingEl: FakeEl; heading: string[] } {
  const settingEl: FakeEl = { empty: vi.fn(), addClass: vi.fn() };
  const heading: string[] = [];
  const setting = {
    settingEl,
    setName(n: string) {
      heading.push(n);
      return this;
    },
    setHeading() {
      heading.push('<heading>');
      return this;
    },
  } as unknown as Setting;
  return { setting, settingEl, heading };
}

function sample(log: string[]): SettingSection[] {
  return [
    {
      heading: 'Scanner folder',
      items: [
        {
          kind: 'row',
          name: 'Watch folder',
          desc: 'Absolute path.',
          aliases: ['scanner folder'],
          render: () => {
            log.push('render watch');
          },
        },
      ],
    },
    {
      heading: 'Filename templates',
      items: [
        {
          kind: 'block',
          name: 'Supported placeholders',
          build: (parent) => {
            log.push(`build help in ${parent === undefined ? '?' : 'parent'}`);
            return () => log.push('cleanup help');
          },
        },
        {
          kind: 'row',
          name: 'Add template',
          searchable: false,
          render: () => {
            log.push('render add');
          },
        },
      ],
    },
  ];
}

describe('toDefinitions', () => {
  it('maps each section to a group with its heading and one definition per item', () => {
    const defs = groups(sample([]));
    expect(defs.map((d) => [d.type, d.heading, d.items?.length])).toEqual([
      ['group', 'Scanner folder', 1],
      ['group', 'Filename templates', 2],
    ]);
  });

  it('copies name, description and aliases for search, and omits what is not set', () => {
    const defs = groups(sample([]));
    const watch = defs[0].items?.[0] as Def;
    expect(watch.name).toBe('Watch folder');
    expect(watch.desc).toBe('Absolute path.');
    expect(watch.aliases).toEqual(['scanner folder']);
    expect('searchable' in watch).toBe(false);
    const add = defs[1].items?.[1] as Def;
    expect(add.searchable).toBe(false);
    expect('desc' in add).toBe(false);
  });

  it('delegates a row render to the item with the Setting it is given', () => {
    const log: string[] = [];
    const defs = groups(sample(log));
    const watch = defs[0].items?.[0] as Def;
    const { setting } = fakeSetting();
    watch.render(setting, undefined);
    expect(log).toEqual(['render watch']);
  });

  it('hosts a block in an emptied row element, keeps it out of search, and passes its cleanup on', () => {
    const log: string[] = [];
    const defs = groups(sample(log));
    const help = defs[1].items?.[0] as Def;
    expect(help.searchable).toBe(false);
    const { setting, settingEl } = fakeSetting();
    const cleanup = help.render(setting, undefined);
    expect(settingEl.empty).toHaveBeenCalledOnce();
    expect(settingEl.addClass).toHaveBeenCalledWith(BLOCK_HOST_CLASS);
    expect(log).toEqual(['build help in parent']);
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();
    expect(log).toEqual(['build help in parent', 'cleanup help']);
  });
});

describe('renderSections', () => {
  it('renders headings, rows and blocks in order into the container', () => {
    const log: string[] = [];
    const headings: string[] = [];
    const container = {} as HTMLElement;
    const made: unknown[] = [];
    renderSections(container, sample(log), (parent) => {
      made.push(parent);
      const f = fakeSetting();
      f.heading.push = (...n: string[]) => headings.push(...n);
      return f.setting;
    });
    expect(headings).toEqual(['Scanner folder', '<heading>', 'Filename templates', '<heading>']);
    expect(log).toEqual(['render watch', 'build help in parent', 'render add']);
    // Two headings plus two rows; the block builds straight into the container.
    expect(made).toHaveLength(4);
    expect(made.every((p) => p === container)).toBe(true);
  });
});
