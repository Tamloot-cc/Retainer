import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ChangeLine,
  REVIEW_CATEGORIES,
  ReviewCategories,
  ReviewComparison,
  ReviewIntroduction,
} from './review.js';

describe('Review inbox explanations', () => {
  it('explains every category, keeps empty categories visible, and identifies the selected view', async () => {
    const onChange = vi.fn();
    render(
      <ReviewCategories
        value="pendingAssertions"
        counts={{ pendingAssertions: 2, schema: 0, mergeSuggestions: 1 }}
        onChange={onChange}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(4);
    for (const category of REVIEW_CATEGORIES)
      expect(screen.getByText(category.description)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Proposed updates (2)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Structure changes (0)' }));
    expect(onChange).toHaveBeenCalledWith('schema');
    expect(screen.getByRole('button', { name: 'Participant issues' })).toBeTruthy();
  });
  it('distinguishes a proposed value from the value the record currently holds', () => {
    render(<ReviewComparison current="CTO" proposed="CEO" />);
    expect(screen.getByText('Current value').parentElement?.textContent).toContain('CTO');
    expect(screen.getByText('Proposed value').parentElement?.textContent).toContain('CEO');
  });
  it('explains who can act and where participant issues are handled', () => {
    const { rerender } = render(<ReviewIntroduction category="schema" readOnly />);
    expect(screen.getByText(/A workspace admin can act/)).toBeTruthy();
    rerender(<ReviewIntroduction category="unresolvedParticipants" readOnly={false} />);
    expect(screen.getByText(/Open the related activity/)).toBeTruthy();
    expect(screen.queryByText(/can act on them/)).toBeNull();
  });
  it('reads a structure change as was and now, inline when short and stacked when long', () => {
    const { container, rerender } = render(
      <ChangeLine label="Name" before="Engagement" after="Project" />,
    );
    expect(container.textContent).toBe('Namewas Engagementnow Project');
    expect(container.querySelector('svg')).toBeTruthy();
    rerender(<ChangeLine label="Description" before={'x'.repeat(60)} after="Short" />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<ChangeLine label="New option" after="Done" />);
    expect(container.textContent).toBe('New optionDone');
  });
});
