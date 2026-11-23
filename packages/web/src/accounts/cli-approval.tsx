import { RetainerApiError } from '@retainer/sdk';
import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type Account,
  account as accountApi,
  type CliBrowserApproval,
  signOutOfAccount,
} from '../api/account.js';
import { Button, Muted, Notice, Stack } from '../ui/index.js';
import { AccountFrame } from './screens.js';

function describeAction(approval: CliBrowserApproval) {
  const { action, targetName } = approval;
  const field = (key: string) => String(action.arguments[key] ?? '');
  switch (action.operation) {
    case 'delete workspace':
      return `Delete the workspace ${targetName} and everything in it. It can be restored for 7 days.`;
    case 'create API key':
      return `Create the API key “${field('name')}” with ${field('access')} access in ${targetName}.${
        action.arguments.worksForMe ? ' This key will also work with your personal memory.' : ''
      }`;
    case 'invite owner':
      return `Invite ${field('email')} to be an owner of ${targetName}.`;
    case 'change owner role':
      return `Change ${field('email') || field('userId')} from ${field('from')} to ${field('role')} in ${targetName}.`;
    case 'remove owner':
      return `Remove ${field('email') || field('userId')} as an owner of ${targetName}.`;
    default:
      return action.operation;
  }
}

export function CliApprovalPage({ account, id }: { account: Account; id: string }) {
  const request = useQuery({
    queryKey: ['cli-approval', id],
    queryFn: () => accountApi.cliApproval(id),
    retry: false,
  });
  const [answer, setAnswer] = useState<'approved' | 'denied' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const approval = request.data;
  async function decide(allow: boolean) {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      const assertion =
        allow && approval.passkey
          ? await startAuthentication({ optionsJSON: approval.passkey })
          : undefined;
      const result = await accountApi.decideCliApproval(id, allow, assertion);
      setAnswer(result.status);
    } catch (error) {
      setError(error instanceof Error ? error : new Error('The approval could not be saved.'));
    } finally {
      setBusy(false);
    }
  }
  const title =
    approval?.kind === 'elevation'
      ? 'Allow decisions through Retainer CLI'
      : 'Review a Retainer CLI request';
  return (
    <AccountFrame title={title} account={account} signOutTo={window.location.pathname}>
      <Stack>
        {request.error ? <Notice error>{request.error.message}</Notice> : null}
        {!approval && !request.error ? <Notice>Checking the request…</Notice> : null}
        {approval ? (
          <>
            <p>
              <strong>Retainer CLI on {approval.machineName}</strong>
            </p>
            <Muted>Connected {new Date(approval.connectedAt).toLocaleDateString()}</Muted>
            {approval.kind === 'elevation' ? (
              <>
                <p>
                  Allow decisions in <strong>{approval.targetName}</strong> for{' '}
                  {String(approval.action.arguments.minutes)} minutes.
                </p>
                {typeof approval.action.arguments.reason === 'string' ? (
                  <p>Reason: {approval.action.arguments.reason}</p>
                ) : null}
                <p>
                  Any agent on this machine using this login can decide for you here until the
                  window ends.
                </p>
              </>
            ) : (
              <p>{describeAction(approval)}</p>
            )}
            {answer || approval.status !== 'pending' ? (
              <Notice>
                {answer === 'approved'
                  ? 'Allowed. Return to the terminal.'
                  : answer === 'denied'
                    ? 'Denied. Return to the terminal.'
                    : `This request is ${approval.status}.`}
              </Notice>
            ) : (
              <>
                {!approval.passkey ? (
                  <Notice>
                    An agent that controls your signed-in browser can approve requests. Add a
                    passkey in{' '}
                    <a href="/app/account" className="underline">
                      Your account
                    </a>{' '}
                    to require device verification.
                  </Notice>
                ) : null}
                {error ? <Notice error>{error.message}</Notice> : null}
                {error instanceof RetainerApiError && error.code === 'sign_in_required' ? (
                  <Button
                    variant="outline"
                    onClick={() => void signOutOfAccount(window.location.pathname)}
                  >
                    Sign in again
                  </Button>
                ) : null}
                <div className="flex gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                    Deny
                  </Button>
                  <Button disabled={busy} onClick={() => void decide(true)}>
                    {approval.passkey ? 'Allow with passkey' : 'Allow'}
                  </Button>
                </div>
              </>
            )}
          </>
        ) : null}
      </Stack>
    </AccountFrame>
  );
}
