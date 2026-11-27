import { type OpenUIError, Renderer } from '@openuidev/react-lang';
import type { DashboardIssue } from '@retainer/shared';
import { useMemo, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { DashboardIssues, Details, dashboardLibrary } from './library.js';
import { renderableProgram } from './program.js';
import { dashboardTools } from './tools.js';

const NO_ISSUES: DashboardIssue[] = [];

export function DashboardView({
  program,
  issues = NO_ISSUES,
  streaming = false,
  saved = false,
  live = true,
}: {
  program: string;
  issues?: DashboardIssue[];
  streaming?: boolean;
  saved?: boolean;
  live?: boolean;
}) {
  const { schema } = useWorkspace();
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const providers = useMemo(() => dashboardTools(api, schema), [schema]);
  const safe = useMemo(() => {
    try {
      return renderableProgram(program, issues, { saved, live });
    } catch {
      return {
        program: '',
        issues: [{ statement: 'root', message: 'Dashboard program could not be parsed' }],
      };
    }
  }, [program, issues, saved, live]);
  const messages = [
    ...new Set([
      ...safe.issues.map(({ message }) => message),
      ...errors
        .filter((error) => error.severity !== 'warning' && error.toolName !== '__unavailable')
        .map(({ message }) => message),
    ]),
  ];
  return (
    <DashboardIssues.Provider value={safe.issues}>
      {safe.program && (
        <Renderer
          response={safe.program}
          library={dashboardLibrary}
          isStreaming={streaming}
          toolProvider={live ? providers : undefined}
          onError={setErrors}
          publishObservability={false}
        >
          <Renderer.DefaultContent />
        </Renderer>
      )}
      {!streaming && messages.length > 0 && (
        <div className="mt-2">
          <Details label="Some dashboard data is unavailable" messages={messages} />
        </div>
      )}
    </DashboardIssues.Provider>
  );
}
