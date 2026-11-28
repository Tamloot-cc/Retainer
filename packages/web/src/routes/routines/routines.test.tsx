import { RetainerApiError } from '@retainer/sdk';
import type {
  RoutineCapabilities,
  RoutineDetail,
  RoutineRunCall,
  RoutineRunView,
  RoutineVersionView,
  RoutineView,
  SchemaDescription,
  Session,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { router } from '../extensions/test-router.js';
import { ReportContext } from '../state.js';
import { RoutinePage, runNowText } from './detail.js';
import { RoutinesPage } from './list.js';
import { madeChanges } from './model.js';
import { RoutineButtons } from './record-buttons.js';
import { RoutineRunPage } from './run.js';
import { TimeZoneSetting } from './time-zone.js';

vi.mock('@tanstack/react-router', async (original) =>
  (await import('../extensions/test-router.js')).mockRouter(original),
);

const RECORD = '7d1c5d6e-8f0a-4b8e-9a51-2f5a1c0b9e11';
const user = { type: 'user' as const, id: 'admin', name: 'Dana' };

const version = (over: Partial<RoutineVersionView> = {}): RoutineVersionView => ({
  id: 'version-2',
  number: 2,
  state: 'proposed',
  summary: 'Creates a thank-you task when a deal is won.',
  report: {
    verdict: 'partial',
    gaps: [
      {
        part: 'send them a WhatsApp',
        reason: 'no_tool',
        fix: 'Install an extension that sends WhatsApp messages',
      },
    ],
  },
  rank: 'agent',
  manifest: {
    when: { kind: 'record', object: 'deal', on: ['updated'], fields: ['stage'] },
    uses: { tools: [], model: false },
  },
  code: 'export default async function run() {\n  // creates the task\n}',
  facts: ["Runs when a deal's Stage changes.", 'Writes as an agent.'],
  builtBy: user,
  approvedBy: null,
  approvedAt: null,
  createdAt: '2026-11-20T08:00:00Z',
  ...over,
});
const routine = (over: Partial<RoutineView> = {}): RoutineView => ({
  id: 'routine-1',
  name: 'Thank won deals',
  description: 'When a deal is won, remind its owner to say thank you.',
  status: 'active',
  pausedReason: null,
  pausedAt: null,
  nextFireAt: null,
  heldRuns: 0,
  proposals: 0,
  activeVersion: version({
    id: 'version-1',
    number: 1,
    state: 'approved',
    approvedBy: user,
    approvedAt: '2026-11-19T08:00:00Z',
  }),
  createdBy: user,
  createdAt: '2026-11-19T07:00:00Z',
  ...over,
});
const run = (over: Partial<RoutineRunView> = {}): RoutineRunView => ({
  id: 'run-1',
  routineId: 'routine-1',
  versionId: 'version-1',
  mode: 'run',
  trigger: 'record',
  recordId: null,
  status: 'succeeded',
  code: null,
  attempt: 1,
  at: '2026-11-20T09:00:00Z',
  startedAt: '2026-11-20T09:00:01Z',
  finishedAt: '2026-11-20T09:00:02Z',
  expiresAt: null,
  initiatedBy: null,
  modelCalls: 0,
  output: null,
  calls: [],
  ...over,
});
const detail = (over: Partial<RoutineDetail> = {}): RoutineDetail => {
  const base = routine(over);
  return {
    ...base,
    versions: [version(), ...(base.activeVersion ? [base.activeVersion] : [])],
    runs: [],
    ...over,
  };
};

function mount(element: ReactNode, admin = true, report = vi.fn(), agent = false) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: admin ? 'admin' : 'member' },
            routinesAvailable: true,
            agentAvailable: agent,
            scopes: admin ? ['admin'] : ['read', 'write'],
            workspace: { id: 'workspace' },
          } as Session,
          schema: { objects: [] } as unknown as SchemaDescription,
        }}
      >
        <ReportContext.Provider value={report}>{element}</ReportContext.Provider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
  return report;
}
function capabilities(timezone = 'Europe/London') {
  return vi.spyOn(api, 'routineCapabilities').mockResolvedValue({
    timezone,
    objects: [
      {
        name: 'deal',
        universalId: 'deal-universal',
        label: 'Deal',
        fields: [
          { key: 'f_stage', label: 'Stage' },
          { key: 'f_sector', label: 'Sector' },
        ],
      },
    ],
  } as unknown as RoutineCapabilities);
}

