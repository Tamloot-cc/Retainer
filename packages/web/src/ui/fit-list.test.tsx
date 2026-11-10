import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FitList, fitCount } from './fit-list.js';

describe('fitCount', () => {
  const room = (extra = 0) => ({ gap: 4, more: 20, extra });
  it('shows every item when they all fit, with no count', () => {
    // 50 + 4 + 50 = 104
    expect(fitCount([50, 50], 104, room())).toBe(2);
  });
  it('leaves room for the count when some items are left out', () => {
    // Two items need 104, plus 4 + 20 for "+1" = 128.
    expect(fitCount([50, 50, 50], 127, room())).toBe(1);
    expect(fitCount([50, 50, 50], 128, room())).toBe(2);
    expect(fitCount([50, 50, 50], 158, room())).toBe(3);
  });
  it('counts extra items, so the count shows even when every item fits', () => {
    expect(fitCount([50, 50], 104, room(1))).toBe(1);
    expect(fitCount([50, 50], 128, room(1))).toBe(2);
  });
  it('shows one item, cut short, when even it does not fit', () => {
    expect(fitCount([300, 50], 100, room())).toBe(1);
    expect(fitCount([], 100, room())).toBe(0);
  });
});

describe('FitList', () => {
  let width = 0;
  let observers: Array<() => void> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    observers = [];
  });
  function stubLayout(itemWidth: number) {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const w = this.dataset.fitMore !== undefined ? 20 : itemWidth;
      return { width: w } as DOMRect;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe() {
          observers.push(this.cb);
          this.cb();
        }
        disconnect() {
          observers = observers.filter((o) => o !== this.cb);
        }
      },
    );
  }
  const items = ['Ada', 'Grace', 'Linus', 'Ken'].map((n) => ({ key: n, node: <span>{n}</span> }));
  const more = (n: number) => <span>+{n}</span>;
  const resize = () =>
    act(() => {
      for (const o of observers) o();
    });

  it('shows more items and a lower count as the column widens', () => {
    width = 128;
    stubLayout(50);
    render(<FitList items={items} more={more} />);
    expect(screen.queryByText('Linus')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();

    width = 182;
    resize();
    expect(screen.getByText('Linus')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();

    width = 500;
    resize();
    expect(screen.getByText('Ken')).toBeTruthy();
    expect(screen.queryByText(/^\+/)).toBeNull();

    width = 60;
    resize();
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.queryByText('Grace')).toBeNull();
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('adds extra items to the count', () => {
    width = 500;
    stubLayout(50);
    render(<FitList items={items} extra={2} more={more} />);
    expect(screen.getByText('Ken')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('shows the fallback number of items before the cell has a width', () => {
    width = 0;
    stubLayout(50);
    render(<FitList items={items} fallback={1} more={more} />);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.queryByText('Grace')).toBeNull();
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('measures again when the items change', () => {
    width = 128;
    stubLayout(50);
    const { rerender } = render(<FitList items={items} more={more} />);
    expect(screen.getByText('+2')).toBeTruthy();
    rerender(<FitList items={items.slice(0, 2)} more={more} />);
    expect(screen.getByText('Grace')).toBeTruthy();
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});
