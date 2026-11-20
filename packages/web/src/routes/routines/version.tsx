import type { RoutineReport, RoutineVersionView } from '@retainer/shared';
import { CodeBlock, Muted, Section, Stack } from '../../ui/index.js';
import { gapText, VERDICTS } from './model.js';

/**
 * One version as an admin reviews it, each part labelled by who wrote it
 * (routines spec §5.2, item 4): Retainer's facts first, since they are
 * generated from the routine itself; then the builder's words and report;
 * then the code, folded away.
 */
export function VersionDetails({ version }: { version: RoutineVersionView }) {
  return (
    <Stack>
      <Section title="What it does, in Retainer's words">
        {version.facts.length ? (
          <ul aria-label="Retainer's facts" className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {version.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        ) : (
          <Muted>Retainer could not describe this version.</Muted>
        )}
        <Muted small>
          Retainer writes these sentences from the routine itself, not from the builder's words, so
          you can rely on them.
        </Muted>
      </Section>
      <Section title="The builder's summary">
        <p className="text-sm">{version.summary}</p>
        <Muted small>Written by the builder. Retainer does not check it.</Muted>
      </Section>
      <Section title="How much of your description it covers">
        <Report report={version.report} />
      </Section>
      <CodeBlock summary="Show the code" code={version.code} />
    </Stack>
  );
}

export function Report({ report }: { report: RoutineReport }) {
  return (
    <Stack>
      <p className="text-sm">{VERDICTS[report.verdict]}</p>
      {report.gaps.length ? <Gaps gaps={report.gaps} /> : null}
    </Stack>
  );
}

/** What the routine leaves out, why, and what would make it possible. */
export function Gaps({ gaps }: { gaps: RoutineReport['gaps'] }) {
  return (
    <ul
      aria-label="What it leaves out"
      className="flex flex-col divide-y divide-border rounded-lg border border-border"
    >
      {gaps.map((gap) => (
        <li key={`${gap.reason}:${gap.part}`} className="flex flex-col gap-0.5 px-3 py-2.5 text-sm">
          <span className="font-medium">“{gap.part}”</span>
          <span>{gapText(gap.reason)}</span>
          <span className="text-muted-foreground">What would fix it: {gap.fix}</span>
        </li>
      ))}
    </ul>
  );
}
