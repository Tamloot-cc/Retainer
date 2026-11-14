import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Loading, Splash } from './index.js';
import { CYCLE, LogoMark, type MoodState, moodReducer } from './logo-mark.js';

const here = dirname(fileURLToPath(import.meta.url));

const at = (shown: MoodState['shown'], next: MoodState['next'] = null): MoodState => ({
  shown,
  next,
});

describe('changing mood', () => {
  it('waits for the shown mood to finish its cycle', () => {
    const waiting = moodReducer(at('thinking'), { type: 'want', mood: 'reading', now: false });
    expect(waiting).toEqual(at('thinking', 'reading'));
    const switched = moodReducer(waiting, {
      type: 'cycle',
      name: 'retainer-mark-spin',
      ended: false,
    });
    expect(switched).toEqual(at('reading'));
  });

  it('switches at once when nothing is moving', () => {
    expect(moodReducer(at('thinking'), { type: 'want', mood: 'reading', now: true })).toEqual(
      at('reading'),
    );
  });

  it('counts only the shown mood’s main animation', () => {
    const waiting = at('thinking', 'reading');
    // Another layer's keyframes, and the end of a one-shot turn, are not thinking's cycle.
    expect(moodReducer(waiting, { type: 'cycle', name: 'retainer-mark-pop', ended: false })).toBe(
      waiting,
    );
    expect(moodReducer(waiting, { type: 'cycle', name: 'retainer-mark-spin', ended: true })).toBe(
      waiting,
    );
  });

  it('ignores the gradient mask’s copy of a cycle once the mood has changed', () => {
    const spin = { type: 'cycle', name: 'retainer-mark-spin', ended: false } as const;
    const once = moodReducer(at('thinking', 'reading'), spin);
    expect(moodReducer(once, spin)).toEqual(at('reading'));
  });

  it('forgets a waiting mood when asked for the shown one again', () => {
    expect(
      moodReducer(at('thinking', 'reading'), { type: 'want', mood: 'thinking', now: false }),
    ).toEqual(at('thinking'));
  });

  it('returns to idle after a one-shot mood, unless another is waiting', () => {
    const end = { type: 'cycle', name: 'retainer-mark-whirl', ended: true } as const;
    expect(moodReducer(at('done'), end)).toEqual(at('idle'));
    expect(moodReducer(at('done', 'thinking'), end)).toEqual(at('thinking'));
    expect(
      moodReducer(at('error'), { type: 'cycle', name: 'retainer-mark-shake', ended: true }),
    ).toEqual(at('idle'));
  });

  it('keeps looping when nothing is waiting', () => {
    const state = at('reading');
    expect(moodReducer(state, { type: 'cycle', name: 'retainer-mark-scan', ended: false })).toBe(
      state,
    );
  });
});

describe('logo-mark.css', () => {
  const css = readFileSync(join(here, 'logo-mark.css'), 'utf8');
  it('has the keyframes and the rules for every mood the component waits on', () => {
    for (const [mood, { name }] of Object.entries(CYCLE)) {
      expect(css).toContain(`@keyframes ${name} {`);
      expect(css).toContain(`[data-mood="${mood}"]`);
    }
  });
});

const mood = (el: Element) => el.getAttribute('data-mood');
function animation(el: Element, type: 'animationiteration' | 'animationend', name: string) {
  fireEvent(el, new AnimationEvent(type, { bubbles: true, animationName: name }));
}
const mark = (container: HTMLElement) => container.querySelector('.retainer-mark') as HTMLElement;

describe('LogoMark', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('changes mood at the end of the current cycle', () => {
    const { container, rerender } = render(<LogoMark mood="thinking" />);
    rerender(<LogoMark mood="reading" />);
    expect(mood(mark(container))).toBe('thinking');
    animation(mark(container), 'animationiteration', 'retainer-mark-spin');
    expect(mood(mark(container))).toBe('reading');
  });

  it('plays done once, then goes back to idle', () => {
    const { container } = render(<LogoMark mood="done" />);
    animation(mark(container), 'animationend', 'retainer-mark-whirl');
    expect(mood(mark(container))).toBe('idle');
  });

  it('finishes the cycle on a timer when no animation reports it', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<LogoMark mood="thinking" />);
    rerender(<LogoMark mood="saving" />);
    act(() => vi.advanceTimersByTime(1400 + 250));
    expect(mood(mark(container))).toBe('saving');
  });

  it('changes mood at once when motion is reduced', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    }));
    const { container, rerender } = render(<LogoMark mood="thinking" />);
    rerender(<LogoMark mood="error" />);
    expect(mood(mark(container))).toBe('error');
  });

  it('gives each mark its own gradient and mask', () => {
    const { container } = render(
      <>
        <LogoMark mood="thinking" />
        <LogoMark mood="thinking" />
      </>,
    );
    const ids = [...container.querySelectorAll('mask, linearGradient')].map((el) => el.id);
    expect(new Set(ids).size).toBe(4);
    for (const rect of container.querySelectorAll('.mark-fixed')) {
      const mask = rect.getAttribute('mask')?.match(/url\(#(.+)\)/)?.[1];
      expect(mask && rect.closest('svg')?.querySelector(`mask[id="${mask}"]`)).toBeTruthy();
    }
  });

  it('is decorative unless labelled', () => {
    const { container } = render(<LogoMark />);
    expect(mark(container).getAttribute('aria-hidden')).toBe('true');
    render(<LogoMark mood="reading" label="Reading memory" />);
    expect(screen.getByRole('img', { name: 'Reading memory' })).toBeTruthy();
  });
});

describe('loading indicators', () => {
  it('uses the turn-and-pause mood for inline loading', () => {
    const { container } = render(<Loading>Loading records…</Loading>);
    expect(mood(mark(container))).toBe('working');
    expect(screen.getByRole('status').textContent).toBe('Loading records…');
  });
});

describe('the splash', () => {
  it('turns from the angle it would have had since page load', () => {
    vi.spyOn(performance, 'now').mockReturnValue(CYCLE.working.ms * 3 + 500);
    render(<Splash label="Checking session…" />);
    const status = screen.getByRole('status');
    expect(status.style.getPropertyValue('--splash-phase')).toBe('-500ms');
    expect(screen.getByRole('img', { name: 'Checking session…' }).dataset.mood).toBe('working');
  });

  it('is drawn the same in index.html, before the scripts load', () => {
    const html = readFileSync(join(here, '../../index.html'), 'utf8');
    const page = document.createElement('div');
    page.innerHTML = html.slice(html.indexOf('<div id="root">'), html.indexOf('<script>'));
    const { container } = render(<Splash label="Loading Retainer" />);
    // Every element of the mark and its attributes, ids aside (React makes its own).
    const drawing = (root: ParentNode) =>
      [
        ...(root.querySelector('.retainer-mark')?.querySelectorAll('*') ?? []),
        root.querySelector('.retainer-mark'),
      ].map((e) => [
        e?.tagName,
        Object.fromEntries(
          [...(e?.attributes ?? [])].map((a) => [
            a.name,
            a.value.replace(/retainer-[\w-]*?-(fade|ring)\b/g, '$1').replace(/\s|;$/g, ''),
          ]),
        ),
      ]);
    expect(drawing(page)).toEqual(drawing(container));
    expect(drawing(page).length).toBeGreaterThan(10);
    const style = page.querySelector<HTMLElement>('.retainer-mark')?.style;
    expect(style?.getPropertyValue('--mark-cycle')).toBe(`${CYCLE.working.ms}ms`);
  });
});
