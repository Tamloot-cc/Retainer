import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMessages } from './messages.js';
import type { ChatMessage } from './model.js';

const asked = (text: string, id = 'u1') =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as ChatMessage;
const answered = (parts: unknown[], id = 'a1') => ({ id, role: 'assistant', parts }) as ChatMessage;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatMessages', () => {
  it('while steps run, opens them under a line saying what the agent is doing now', () => {
    render(
      <ChatMessages
        streaming
        mood="reading"
        messages={[
          asked('Who is Dana?'),
          answered([
            { type: 'reasoning', text: 'Look her up.', state: 'done' },
            {
              type: 'tool-search',
              toolCallId: 't1',
              state: 'input-available',
              input: { query: 'Dana' },
            },
          ]),
        ]}
      />,
    );
    const now = screen.getByRole('button', { name: /Searching for “Dana”\s*2 steps/ });
    expect(now.getAttribute('aria-expanded')).toBe('true');
    expect(now.querySelector('[data-status=running]')).toBeTruthy();
    expect(now.querySelector('.lucide-loader-circle')).toBeNull();
    expect(now.querySelector('.lucide-chevron-right')).toBeTruthy();
    // The running call inside is a plain line: nothing to open until its result is in.
    const inside = screen.getAllByText('Searching for “Dana”').at(-1);
    expect(inside?.closest('button')).toBeNull();
    expect(
      inside?.closest('[data-status=running]')?.querySelector('.lucide-loader-circle'),
    ).toBeTruthy();
  });

  it('uses the logo for a single running first step and keeps its finished icon', () => {
    const messages = [
      answered([{ type: 'reasoning', text: 'Check the workspace.', state: 'streaming' }]),
    ];
    const { rerender } = render(<ChatMessages streaming mood="thinking" messages={messages} />);
    const thinking = screen.getByRole('button', { name: 'Thinking' });
    expect(thinking.querySelector('[data-status=running]')).toBeTruthy();
    expect(thinking.querySelector('.lucide-loader-circle')).toBeNull();
    expect(thinking.querySelector('.lucide-chevron-right')).toBeTruthy();

    rerender(<ChatMessages mood="done" messages={messages} />);
    expect(
      screen.getByRole('button', { name: 'Thought' }).querySelector('.lucide-brain'),
    ).toBeTruthy();
  });

  it('folds finished steps into what the agent did, and marks a failure', async () => {
    render(
      <ChatMessages
        messages={[
          answered([
            { type: 'tool-get_record', toolCallId: 't1', state: 'output-available', output: {} },
            {
              type: 'tool-upsert_record',
              toolCallId: 't2',
              state: 'output-error',
              errorText: 'role',
            },
            { type: 'text', text: 'I could not save it.' },
          ]),
        ]}
      />,
    );
    const summary = screen.getByRole('button', { name: /Checked your workspace\s*2 steps/ });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.querySelector('[data-status=error]')).toBeTruthy();
    await userEvent.click(summary);
    expect(screen.getByText("Saved a record, but your role doesn't allow it")).toBeTruthy();
  });

  it('shows the pages a web search found as links to their sites', async () => {
    render(
      <ChatMessages
        messages={[
          answered([
            {
              type: 'tool-web_search',
              toolCallId: 'w1',
              state: 'output-available',
              input: { query: 'Acme' },
              output: [{ url: 'https://www.acme.com/about', title: 'About Acme' }],
            },
          ]),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Searched the web for “Acme”' }));
    const pages = screen.getByRole('list', { name: 'Pages found' });
    const link = within(pages).getByRole('link', { name: /acme\.com/ });
    expect(link.getAttribute('href')).toBe('https://www.acme.com/about');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('lists the sources a reply used once each', async () => {
    render(
      <ChatMessages
        messages={[
          answered([
            { type: 'text', text: 'Acme makes anvils.' },
            { type: 'source-url', sourceId: '1', url: 'https://a.example/x', title: 'Anvils' },
            { type: 'source-url', sourceId: '2', url: 'https://a.example/x' },
            { type: 'source-url', sourceId: '3', url: 'https://b.example/' },
          ]),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Used 2 sources' }));
    expect(screen.getByRole('link', { name: /Anvils/ }).getAttribute('href')).toBe(
      'https://a.example/x',
    );
    expect(screen.getByRole('link', { name: /b\.example/ })).toBeTruthy();
  });

  it('copies an answer, puts a question back to edit, and offers to ask again after a failed turn', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onEdit = vi.fn();
    const onRetry = vi.fn();
    render(
      <ChatMessages
        onEdit={onEdit}
        onRetry={onRetry}
        messages={[
          asked('Who is Dana?'),
          answered([{ type: 'text', text: 'Dana is the **CTO**.' }]),
          asked('And Acme?', 'u2'),
          answered([{ type: 'data-turn-end', data: { status: 'failed' } }], 'a2'),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    expect(writeText).toHaveBeenCalledWith('Dana is the **CTO**.');
    expect(await screen.findByText('Copied')).toBeTruthy();
    const [, editSecond] = screen.getAllByRole('button', { name: 'Edit and send again' });
    if (editSecond) await userEvent.click(editSecond);
    expect(onEdit).toHaveBeenCalledWith('And Acme?');
    // Only under the last answer.
    const retry = screen.getAllByRole('button', { name: 'Try again' });
    expect(retry).toHaveLength(1);
    await userEvent.click(retry[0] as HTMLElement);
    expect(onRetry).toHaveBeenCalled();
  });

  it("says when an answer couldn't be copied", async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ChatMessages messages={[answered([{ type: 'text', text: 'The CTO.' }])]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    expect((await screen.findByText('Copy failed')).getAttribute('role')).toBe('status');
  });

  it('shows the agent thinking before any of its answer arrives', () => {
    render(<ChatMessages waiting messages={[asked('Who is Dana?')]} />);
    const thinking = screen.getByText('Thinking');
    expect(thinking.closest('[data-status=running]')).toBeTruthy();
  });

  it('renders a fence in an unregistered language as code', () => {
    const text = [
      'Here is a program.',
      '',
      '````text',
      '```openui-lang',
      'root = Dashboard("Code", [])',
      '```',
      '````',
    ].join('\n');
    const { container } = render(<ChatMessages messages={[answered([{ type: 'text', text }])]} />);
    expect(container.querySelector('pre code')?.textContent).toContain(
      'root = Dashboard("Code", [])',
    );
  });

  it('leaves a saved trace without actions', () => {
    render(
      <ChatMessages
        mark={false}
        messages={[asked('Who is Dana?'), answered([{ type: 'text', text: 'The CTO.' }])]}
      />,
    );
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });
});
