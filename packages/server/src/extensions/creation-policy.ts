import type { ExtensionManifest } from '@retainer/extension';
import { AppError } from '../errors.js';

const levels = ['never', 'contacted_first', 'everyone'] as const;

export function creationPolicy(
  manifest: Pick<ExtensionManifest, 'createPeople'>,
  requested: unknown,
  mode: 'review' | 'migration' = 'review',
): ExtensionManifest['createPeople'] {
  const ceiling = manifest.createPeople;
  if (requested === undefined) return ceiling;
  const choice = levels.find((level) => level === requested);
  if (choice && levels.indexOf(choice) <= levels.indexOf(ceiling)) return choice;
  if (mode === 'migration') return choice ? ceiling : 'never';
  throw new AppError(
    422,
    'invalid_settings',
    'Choose a contact creation policy allowed by this release.',
  );
}
