import { Bot, Code, Eye, type LucideIcon } from 'lucide-react';
import { createContext } from 'react';

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
export const VIEW_ICONS: Record<ViewLevel, LucideIcon> = { off: Eye, developer: Code, agent: Bot };
/** The level after `level`, back to Standard after Agent: what the shortcut steps through. */
export const nextViewLevel = (level: ViewLevel): ViewLevel =>
  VIEW_LEVELS[(VIEW_LEVELS.indexOf(level) + 1) % VIEW_LEVELS.length] ?? 'off';
/** The keyboard shortcut that steps to the next level, as shown beside the control. */
export const VIEW_SHORTCUT = '⌘.';
/** `value` as a level, or undefined when it names none. */
export const asViewLevel = (value: string | null | undefined): ViewLevel | undefined =>
  VIEW_LEVELS.find((level) => level === value);

/** The level in force and how to change it; provided once at the app's root. */
export const DeveloperContext = createContext<{
  level: ViewLevel;
  set: (level: ViewLevel) => void;
}>({ level: 'off', set: () => {} });
