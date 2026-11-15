export const CATEGORY_COLORS = ['forest', 'teal', 'coral', 'sage', 'amber', 'olive'] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

/** Color follows identity rather than display labels or position in a list. */
export function categoryColor(identity: string): CategoryColor {
  let hash = 0;
  for (const character of identity)
    hash = (Math.imul(hash, 31) + (character.codePointAt(0) ?? 0)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length] ?? 'forest';
}

const OBJECT_COLORS: Record<string, CategoryColor> = {
  person: 'forest',
  company: 'teal',
  deal: 'coral',
  task: 'olive',
  project: 'sage',
};

export function objectColor(name: string): CategoryColor {
  return Object.hasOwn(OBJECT_COLORS, name)
    ? (OBJECT_COLORS[name] ?? 'forest')
    : categoryColor(name);
}
