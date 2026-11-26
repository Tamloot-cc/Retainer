/**
 * Pinned dashboards (spike only): kept in this browser's local storage, one
 * list per workspace path. The real feature stores them as a saved view in
 * Postgres; this is enough to prove a pinned program renders again, with
 * fresh data, without the agent.
 */

export type PinnedDashboard = { id: string; title: string; program: string; pinnedAt: string };

const key = () =>
  `retainer.dashboards:${window.location.pathname.split('/dashboards')[0]?.split('/chat')[0] ?? ''}`;

export function pinnedDashboards(): PinnedDashboard[] {
  try {
    const value = JSON.parse(localStorage.getItem(key()) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const save = (list: PinnedDashboard[]) => localStorage.setItem(key(), JSON.stringify(list));

export const isPinned = (program: string) => pinnedDashboards().some((d) => d.program === program);

export function pinDashboard(title: string, program: string) {
  save([
    { id: crypto.randomUUID(), title, program, pinnedAt: new Date().toISOString() },
    ...pinnedDashboards(),
  ]);
}

export function unpinDashboard(program: string) {
  save(pinnedDashboards().filter((d) => d.program !== program));
}
