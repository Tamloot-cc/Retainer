import type { ExtensionInstallation, ExtensionManifest } from '@retainer/extension';
import { Input, Label, Muted, SelectMenu } from '../ui/index.js';

type Installation = ExtensionInstallation;
type Release = { manifest: Pick<ExtensionManifest, 'name' | 'settings'> };
type Settings = Installation['settings'];
const stateLabel = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

export function SettingFields({
  release,
  values,
  secrets,
  onChange,
  onSecret,
  existing,
  references,
  allowConnectionEdit = false,
  level = 'installation',
  connectionSecrets,
  providedLabel = 'Provided for approval',
}: {
  release: Release;
  values: Settings;
  secrets: Record<string, string>;
  onChange: (key: string, value: string | boolean | number) => void;
  onSecret: (key: string, value: string) => void;
  existing?: Installation;
  references: Record<string, string>;
  allowConnectionEdit?: boolean;
  level?: 'installation' | 'connection';
  connectionSecrets?: string[];
  providedLabel?: string;
}) {
  const presence = connectionSecrets
    ? Object.fromEntries(connectionSecrets.map((name) => [name, true]))
    : existing?.secrets;
  return (
    <>
      {Object.entries(release.manifest.settings)
        .filter(
          ([, definition]) =>
            !definition.generated && (definition.level ?? 'installation') === level,
        )
        .map(([key, definition]) => {
          const locked =
            !!existing && !allowConnectionEdit && (definition.secret || definition.reconnect);
          return (
            <Label key={key}>
              {definition.label}
              {definition.required ? ' (required)' : ''}
              {definition.secret ? (
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[key] ?? ''}
                  disabled={locked}
                  required={definition.required && !presence?.[key] && !references[key]}
                  placeholder={presence?.[key] ? 'Connected' : references[key] ? providedLabel : ''}
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
              ) : definition.type === 'boolean' ? (
                <Input
                  type="checkbox"
                  checked={values[key] === true}
                  required={definition.consent}
                  disabled={locked}
                  onChange={(e) => onChange(key, e.target.checked)}
                />
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
              {definition.description ? <Muted small>{definition.description}</Muted> : null}
              {locked ? (
                <Muted small>Use Reconnect to change credentials or account settings.</Muted>
              ) : null}
            </Label>
          );
        })}
    </>
  );
}
