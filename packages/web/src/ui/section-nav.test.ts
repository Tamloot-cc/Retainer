import { describe, expect, it } from 'vitest';
import { activeSections } from './section-nav.js';

const ids = ['a', 'b', 'c', 'd'];

describe('activeSections', () => {
  it('marks every section whose heading is in view, in page order', () => {
    expect(activeSections(ids, new Set(['c', 'b']), () => 'a')).toEqual(['b', 'c']);
  });
  it('falls back to the last heading above the middle when none is in view', () => {
    expect(activeSections(ids, new Set(), () => 'b')).toEqual(['b']);
  });
  it('marks the first section at the very top of the page', () => {
    expect(activeSections(ids, new Set(), () => undefined)).toEqual(['a']);
  });
});
