import { RetainerApiError } from '@retainer/sdk';
import type {
  RoutineCapabilities,
  RoutineDetail,
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
import { RoutinePage } from './detail.js';
import { RoutinesPage } from './list.js';
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

function mount(element: ReactNode, admin = true, report = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: admin ? 'admin' : 'member' },
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
  return vi
    .spyOn(api, 'routineCapabilities')
    .mockResolvedValue({ timezone } as unknown as RoutineCapabilities);
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

  it('builds a routine from a description and opens the proposal', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({ timeZone: 'UTC', routines: [] });
    const build = vi.spyOn(api, 'buildRoutine').mockResolvedValue({ jobId: 'job-1' });
    vi.spyOn(api, 'routineJob').mockResolvedValue(
      run({
        id: 'job-1',
        mode: 'build',
        trigger: 'build',
        output: { outcome: 'succeeded', proposed: true, routineId: 'routine-9', versionId: 'v' },
      }),
    );
    mount(<RoutinesPage />, false);
    expect(await screen.findByText('No routines yet')).toBeTruthy();
    expect(screen.getByText(/go to the model provider/)).toBeTruthy();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Describe the routine' }),
      'When a deal is won, thank them',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Build routine' }));
    expect(build).toHaveBeenCalledWith('When a deal is won, thank them', undefined);
    await vi.waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({
        to: '/routines/$id',
        params: { id: 'routine-9' },
      }),
    );
  });

  it('shows what is missing when the builder says it cannot be done', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({ timeZone: 'UTC', routines: [] });
    vi.spyOn(api, 'buildRoutine').mockResolvedValue({ jobId: 'job-1' });
    vi.spyOn(api, 'routineJob').mockResolvedValue(
      run({
        mode: 'build',
        output: {
          outcome: 'succeeded',
          proposed: false,
          report: {
            verdict: 'not_possible',
            gaps: [
              { part: 'when a deal is deleted', reason: 'needs_deletion_trigger', fix: 'Later' },
            ],
          },
        },
      }),
    );
    mount(<RoutinesPage />);
    await userEvent.type(await screen.findByRole('textbox'), 'When a deal is deleted, tell me');
    await userEvent.click(screen.getByRole('button', { name: 'Build routine' }));
    expect(
      await screen.findByText(/could not make this routine, so nothing was saved/),
    ).toBeTruthy();
    const gaps = screen.getByRole('list', { name: 'What it leaves out' });
    expect(within(gaps).getByText('“when a deal is deleted”')).toBeTruthy();
    expect(within(gaps).getByText('It would need to react when a record is deleted.')).toBeTruthy();
    expect(within(gaps).getByText('What would fix it: Later')).toBeTruthy();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('says plainly why a build failed', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({ timeZone: 'UTC', routines: [] });
    vi.spyOn(api, 'buildRoutine').mockResolvedValue({ jobId: 'job-1' });
    vi.spyOn(api, 'routineJob').mockResolvedValue(
      run({
        mode: 'build',
        status: 'failed',
        code: 'builder_failed',
        output: {
          outcome: 'failed',
          code: 'builder_failed',
          problems: [{ part: 'code', code: 'type', message: 'deal has no field "owner"' }],
        },
      }),
    );
    mount(<RoutinesPage />);
    await userEvent.type(await screen.findByRole('textbox'), 'Thank the owner');
    await userEvent.click(screen.getByRole('button', { name: 'Build routine' }));
    expect(
      await screen.findByText(/could not write a routine that passes Retainer’s checks/),
    ).toBeTruthy();
    expect(screen.getByText('deal has no field "owner"')).toBeTruthy();
  });

  it('explains a server without a model key', async () => {
    capabilities();
    vi.spyOn(api, 'routines').mockResolvedValue({ timeZone: 'UTC', routines: [] });
    vi.spyOn(api, 'buildRoutine').mockRejectedValue(
      new RetainerApiError(503, 'model_unavailable', 'no model key'),
    );
    mount(<RoutinesPage />);
    await userEvent.type(await screen.findByRole('textbox'), 'Anything');
    await userEvent.click(screen.getByRole('button', { name: 'Build routine' }));
    expect(await screen.findByText(/This server has no model key/)).toBeTruthy();
  });
});

describe('routine page', () => {
  it('shows a proposal with Retainer’s facts, the builder’s summary, its gaps and the code', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    mount(<RoutinePage />);
    expect(await screen.findByText('Version 2, waiting for review')).toBeTruthy();
    const facts = screen.getAllByRole('list', { name: "Retainer's facts" })[0];
    expect(
      within(facts as HTMLElement).getByText("Runs when a deal's Stage changes."),
    ).toBeTruthy();
    expect(screen.getAllByText('Written by the builder. Retainer does not check it.')).toBeTruthy();
    expect(
      screen.getAllByText('The builder says this routine does only part of what you described.'),
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
    await userEvent.click(await screen.findByRole('button', { name: 'Approve version 2' }));
    expect(
      await screen.findByText('Only a workspace admin can approve or reject a routine.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve version 2' }));
    expect(decide).toHaveBeenLastCalledWith('routine-1', 'version-2', 'approve');
    expect(await screen.findByText(/Approved version 2\./)).toBeTruthy();
    expect(
      screen.getByText(/2 runs of the previous version that had not started were discarded/),
    ).toBeTruthy();
  });

  it('hides approval from a member', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    mount(<RoutinePage />, false);
    expect(await screen.findByText('A workspace admin reviews and approves it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve version 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Routine actions' })).toBeNull();
    // A member can still describe a change.
    expect(screen.getByRole('button', { name: 'Build a new version' })).toBeTruthy();
  });

  it('tests a version on a record after saying what is real, then links to the run', async () => {
    router.params = { id: 'routine-1' };
    vi.spyOn(api, 'routine').mockResolvedValue(detail({ proposals: 1 }));
    const test = vi.spyOn(api, 'testRoutine').mockResolvedValue({ runId: 'run-7' });
    mount(<RoutinePage />);
    const [testButton] = await screen.findAllByRole('button', { name: 'Test on a record…' });
    if (!testButton) throw new Error('no test button');
    await userEvent.click(testButton);
    const dialog = await screen.findByRole('dialog', { name: 'Test version 2' });
    expect(within(dialog).getByText(/is not called\. Retainer reports the call/)).toBeTruthy();
    expect(within(dialog).getByText(/those may send/)).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Record ID' }), RECORD);
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
    await userEvent.click(screen.getByRole('button', { name: 'Approve again' }));
    expect(decide).toHaveBeenCalledWith('routine-1', 'version-1', 'approve');
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
