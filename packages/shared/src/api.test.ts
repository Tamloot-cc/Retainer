import { expect, it } from 'vitest';
import { aggregateOps } from './api.js';

it('allows distinct counts on money fields', () => {
  expect(aggregateOps({ type: 'money', settings: {} })).toContain('countUnique');
});