afterEach(() => {
  vi.restoreAllMocks();
  router.reset();
});

describe('routines list', () => {
  it('shows each routine in plain words, with what waits for an admin', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({
      timeZone: 'UTC',
      routines: [
        routine({ proposals: 1, heldRuns: 3, status: 'needs_attention' }),
        routine({
          id: 'routine-2',
          name: 'Nightly check',
          status: 'draft',
          activeVersion: null,
          description: 'Every night, flag stale deals.',
        }),
      ],
    });
    mount(<RoutinesPage />);
    const list = await screen.findByRole('list', { name: 'Routines' });
    expect(within(list).getByText('Thank won deals')).toBeTruthy();
    expect(within(list).getByText('Needs attention')).toBeTruthy();
    expect(within(list).getByText('A version waits for review')).toBeTruthy();
    expect(within(list).getByText('3 runs held')).toBeTruthy();
    // The active version's facts, Retainer's own words, describe it.
    expect(
      within(list).getByText("Runs when a deal's Stage changes. Writes as an agent."),
    ).toBeTruthy();
    expect(within(list).getByText('Not approved yet')).toBeTruthy();
    expect(within(list).getByText('Every night, flag stale deals.')).toBeTruthy();
    expect(within(list).getAllByRole('link')[0]?.getAttribute('href')).toBe('/routines/routine-1');
    expect(
      await screen.findByText('Schedules follow the workspace time zone, Europe/London.'),
    ).toBeTruthy();
  });

  it('opens a plain chat to build a routine, with no describe box', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({ timeZone: 'UTC', routines: [] });
    const chat = vi.spyOn(api, 'createAgentChat').mockResolvedValue({
      id: 'chat-1',
      title: null,
      createdAt: '2026-11-28T08:00:00Z',
    } as never);
    mount(<RoutinesPage />, false, vi.fn(), true);
    expect(await screen.findByText('No routines yet')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'New routine' }));
    expect(chat).toHaveBeenCalledWith(undefined, 'web');
    await vi.waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/chat/$id', params: { id: 'chat-1' } }),
    );
  });

  it('points to an MCP agent on a server without the workspace agent', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({ timeZone: 'UTC', routines: [] });
    mount(<RoutinesPage />);
    expect(await screen.findByText(/an agent you connect over MCP/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New routine' })).toBeNull();
  });
});

