/**
 * What varies per chat goes in its first user message, never in the system
 * prompt, so the cached prefix stays the same for every chat (agent spec
 * §3.5): who the agent works for, the workspace, its objects and today's
 * date. A later turn on a new date gets a short "Today is …" part, appended
 * to its message. Both are server-added parts: the model reads them, the
 * person never sees them.
 */

/** A date as the workspace reads it (YYYY-MM-DD and words), in its time zone or UTC. */
export function workspaceDate(now: Date, timeZone: string | undefined) {
  let zone = timeZone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  const words = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  return { day, words, zone };
}

export function datePart(date: { words: string; zone: string }): string {
  return `Today is ${date.words} (${date.zone}).`;
}

export function chatContext(input: {
  ownerName: string;
  personal: boolean;
  workspaceName: string;
  objects: string[];
  eventTypes: string[];
  client?: 'web' | 'cli' | 'task' | null;
  date: { words: string; zone: string };
}): string {
  const list = (names: string[]) => (names.length ? names.join(', ') : 'none yet');
  return [
    'Context for this chat, added by Retainer (not written by the person):',
    `- You work for ${input.ownerName || 'this workspace'}${input.personal ? ', whose personal memory is "me"' : ''}.`,
    `- Workspace: ${input.workspaceName}.`,
    `- Objects: ${list(input.objects)}. Event types: ${list(input.eventTypes)}.`,
    `- ${datePart(input.date)}`,
    ...(input.client === 'web'
      ? [
          '- This chat is in Retainer’s web app, which can show dashboards and views; read get_guide("dashboards") or get_guide("views") before drafting one. For checked views, use a ```retainer-view fence.',
        ]
      : []),
  ].join('\n');
}
