import { describe, expect, it } from 'vitest';
import { chatContext, datePart, workspaceDate } from './context.js';

describe('the chat context', () => {
  it('dates in the workspace time zone, falling back to UTC', () => {
    const now = new Date('2026-11-26T23:30:00Z');
    expect(workspaceDate(now, 'Asia/Jerusalem')).toMatchObject({
      day: '2026-11-27',
      zone: 'Asia/Jerusalem',
    });
    expect(workspaceDate(now, undefined)).toMatchObject({ day: '2026-11-26', zone: 'UTC' });
    expect(workspaceDate(now, 'Not/AZone')).toMatchObject({ day: '2026-11-26', zone: 'UTC' });
    expect(datePart(workspaceDate(now, 'UTC'))).toBe('Today is Thursday, 26 November 2026 (UTC).');
  });

  it('names the person, workspace, objects and date, and nothing per request', () => {
    const date = workspaceDate(new Date('2026-11-26T10:00:00Z'), 'UTC');
    const text = chatContext({
      ownerName: 'Maya Cohen',
      personal: true,
      workspaceName: 'Acme Sales',
      objects: ['person', 'company'],
      eventTypes: [],
      date,
    });
    expect(text).toContain('You work for Maya Cohen, whose personal memory is "me".');
    expect(text).toContain('Workspace: Acme Sales.');
    expect(text).toContain('Objects: person, company. Event types: none yet.');
    expect(text).toContain('Today is Thursday, 26 November 2026 (UTC).');
    expect(
      chatContext({
        ownerName: 'Maya Cohen',
        personal: true,
        workspaceName: 'Acme Sales',
        objects: ['person', 'company'],
        eventTypes: [],
        date,
      }),
    ).toBe(text);
  });
});
