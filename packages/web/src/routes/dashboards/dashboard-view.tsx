import './quiet.js';
import { type OpenUIError, Renderer } from '@openuidev/react-lang';
import type { DashboardIssue } from '@retainer/shared';
import { useMemo, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { DashboardIssues, dashboardLibrary } from './library.js';
import { renderableProgram } from './program.js';
import { dashboardTools } from './tools.js';

const NO_ISSUES: DashboardIssue[] = [];

export function DashboardView({
  program,
  issues = NO_ISSUES,
  streaming = false,
  saved = false,
}: {
  program: string;
  issues?: DashboardIssue[];
  streaming?: boolean;
  saved?: boolean;
}) {
  const { schema } = useWorkspace();
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const providers = useMemo(() => dashboardTools(api, schema), [schema]);
  const safe = useMemo(() => {
    try {
      return renderableProgram(program, issues, saved);
    } catch {
      return {
        program: '',
        issues: [{ statement: 'root', message: 'Dashboard program could not be parsed' }],
      };
    }
  }, [program, issues, saved]);
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
          toolProvider={providers}
          onError={setErrors}
          publishObservability={false}
        >
          <Renderer.DefaultContent />
        </Renderer>
      )}
      {!streaming && messages.length > 0 && (
        <details className="mt-2 text-sm text-muted-foreground">
          <summary className="cursor-pointer">Some dashboard data is unavailable</summary>
          <ul className="mt-1 list-disc ps-5">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </details>
      )}
    </DashboardIssues.Provider>
  );
}
