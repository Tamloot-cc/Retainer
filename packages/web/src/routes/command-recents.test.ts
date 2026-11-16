import type { Session } from '@retainer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecentCommands, recentCommandsKey, rememberCommand } from './command-recents.js';

beforeEach(() => sessionStorage.clear());
const session = (workspace: string, actor: string) =>
  ({
    workspace: { id: workspace },
    actor: { type: 'user', id: actor },
  }) as Session;

describe('command history', () => {
  it('isolates workspaces and people, stores only identifiers, deduplicates and bounds recents', () => {
    const key = recentCommandsKey(session('acme', 'dana'));
    for (let i = 0; i < 10; i++) rememberCommand(key, { kind: 'record', id: `r${i}` });
    rememberCommand(key, { kind: 'record', id: 'r7' });
    rememberCommand(key, { kind: 'object', id: 'person' });
    expect(readRecentCommands(key)).toEqual([
      { kind: 'object', id: 'person' },
      { kind: 'record', id: 'r7' },
      { kind: 'record', id: 'r9' },
      { kind: 'record', id: 'r8' },
      { kind: 'record', id: 'r6' },
      { kind: 'record', id: 'r5' },
    ]);
    expect(readRecentCommands(recentCommandsKey(session('other', 'dana')))).toEqual([]);
    expect(readRecentCommands(recentCommandsKey(session('acme', 'avi')))).toEqual([]);
  });
  it('tolerates corrupt or unavailable browser storage', () => {
    sessionStorage.setItem('recent', 'not json');
    expect(readRecentCommands('recent')).toEqual([]);
    sessionStorage.setItem('recent', JSON.stringify([null, {}, { kind: 'record', id: 3 }]));
    expect(readRecentCommands('recent')).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberCommand('recent', { kind: 'record', id: 'r1' })).not.toThrow();
    spy.mockRestore();
  });
});
