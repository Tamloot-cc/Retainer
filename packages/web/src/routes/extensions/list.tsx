import { Link } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
import { canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  Empty,
  ItemCard,
  ItemCards,
  Loading,
  Muted,
  Page,
  Stack,
} from '../../ui/index.js';
import { QueryError } from '../state.js';
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
      description="Extensions connect other services to this workspace. Each one brings in data or keeps records up to date, with the access you approve."
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
        <ItemCards label="Installed">
          {installed.map((installation) => {
            const release = installedRelease(data.releases, installation);
            const upgrade = upgradeFor(data.newest, installation);
            const { label, tone } = status(installation);
            return (
              <ItemCard
                key={installation.id}
                icon={<Puzzle size={18} />}
                title={release?.manifest.name ?? 'Unavailable extension'}
                status={
                  <>
                    <Badge tone={tone}>{label}</Badge>
                    {upgrade ? <Badge>Update available</Badge> : null}
                  </>
                }
                description={`Version ${installation.version}${release ? ` · ${release.manifest.description}` : ''}`}
                link={{ to: '/extensions/$id', params: { id: installation.id } }}
              />
            );
          })}
        </ItemCards>
      ) : null}
      {available.length ? (
        <ItemCards label="Available" columns={2}>
          {available.map((release) => (
            <ItemCard
              key={release.manifest.universalId}
              icon={<Puzzle size={18} />}
              title={release.manifest.name}
              status={<Muted small>{release.manifest.version}</Muted>}
              description={release.manifest.description}
              action={
                admin ? (
                  <Button size="small" asChild>
                    <Link
                      to="/extensions/new/$registration"
                      params={{ registration: release.manifest.universalId }}
                      aria-label={`Set up ${release.manifest.name}`}
                    >
                      Set up
                    </Link>
                  </Button>
                ) : null
              }
            />
          ))}
        </ItemCards>
      ) : null}
      {available.length && !admin ? (
        <Muted>A workspace admin can set up these extensions.</Muted>
      ) : null}
    </Stack>,
  );
}