describe('routine page', () => {
  it('shows a proposal with Retainer’s facts, the agent’s summary, its gaps and the code', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    mount(<RoutinePage />);
    expect(await screen.findByText('Version 2, waiting for review')).toBeTruthy();
    const facts = screen.getAllByRole('list', { name: "Retainer's facts" })[0];
    expect(
      within(facts as HTMLElement).getByText("Runs when a deal's Stage changes."),
    ).toBeTruthy();
    expect(
      screen.getAllByText('Written by the agent that built it. Retainer does not check it.'),
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        'The agent that wrote it says this routine does only part of what you described.',
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByText('What would fix it: Install an extension that sends WhatsApp messages'),
    ).toBeTruthy();
    // The code is there, folded away until opened.
    const code = screen.getAllByText('Show the code')[0]?.closest('details');
    expect(code?.open).toBe(false);
    expect(code?.textContent).toContain('creates the task');
    expect(screen.getByText(/Approving replaces version 1/)).toBeTruthy();
    expect(screen.getAllByText(/A test makes real writes/)).toBeTruthy();
  });

  it('approves a proposal, and says only an admin can when the server refuses', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    const decide = vi
      .spyOn(api, 'decideRoutineVersion')
      .mockRejectedValueOnce(new RetainerApiError(403, 'forbidden', 'admin required'))
      .mockResolvedValueOnce({
        routineId: 'routine-1',
        versionId: 'version-2',
        discardedRuns: 2,
      } as never);
    mount(<RoutinePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve version 2…' }));
    // Approving asks first, and says what going live means.
    const dialog = await screen.findByRole('dialog', { name: 'Approve version 2?' });
    expect(decide).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/It replaces version 1\./)).toBeTruthy();
    expect(within(dialog).getByText(/start a dry run/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve version 2' }));
    expect(
      await within(dialog).findByText('Only a workspace admin can approve or reject a routine.'),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve version 2' }));
    expect(decide).toHaveBeenLastCalledWith('routine-1', 'version-2', 'approve');
    expect(await screen.findByText(/Approved version 2\./)).toBeTruthy();
    expect(
      screen.getByText(/2 runs of the previous version that had not started were discarded/),
    ).toBeTruthy();
  });

  it('hides approval from a member', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    mount(<RoutinePage />, false, vi.fn(), true);
    expect(await screen.findByText('A workspace admin reviews and approves it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve version 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Routine actions' })).toBeNull();
    // A member can still ask the agent for a change.
    expect(screen.getByRole('button', { name: 'Edit with the agent' })).toBeTruthy();
  });

  it('opens a chat that carries the routine and why it paused', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(
      detail({ status: 'paused', pausedReason: 'check_failed' }),
    );
    vi.spyOn(api, 'createAgentChat').mockResolvedValue({ id: 'chat-2' } as never);
    const { firstMessages } = await import('../agent/first-message.js');
    mount(<RoutinePage />, true, vi.fn(), true);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit with the agent' }));
    await vi.waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ to: '/chat/$id', params: { id: 'chat-2' } }),
    );
    const text = firstMessages.get('chat-2') ?? '';
    expect(text).toContain('(ID routine-1)');
    expect(text).toContain('get_routine');
    expect(text).toContain('It needs attention:');
  });

  it('tests a version on a record after saying what is real, then links to the run', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    const test = vi.spyOn(api, 'testRoutine').mockResolvedValue({ runId: 'run-7' });
    capabilities();
    const search = vi.spyOn(api, 'queryRecords').mockResolvedValue({
      records: [{ id: RECORD, object: 'deal', label: 'Acme renewal' }],
      nextCursor: null,
    } as never);
    vi.spyOn(api, 'record').mockResolvedValue({
      id: RECORD,
      object: 'deal',
      label: 'Acme renewal',
    } as never);
    mount(<RoutinePage />);
    const [testButton] = await screen.findAllByRole('button', { name: 'Test on a record…' });
    if (!testButton) throw new Error('no test button');
    await userEvent.click(testButton);
    const dialog = await screen.findByRole('dialog', { name: 'Test version 2' });
    expect(within(dialog).getByText(/is not called\. Retainer reports the call/)).toBeTruthy();
    expect(within(dialog).getByText(/those may send/)).toBeTruthy();
    // The record is found by searching the routine's object, not by pasting an ID.
    expect(within(dialog).queryByRole('textbox', { name: 'Record ID' })).toBeNull();
    const start = within(dialog).getByRole('button', { name: 'Start the test' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(await within(dialog).findByRole('textbox', { name: /^Search/ }), 'Acme');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Acme renewal' }));
    expect(search.mock.calls[0]?.[0]).toBe('deal');
    expect(await within(dialog).findByText('Acme renewal')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start the test' }));
    expect(test).toHaveBeenCalledWith('routine-1', 'version-2', RECORD);
    const link = await within(dialog).findByRole('link', { name: 'Open the test run' });
    expect(link.getAttribute('href')).toBe('/routines/routine-1/runs/run-7');
  });

  it('explains a pause in plain words and resumes it', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(
      detail({
        status: 'needs_attention',
        pausedReason: 'runs_held',
        pausedAt: '2026-11-20T10:00:00Z',
        heldRuns: 4,
      }),
    );
    const state = vi
      .spyOn(api, 'setRoutineState')
      .mockResolvedValue({ routineId: 'routine-1', status: 'active' });
    const held = vi
      .spyOn(api, 'releaseHeldRuns')
      .mockResolvedValue({ routineId: 'routine-1', discarded: 4 });
    mount(<RoutinePage />);
    expect(await screen.findByText(/more than 200 runs in an hour/)).toBeTruthy();
    expect(screen.getByText(/^Since /)).toBeTruthy();
    expect(screen.getByText(/4 runs are/)).toBeTruthy();
    // Held runs wait while it is paused, so they can only be discarded now.
    expect((screen.getByRole('button', { name: 'Run them' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Discard them' }));
    expect(held).toHaveBeenCalledWith('routine-1', 'discard');
    expect(await screen.findByText('Discarded 4 held runs.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Routine actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Resume' }));
    expect(state).toHaveBeenCalledWith('routine-1', 'resume');
  });

  it('asks for a new approval instead of Resume when what it depends on changed', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(
      detail({ status: 'needs_attention', pausedReason: 'tool_changed' }),
    );
    const decide = vi
      .spyOn(api, 'decideRoutineVersion')
      .mockResolvedValue({ routineId: 'routine-1', versionId: 'version-1' });
    mount(<RoutinePage />);
    expect(await screen.findByText(/A tool it uses changed/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Routine actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Resume' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Approve again…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve version 1?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve version 1' }));
    expect(decide).toHaveBeenCalledWith('routine-1', 'version-1', 'approve');
  });

  it('dry-runs a proposal and shows what each run would do, without changing anything', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    vi.spyOn(api, 'record').mockResolvedValue({
      id: RECORD,
      object: 'deal',
      title: 'Acme deal',
    } as never);
    const preview = vi.spyOn(api, 'previewRoutine').mockResolvedValue({
      valid: true,
      problems: [],
      previewId: 'preview-1',
      matched: 3,
    });
    vi.spyOn(api, 'routinePreview').mockResolvedValue({
      previewId: 'preview-1',
      done: true,
      runs: [
        run({
          id: 'dry-1',
          mode: 'dry',
          trigger: 'preview',
          recordId: RECORD,
          status: 'failed',
          code: 'routine_error',
          output: {
            outcome: 'failed',
            error: "Cannot read properties of undefined (reading 'sector')",
          },
          calls: [
            {
              position: 1,
              operation: 'record.update',
              state: 'reported',
              code: null,
              differs: false,
              recordId: null,
            },
          ],
        }),
      ],
    });
    mount(<RoutinePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dry run…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dry run of version 2' });
    expect(within(dialog).getByText(/reported, not made\. Nothing changes/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start the dry run' }));
    expect(preview).toHaveBeenCalledWith({
      manifest: version().manifest,
      code: version().code,
    });
    expect(await within(dialog).findByText(/3 recent changes or records/)).toBeTruthy();
    expect(within(dialog).getByText(/reading 'sector'/)).toBeTruthy();
    const calls = within(dialog).getByRole('list', { name: 'Dry run calls' });
    expect(within(calls).getByText('Update a record')).toBeTruthy();
    expect(within(calls).getByText('Reported, not made')).toBeTruthy();
  });

  it('says a test cannot find records when the routine’s object is gone', async () => {
    router.params = { id: 'routine-1' };
    capabilities();
    const gone = version({
      manifest: {
        when: { kind: 'record', object: 'removed-object', on: ['created'] },
        uses: { tools: [], model: false },
      },
    });
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1, versions: [gone] }));
    mount(<RoutinePage />);
    const [testButton] = await screen.findAllByRole('button', { name: 'Test on a record…' });
    if (!testButton) throw new Error('no test button');
    await userEvent.click(testButton);
    const dialog = await screen.findByRole('dialog', { name: 'Test version 2' });
    expect(await within(dialog).findByText(/no longer in the workspace/)).toBeTruthy();
    expect(within(dialog).queryByText(/Finding the records/)).toBeNull();
  });

  it('runs an approved schedule now after saying what happens', async () => {
    router.params = { id: 'routine-1' };
    const weekly = version({
      id: 'version-1',
      number: 1,
      state: 'approved',
      manifest: {
        when: { kind: 'schedule', cron: '0 9 * * 0' },
        uses: { tools: [], model: false },
      },
    });
    vi.spyOn(api, 'routine').mockResolvedValue(
      detail({ activeVersion: weekly, versions: [weekly], nextFireAt: '2026-11-22T07:00:00Z' }),
    );
    const now = vi
      .spyOn(api, 'runRoutineNow')
      .mockResolvedValue({ routineId: 'routine-1', queued: 1, matched: 1 });
    mount(<RoutinePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Routine actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Run now…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run Thank won deals now?' });
    expect(within(dialog).getByText(/Its next scheduled run stays at/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run now' }));
    expect(now).toHaveBeenCalledWith('routine-1');
    expect(
      await screen.findByText('Started 1 run. Its regular schedule is unchanged.'),
    ).toBeTruthy();
  });

  it('says what run now did without guessing why runs were held', () => {
    expect(runNowText({ queued: 0, held: 1, matched: 1 })).toBe(
      'Started 0 runs and held 1 run. Retainer paused the routine; the notice above says why.',
    );
    expect(runNowText({ queued: 0, held: 0, matched: 2500 })).toMatch(/notice above says why/);
    expect(runNowText({ queued: 0, matched: 0 })).toBe('Nothing to run: no record matches it now.');
    expect(runNowText({ queued: 2, matched: 2 })).toBe(
      'Started 2 runs. Its regular schedule is unchanged.',
    );
  });

  it('offers no run now for a routine without a schedule', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail());
    mount(<RoutinePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Routine actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Pause' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Run now…' })).toBeNull();
  });

  it('lists a run that changed nothing as such, not as a plain success', async () => {
    router.params = { id: 'routine-1' };
    const write = {
      position: 1,
      operation: 'record.create',
      state: 'done' as const,
      code: null,
      differs: false,
      recordId: null,
    };
    vi.spyOn(api, 'routine').mockResolvedValue(
      detail({ runs: [run({ calls: [write] }), run({ id: 'run-2', calls: [] })] }),
    );
    mount(<RoutinePage />);
    const links = within(await screen.findByRole('list', { name: 'Routine runs' })).getAllByRole(
      'link',
    );
    expect(links[0]?.getAttribute('aria-label')).toMatch(/run, Done,/);
    expect(links[1]?.getAttribute('aria-label')).toMatch(/run, Done, no changes,/);
  });

  it('lists recent runs, each opening its calls', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(
      detail({
        runs: [run(), run({ id: 'run-2', mode: 'test', trigger: 'test', status: 'failed' })],
      }),
    );
    mount(<RoutinePage />);
    const runs = await screen.findByRole('list', { name: 'Routine runs' });
    const links = within(runs).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/routines/routine-1/runs/run-1',
      '/routines/routine-1/runs/run-2',
    ]);
    expect(links[0]?.getAttribute('aria-label')).toMatch(/^A record changed run, Done/);
    expect(links[1]?.getAttribute('aria-label')).toMatch(/^Test run, Failed/);
  });
});

