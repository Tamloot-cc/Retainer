import type { LinkedRecordGroup, LinkedRecordPage } from '@retainer/shared';

/**
 * Token budgeting for context packs (6.2). Retainer runs no tokenizer, so
 * tokens are estimated from characters: about four per token.
 */

export const CHARS_PER_TOKEN = 4;

/** Characters of a value as it is sent: its JSON. */
export function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Estimated tokens of a value as it is sent. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(jsonLength(value) / CHARS_PER_TOKEN);
}

/** Measure the final response, including the estimate's own digits. */
export function measurePack<T extends { tokenEstimate: number }>(pack: T): T {
  let estimate = estimateTokens(pack);
  while (pack.tokenEstimate !== estimate) {
    pack.tokenEstimate = estimate;
    estimate = estimateTokens(pack);
  }
  return pack;
}

/**
 * Take one item from each section per round. A section stops when its next
 * item cannot fit, leaving the remaining budget for the other sections.
 * Custom costs account for sections whose wire representation is grouped.
 */
export function fitSections<T extends Record<string, readonly unknown[]>>(
  sections: T,
  budget: number,
  costs: Partial<Record<keyof T, number[]>> = {},
): { included: T; used: number } {
  const included: Record<string, unknown[]> = {};
  let pending = Object.entries(sections);
  for (const [name] of pending) included[name] = [];
  let used = 0;
  for (let index = 0; pending.length; index++) {
    pending = pending.filter(([name, items]) => {
      if (index >= items.length) return false;
      const item = items[index];
      const cost = costs[name]?.[index] ?? jsonLength(item) + 1;
      if (used + cost > budget) return false;
      used += cost;
      included[name]?.push(item);
      return true;
    });
  }
  return { included: included as unknown as T, used };
}

/** Charge object wrappers once, at the first appearance of an object on the page. */
export function linkedRecordCosts({ items, totals }: LinkedRecordPage): number[] {
  const seen = new Set<string>();
  return items.map(({ object, ...item }) => {
    if (seen.has(object)) return jsonLength(item) + 1;
    const cost =
      jsonLength({ object, total: totals[object], items: [item] }) + Number(seen.size > 0);
    seen.add(object);
    return cost;
  });
}

export function groupLinkedRecords(
  items: LinkedRecordPage['items'],
  totals: LinkedRecordPage['totals'],
): LinkedRecordGroup[] {
  const groups = new Map<string, LinkedRecordGroup>();
  for (const { object, ...item } of items) {
    let group = groups.get(object);
    if (!group) {
      const total = totals[object];
      if (total === undefined) throw new Error('Linked record page is missing its object total');
      group = { object, total, items: [] };
      groups.set(object, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
