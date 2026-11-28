import { describe, expect, it } from 'vitest';
import { nextViewLevel } from './view-level.js';

describe('nextViewLevel', () => {
  it('steps Standard → Developer → Agent and back to Standard', () => {
    expect(nextViewLevel('off')).toBe('developer');
    expect(nextViewLevel('developer')).toBe('agent');
    expect(nextViewLevel('agent')).toBe('off');
  });
});
