import type { ExtensionInstallation, ExtensionManifest } from '@retainer/extension';
import { Checkbox, Input, Label, Muted, SelectMenu } from '../../ui/index.js';
import { stateLabel } from './model.js';

type Installation = ExtensionInstallation;
type Release = { manifest: Pick<ExtensionManifest, 'name' | 'settings'> };
type Settings = Installation['settings'];

export function SettingFields({
  release,
  values,
  secrets,
  onChange,
  onSecret,
  existing,
  references,
  allowConnectionEdit = false,
  allowNewCredentials = false,
  providedSecrets = [],
  level = 'installation',
  connectionSecrets,
  providedLabel = 'Provided for approval',
  omitSecrets = false,
}: {
  release: Release;
  values: Settings;
  secrets: Record<string, string>;
  onChange: (key: string, value: string | boolean | number) => void;
  onSecret: (key: string, value: string) => void;
  existing?: Installation;
  references: Record<string, string>;
  allowConnectionEdit?: boolean;
  allowNewCredentials?: boolean;
  providedSecrets?: string[];
  level?: 'installation' | 'connection';
  connectionSecrets?: string[];
  providedLabel?: string;
  /** Only the non-secret settings, as beside an OAuth connect button. */
  omitSecrets?: boolean;
}) {
  const presence = connectionSecrets
    ? Object.fromEntries(connectionSecrets.map((name) => [name, true]))
    : existing?.secrets;
  return (
    <>
      {Object.entries(release.manifest.settings)
        .filter(
          ([, definition]) =>
            !definition.generated &&
            !(omitSecrets && definition.secret) &&
            (definition.level ?? 'installation') === level,
        )
        .map(([key, definition]) => {
          const locked =
            !!existing &&
            !allowConnectionEdit &&
            (definition.secret || definition.reconnect) &&
            !(
              allowNewCredentials &&
              (definition.secret ? !presence?.[key] : !Object.hasOwn(existing.settings, key))
            );
          const caption = `${definition.label}${definition.required ? ' (required)' : ''}`;
          const details =
            definition.description || locked ? (
              <>
                {definition.description ? <Muted small>{definition.description}</Muted> : null}
                {locked ? (
                  <Muted small>Use Reconnect to change credentials or account settings.</Muted>
                ) : null}
              </>
            ) : null;
          if (!definition.secret && !definition.options && definition.type === 'boolean')
            return (
              <Checkbox
                key={key}
                variant="card"
                checked={values[key] === true}
                required={definition.consent}
                disabled={locked}
                onChange={(event) => onChange(key, event.target.checked)}
                label={caption}
                description={details}
              />
            );
          return (
            <Label key={key}>
              {caption}
              {definition.secret ? (
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[key] ?? ''}
                  disabled={locked}
                  required={
                    definition.required &&
                    !presence?.[key] &&
                    !references[key] &&
                    !providedSecrets.includes(key)
                  }
                  placeholder={
                    presence?.[key]
                      ? 'Connected'
                      : references[key] || providedSecrets.includes(key)
                        ? providedLabel
                        : ''
                  }
                  onChange={(e) => onSecret(key, e.target.value)}
                />
              ) : definition.options ? (
                <fieldset disabled={locked}>
                  <SelectMenu
                    label={definition.label}
                    value={typeof values[key] === 'string' ? String(values[key]) : null}
                    options={definition.options.map((value) => ({
                      value,
                      label: stateLabel(value),
                    }))}
                    onChange={(value) => onChange(key, value)}
                    fill
                  />
                </fieldset>
              ) : (
                <Input
                  type={definition.type === 'number' ? 'number' : 'text'}
                  value={String(values[key] ?? '')}
                  disabled={locked}
                  required={definition.required}
                  onChange={(e) =>
                    onChange(
                      key,
                      definition.type === 'number' ? e.target.valueAsNumber : e.target.value,
                    )
                  }
                />
              )}
              {details}
            </Label>
          );
        })}
    </>
  );
}
