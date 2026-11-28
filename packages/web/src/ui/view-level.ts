/**
 * The levels of the View control (agent view spec §3), each adding to the one
 * before: Standard, Developer, then Agent.
 */
export const VIEW_LEVELS = ['off', 'developer', 'agent'] as const;
export type ViewLevel = (typeof VIEW_LEVELS)[number];
export const VIEW_LABELS: Record<ViewLevel, string> = {
  off: 'Standard',
  developer: 'Developer',
  agent: 'Agent',
};
/** `value` as a level, or undefined when it names none. */
export const asViewLevel = (value: string | null | undefined): ViewLevel | undefined =>
  VIEW_LEVELS.find((level) => level === value);
