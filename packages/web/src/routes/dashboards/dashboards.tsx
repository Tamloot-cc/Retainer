import { useState } from 'react';
import { DashboardView } from '../../ui/dashboard/dashboard.js';
import { pinnedDashboards } from '../../ui/dashboard/pinned.js';
import { Empty, Page } from '../../ui/index.js';

/**
 * Dashboards pinned from the agent chat (spike). Each one renders from its
 * saved program and runs its queries now, with the viewer's access: no
 * model call, so it works with the agent off.
 */
export function DashboardsPage() {
  const [dashboards] = useState(pinnedDashboards);
  return (
    <Page
      title="Dashboards"
      description="Dashboards you pinned from a chat with the agent. Their numbers are live."
    >
      {dashboards.length ? (
        <div className="flex flex-col gap-6">
          {dashboards.map((d) => (
            <DashboardView key={d.id} program={d.program} />
          ))}
        </div>
      ) : (
        <Empty
          title="No dashboards yet"
          description="Ask the agent for one, such as “deals by stage this quarter”, then pin it."
        />
      )}
    </Page>
  );
}
