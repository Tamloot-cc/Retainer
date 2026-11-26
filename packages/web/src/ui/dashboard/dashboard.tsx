import './quiet.js';
import { type OpenUIError, Renderer } from '@openuidev/react-lang';
import { Pin, PinOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { Button } from '../index.js';
import { dashboardLibrary } from './library.js';
import { isPinned, pinDashboard, unpinDashboard } from './pinned.js';
import { dashboardTools } from './tools.js';

/** The program's title, from its root `Dashboard("…", …)`, for the pinned list. */
export function programTitle(program: string): string {
  return /Dashboard\(\s*"((?:[^"\\]|\\.)*)"/.exec(program)?.[1] ?? 'Dashboard';
}

/**
 * A live dashboard (spike): renders an OpenUI Lang program with Retainer's
 * components, and runs its queries in this browser with the viewer's
 * session. No model call: the program alone is enough to show it again.
 */
export function DashboardView({
  program,
  streaming = false,
  pinnable = true,
}: {
  program: string;
  streaming?: boolean;
  pinnable?: boolean;
}) {
  const tools = useMemo(() => dashboardTools(api), []);
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const [pinned, setPinned] = useState(() => isPinned(program));
  const problems = errors.filter((e) => e.severity !== 'warning');
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3">
      <Renderer
        response={program}
        library={dashboardLibrary}
        isStreaming={streaming}
        toolProvider={tools}
        onError={setErrors}
        publishObservability={false}
      />
      {!streaming && problems.length ? (
        <details className="text-xs text-destructive">
          <summary className="cursor-pointer">
            {problems.length === 1 ? 'One part' : `${problems.length} parts`} of this dashboard
            couldn't be shown
          </summary>
          <ul className="mt-1 list-disc ps-4">
            {problems.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: errors have no ID
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {pinnable && !streaming ? (
        <div className="flex justify-end">
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              if (pinned) unpinDashboard(program);
              else pinDashboard(programTitle(program), program);
              setPinned(!pinned);
            }}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? 'Unpin' : 'Pin to Dashboards'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