describe('routine run page', () => {
  it('shows each call in order, a reported send and a kept result', async () => {
    router.params = { id: 'routine-1', run: 'run-7' };
    vi.spyOn(api, 'routineRun').mockResolvedValue(
      run({
        id: 'run-7',
        mode: 'test',
        trigger: 'test',
        status: 'succeeded',
        calls: [
          {
            position: 1,
            operation: 'record.create',
            state: 'done',
            code: null,
            differs: false,
            recordId: null,
            result: { id: 'task-1' },
          },
          {
            position: 2,
            operation: 'tool',
            state: 'reported',
            code: null,
            differs: false,
            recordId: null,
          },
        ],
      }),
    );
    mount(<RoutineRunPage />);
    const calls = await screen.findByRole('list', { name: 'Calls' });
    expect(within(calls).getByText('Create a record')).toBeTruthy();
    expect(within(calls).getByText('Call a tool')).toBeTruthy();
    expect(within(calls).getByText('Reported, not made')).toBeTruthy();
    expect(within(calls).getByRole('region', { name: 'Result of call 1' }).textContent).toContain(
      'task-1',
    );
    expect(screen.getAllByText('Test').length).toBeGreaterThan(0);
  });
});

describe('what a run did, in words', () => {
  it('names the record kind and each field, and says when a value waits for review', async () => {
    capabilities();
    router.params = { id: 'routine-1', run: 'run-8' };
    vi.spyOn(api, 'record').mockResolvedValue({
      id: RECORD,
      object: 'deal',
      label: 'Acme renewal',
    } as never);
    vi.spyOn(api, 'routineRun').mockResolvedValue(
      run({
        id: 'run-8',
        output: { outcome: 'succeeded', result: { updated: true }, logs: ['checked sector'] },
        calls: [
          {
            position: 1,
            operation: 'record.update',
            state: 'done',
            code: null,
            differs: false,
            recordId: RECORD,
            result: { id: RECORD, fields: { f_stage: 'applied', f_sector: 'pending_review' } },
          },
        ],
      }),
    );
    mount(<RoutineRunPage />);
    const calls = await screen.findByRole('list', { name: 'Calls' });
    expect(await within(calls).findByText('Update a deal')).toBeTruthy();
    const fields = within(calls).getByRole('list', { name: 'Fields of call 1' });
    expect(await within(fields).findByText('Stage:')).toBeTruthy();
    expect(within(fields).getByText('saved')).toBeTruthy();
    expect(within(fields).getByText('Sector:')).toBeTruthy();
    expect(within(fields).getByText('waiting for review')).toBeTruthy();
    // No raw JSON for a write.
    expect(within(calls).queryByRole('region', { name: 'Result of call 1' })).toBeNull();
    expect(screen.getByText(/1 value it wrote waits for a person’s review/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What it returned' }).textContent).toContain(
      'updated',
    );
    expect(screen.getByText('Show its log')).toBeTruthy();
  });

  it('says plainly when a run finished without changing anything, and what it returned', async () => {
    router.params = { id: 'routine-1', run: 'run-6' };
    vi.spyOn(api, 'routineRun').mockResolvedValue(
      run({
        id: 'run-6',
        output: {
          outcome: 'succeeded',
          result: 'Kickoff checklist already created for this project',
        },
        calls: [],
      }),
    );
    mount(<RoutineRunPage />);
    expect(await screen.findByText('Done, no changes')).toBeTruthy();
    expect(screen.getByText(/finished without changing anything/)).toBeTruthy();
    expect(screen.getByText('Kickoff checklist already created for this project')).toBeTruthy();
  });
});

describe('a skipped run (#147)', () => {
  it('says why it was skipped, and that it never started', async () => {
    router.params = { id: 'routine-1', run: 'run-s' };
    vi.spyOn(api, 'routineRun').mockResolvedValue(
      run({
        id: 'run-s',
        status: 'skipped',
        code: 'condition_false',
        attempt: 0,
        startedAt: null,
        calls: [],
      }),
    );
    mount(<RoutineRunPage />);
    expect(
      await screen.findByText('Its condition did not match the record when it started.'),
    ).toBeTruthy();
    expect(screen.queryByText(/already acted on this record/)).toBeNull();
    expect(screen.getByText('It did not start')).toBeTruthy();
    expect(screen.queryByText('Attempt')).toBeNull();
  });
});

describe('what counts as a change (#151)', () => {
  const call = (over: Partial<RoutineRunCall>): RoutineRunCall => ({
    position: 1,
    operation: 'tool',
    state: 'done',
    code: null,
    differs: false,
    recordId: null,
    ...over,
  });
  it('a read-only tool is not a change; a write or send tool, a write, and an older call are', () => {
    expect(madeChanges({ calls: [call({ tool: { name: 'lookup', effect: 'read' } })] })).toBe(
      false,
    );
    expect(madeChanges({ calls: [call({ tool: { name: 'crm', effect: 'write' } })] })).toBe(true);
    expect(madeChanges({ calls: [call({ tool: { name: 'mail', effect: 'send' } })] })).toBe(true);
    expect(madeChanges({ calls: [call({ operation: 'record.update' })] })).toBe(true);
    expect(madeChanges({ calls: [call({})] })).toBe(true);
    expect(
      madeChanges({ calls: [call({ state: 'failed', tool: { name: 'crm', effect: 'write' } })] }),
    ).toBe(false);
  });
});

describe('a failed run', () => {
  it('says why it failed, and marks a refused model call with the provider’s words', async () => {
    router.params = { id: 'routine-1', run: 'run-9' };
    const refusal =
      "output_config.format.schema: For 'array' type, property 'maxItems' is not supported";
    vi.spyOn(api, 'routineRun').mockResolvedValue(
      run({
        id: 'run-9',
        status: 'failed',
        code: 'routine_error',
        modelCalls: 1,
        output: { outcome: 'failed', code: 'routine_error', error: refusal },
        calls: [
          {
            position: 1,
            operation: 'ai.generate',
            state: 'failed',
            code: 'model_failed',
            differs: false,
            recordId: null,
            result: { error: refusal },
          },
          {
            position: 2,
            operation: 'ai.generate',
            state: 'started',
            code: null,
            differs: false,
            recordId: null,
          },
        ],
      }),
    );
    mount(<RoutineRunPage />);
    expect(
      await screen.findByText(
        /The routine’s code stopped with an error\. The error: output_config/,
      ),
    ).toBeTruthy();
    const calls = screen.getByRole('list', { name: 'Calls' });
    // A provider error is a failure, not the model declining to answer.
    expect(within(calls).getByText('Failed')).toBeTruthy();
    expect(within(calls).queryByText('Refused')).toBeNull();
    expect(within(calls).getByText(/The model provider said: .*maxItems/)).toBeTruthy();
    // A call left open on a finished run got no answer; it is not still waiting.
    expect(within(calls).getByText('No answer')).toBeTruthy();
    expect(within(calls).queryByText('Sent, no answer yet')).toBeNull();
  });
});

describe('routine buttons on a record', () => {
  it('runs the routine on this record and reports it with a link to the run', async () => {
    vi.spyOn(api, 'routineButtons').mockResolvedValue({
      buttons: [{ routineId: 'routine-1', name: 'Send welcome', label: 'Welcome' }],
    });
    const start = vi.spyOn(api, 'runRoutine').mockResolvedValue({ runs: ['run-3'] });
    const report = mount(<RoutineButtons object="person" recordId={RECORD} />, false);
    await userEvent.click(await screen.findByRole('button', { name: 'Welcome' }));
    expect(start).toHaveBeenCalledWith('routine-1', [RECORD]);
    await vi.waitFor(() => expect(report).toHaveBeenCalled());
    // The report belongs to the page the button was pressed on (#147).
    expect(report.mock.calls[0]?.[1]).toEqual({ page: window.location.pathname });
    render(<div>{report.mock.calls[0]?.[0]}</div>);
    expect(screen.getByText(/Started “Welcome” on this record/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See what it does' }).getAttribute('href')).toBe(
      '/routines/routine-1/runs/run-3',
    );
  });

  it('shows nothing to a read-only key', async () => {
    const buttons = vi.spyOn(api, 'routineButtons');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceContext.Provider
          value={{
            session: {
              actor: { type: 'user', id: 'reader' },
              routinesAvailable: true,
              scopes: ['read'],
              workspace: { id: 'workspace' },
            } as Session,
            schema: { objects: [] } as unknown as SchemaDescription,
          }}
        >
          <RoutineButtons object="person" recordId={RECORD} />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(buttons).not.toHaveBeenCalled();
  });
});

describe('workspace time zone', () => {
  it('lets an admin pick another zone and save it', async () => {
    capabilities('UTC');
    const save = vi.spyOn(api, 'setTimeZone').mockResolvedValue({ timeZone: 'Asia/Jerusalem' });
    mount(<TimeZoneSetting />);
    const save1 = await screen.findByRole('button', { name: 'Save time zone' });
    expect((save1 as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /Time zone/ }));
    await userEvent.type(
      await screen.findByRole('combobox', { name: 'Search time zone' }),
      'Jerusalem',
    );
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save time zone' }));
    expect(save).toHaveBeenCalledWith('Asia/Jerusalem');
    expect(await screen.findByText('Time zone saved.')).toBeTruthy();
  });

  it('shows the zone to a member without letting them change it', async () => {
    capabilities('Europe/Paris');
    mount(<TimeZoneSetting />, false);
    expect(
      await screen.findByText('Europe/Paris. Only a workspace admin can change it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save time zone' })).toBeNull();
  });
});
