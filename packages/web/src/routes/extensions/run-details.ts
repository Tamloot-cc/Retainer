import type { api } from '../../api/client.js';
import { exaRegistrationId } from './branding.js';
import { stateLabel } from './model.js';

export type ExtensionRun = Awaited<ReturnType<typeof api.extensionRuns>>['runs'][number];

const triggers = new Map([
  ['change', 'Record change'],
  ['recordButton', 'Record button'],
  ['schedule', 'Scheduled'],
  ['job', 'Background job'],
  ['configure', 'Configuration'],
  ['install', 'Installation'],
  ['uninstall', 'Uninstallation'],
  ['connect', 'Connection'],
  ['disconnect', 'Disconnection'],
  ['route', 'Extension route'],
  ['serverRoute', 'Server route'],
  ['tool', 'Tool call'],
]);

const exaFunctions = new Map([
  ['enrich', 'Enrich company'],
  ['enrichCompanyNow', 'Enrich company'],
  ['enrichPerson', 'Enrich person'],
  ['enrichPersonNow', 'Enrich person'],
  ['backfill', 'Backfill company details'],
  ['backfillPerson', 'Backfill people details'],
  ['configure', 'Suggest destinations'],
  ['setup', 'Check Exa connection'],
]);

const exaOutcomes = new Map([
  ['matched_shortcut', 'Found a direct match and submitted enrichment values.'],
  ['matched_linkedin', 'Matched by LinkedIn profile and submitted enrichment values.'],
  ['matched_model_high', 'Found a high-confidence match and submitted enrichment values.'],
  ['matched_model_medium', 'Found a medium-confidence match and submitted enrichment values.'],
  ['no_match', 'No reliable Exa match was found.'],
  ['no_match_linkedin', 'Exa found no match for the LinkedIn profile.'],
  ['no_match_model', 'The model could not confirm a match.'],
  [
    'no_match_model_unavailable',
    'The match could not be checked because the model was unavailable.',
  ],
  ['no_match_model_refused', 'The model declined to check the match.'],
  ['no_match_model_output', 'The model returned an unusable match result.'],
  ['no_domain', 'Skipped because the company has no domain.'],
  ['no_name', 'Skipped because the person has no name.'],
  ['no_company', 'Skipped because the person has no company information for the lookup.'],
  ['nothing_to_fill', 'No mapped fields were eligible to fill.'],
  [
    'no_usable_values',
    'Exa matched the record and returned no values for its empty mapped fields.',
  ],
  ['lookup_changed', 'Skipped because the record changed during enrichment.'],
  ['record_gone', 'The record is no longer available.'],
  ['record_deleted', 'The record was deleted before enrichment could finish.'],
  ['record_merged', 'The record was merged before enrichment could finish.'],
  ['backfill_page', 'Finished checking a page of records for newly mapped fields.'],
  ['not_applicable', 'This run had no applicable records or destination.'],
  ['suggestions_ready', 'Destination suggestions are ready to review.'],
  [
    'suggestions_ready_without_model',
    'Destination suggestions are ready using schema field names.',
  ],
  ['binding_unavailable', 'The enrichment destination is missing.'],
  [
    'schema_binding_conflict',
    'The enrichment destination needs to be updated to match the workspace schema.',
  ],
  ['provider_credentials_rejected', 'Exa rejected the service credentials.'],
  ['provider_not_configured', 'The Exa service credentials are missing.'],
  ['provider_unavailable', 'Exa was unavailable.'],
  ['provider_rate_limited', 'Exa rate limited the request.'],
]);

export const runTriggerLabel = (kind: string) => triggers.get(kind) ?? stateLabel(kind);

export function runDetails(registrationId: string, run: ExtensionRun) {
  const isExa = registrationId === exaRegistrationId;
  const trigger = run.triggerKind && runTriggerLabel(run.triggerKind);
  const title = run.functionName
    ? ((isExa ? exaFunctions.get(run.functionName) : undefined) ??
      stateLabel(
        run.functionName
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replaceAll('-', ' ')
          .toLowerCase(),
      ))
    : trigger || 'Extension run';
  const outcome = run.code
    ? ((isExa ? exaOutcomes.get(run.code) : undefined) ?? stateLabel(run.code))
    : isExa && run.functionName === 'setup' && run.status === 'succeeded'
      ? 'Exa connection verified.'
      : null;
  return { title, trigger: title === trigger ? null : trigger, outcome };
}
