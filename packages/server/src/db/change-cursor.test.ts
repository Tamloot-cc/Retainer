import { describe, expect, it } from 'vitest';
import { changeCursor, changePosition } from './change-cursor.js';

describe('workspace feed cursors', () => {
  it('preserves bigint positions without numeric rounding', () => {
    expect(changePosition('workspace-a', changeCursor('workspace-a', '9007199254740993'))).toBe(
      '9007199254740993',
    );
  });
  it('rejects another workspace, malformed values and unknown versions', () => {
    expect(() => changePosition('workspace-b', changeCursor('workspace-a', '1'))).toThrow(
      'this workspace',
    );
    for (const raw of [
      '',
      'not json',
      JSON.stringify({ v: 2, w: 'workspace-a', p: '1' }),
      JSON.stringify({ v: 1, w: 'workspace-a', p: '-1' }),
    ])
      expect(() => changePosition('workspace-a', Buffer.from(raw).toString('base64url'))).toThrow();
  });
});
