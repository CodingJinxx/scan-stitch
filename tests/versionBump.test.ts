import { describe, it, expect } from 'vitest';
import { updateVersions } from '../version-bump.mjs';

type Versions = Record<string, string>;
const update = updateVersions as (v: Versions, target: string, min: string) => Versions;

describe('updateVersions', () => {
  it('records the first release', () => {
    expect(update({}, '1.0.0', '1.5.0')).toEqual({ '1.0.0': '1.5.0' });
  });

  it('does not add an entry when minAppVersion is unchanged', () => {
    const v = { '1.0.0': '1.5.0' };
    expect(update(v, '1.0.1', '1.5.0')).toBe(v);
  });

  it('adds an entry when minAppVersion is raised', () => {
    expect(update({ '1.0.0': '1.5.0' }, '1.1.0', '1.6.0')).toEqual({ '1.0.0': '1.5.0', '1.1.0': '1.6.0' });
  });

  it('records a change back to a previously used minAppVersion', () => {
    const v = { '1.0.0': '1.5.0', '1.1.0': '1.6.0' };
    expect(update(v, '2.0.0', '1.5.0')).toEqual({ ...v, '2.0.0': '1.5.0' });
  });
});
