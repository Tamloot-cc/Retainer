import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { canMutate, useWorkspace } from '../../api/client.js';
import { Badge, Button, Empty, Loading, Muted, Page, Row, Section, Stack } from '../../ui/index.js';
import { QueryError } from '../state.js';
import { ExtensionIcon, extensionName } from './branding.js';
import { installedRelease, status, upgradeFor, useExtensions } from './model.js';

/**
 * Extensions: the ones this workspace has installed, each opening its own
 * page, then the ones the server offers that are not installed yet.
 */
export function ExtensionsPage() {
  const { session } = useWorkspace();
  const { data, error, retry } = useExtensions();
  const admin = canMutate(session, 'admin');
  const page = (children: React.ReactNode) => (
    <Page
      title="Extensions"
      description="Manage the services that bring data into this workspace or keep records up to date."
    >
      {children}
    </Page>
  );
  if (error) return page(<QueryError error={error} retry={retry} />);
  if (!data) return page(<Loading>Loading extensions…</Loading>);
  // Until an uninstall finishes the extension stays listed, so it cannot be set up twice.
  const installed = data.installed.filter((i) => i.state !== 'uninstalled');
  const available = [...data.newest.values()].filter(
    (release) => !installed.some((i) => i.registrationId === release.manifest.universalId),
  );
  if (!installed.length && !available.length)
    return page(
      <Empty
        title="No extensions available"
        description="Your operator has not made any extensions available on this server."
      />,
    );
  return page(
    <Stack>
      {installed.length ? (
        <Section title="Installed">
          <ul className="grid gap-3 sm:grid-cols-2">
            {installed.map((installation) => {
              const release = installedRelease(data.releases, installation);
              const upgrade = upgradeFor(data.newest, installation);
              const { label, tone } = status(installation);
              return (
                <li key={installation.id} className="min-w-0">
                  <Link
                    to="/extensions/$id"
                    params={{ id: installation.id }}
                    className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <CatalogIdentity
                      registration={installation.registrationId}
                      name={extensionName(
                        installation.registrationId,
                        release?.manifest.name ?? 'Unavailable extension',
                      )}
                      version={installation.version}
                      description={release?.manifest.description}
                      trailing={
                        <ArrowUpRight
                          aria-hidden
                          size={16}
                          className="ml-auto shrink-0 text-muted-foreground group-hover:text-primary"
                        />
                      }
                    />
                    <Row>
                      <Badge tone={tone}>{label}</Badge>
                      {upgrade ? <Badge>Update available</Badge> : null}
                    </Row>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {available.length ? (
        <Section title="Available">
          <ul className="grid gap-3 sm:grid-cols-2">
            {available.map(({ manifest }) => {
              const registrationId = manifest.universalId;
              const name = extensionName(registrationId, manifest.name);
              return (
                <li
                  key={registrationId}
                  className="flex min-w-0 flex-col rounded-lg border border-border bg-card"
                >
                  <div className="flex flex-1 flex-col gap-3 p-4">
                    <CatalogIdentity
                      registration={registrationId}
                      name={name}
                      version={manifest.version}
                      description={manifest.description}
                    />
                  </div>
                  {admin ? (
                    <div className="flex justify-end border-t border-border bg-muted/30 px-4 py-2">
                      <Button size="small" className="min-h-11 sm:min-h-8" asChild>
                        <Link
                          to="/extensions/new/$registration"
                          params={{ registration: registrationId }}
                          aria-label={`Set up ${name}`}
                        >
                          Set up
                        </Link>
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {available.length && !admin ? (
        <Muted>A workspace admin can set up these extensions.</Muted>
      ) : null}
    </Stack>,
  );
}

function CatalogIdentity({
  registration,
  name,
  version,
  description,
  trailing,
}: {
  registration: string;
  name: string;
  version: string;
  description?: string | undefined;
  trailing?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          <ExtensionIcon registrationId={registration} />
        </div>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <div className="font-semibold">{name}</div>
          <Muted small>Version {version}</Muted>
        </div>
        {trailing}
      </div>
      {description ? (
        <p className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      ) : null}
    </>
  );
}
