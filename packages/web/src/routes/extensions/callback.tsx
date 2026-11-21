import { RetainerApiError, type RetainerClient } from '@retainer/sdk';
import type { Session } from '@retainer/shared';
import { useEffect, useRef, useState } from 'react';
import { allWorkspaces } from '../../accounts/context.js';
import { AccountFrame } from '../../accounts/screens.js';
import { type Account, workspaceHref } from '../../api/account.js';
import { api, openWorkspace } from '../../api/client.js';
import { Button, Loading, Notice } from '../../ui/index.js';
import {
  type ConnectResult,
  connectionsHref,
  forgetAttempt,
  navigation,
  parseConnectState,
} from './connect-return.js';

export const SIGN_IN_FIRST =
  "Sign in to Retainer, then open the extension's Connections tab and connect again.";
export const CANNOT_FINISH =
  "This page can't finish connecting. Open the extension's Connections tab and try again.";

type Returned = { state: string | null; code: string | null; error: string | null };
const read = (search: string): Returned => {
  const query = new URLSearchParams(search);
  return { state: query.get('state'), code: query.get('code'), error: query.get('error') };
};

/** Where to complete, and where to land after: null when this person can't finish here. */
function target(
  state: string | null,
  who: { account: Account } | { session: Session },
): { installationId: string; base: string; client: () => RetainerClient } | null {
  const ids = parseConnectState(state);
  if (!ids) return null;
  if ('account' in who) {
    const here = allWorkspaces(who.account).find(
      ({ workspace }) => workspace.id === ids.workspaceId,
    );
    if (!here) return null;
    return {
      installationId: ids.installationId,
      base: workspaceHref(here.workspace.slug, ''),
      // Sends X-Retainer-Workspace for the workspace named in the state.
      client: () => {
        openWorkspace(here.workspace.id);
        return api;
      },
    };
  }
  // Key mode: the key decides the workspace; a state for another one can't finish here.
  if (who.session.workspace.id !== ids.workspaceId) return null;
  return { installationId: ids.installationId, base: '/app', client: () => api };
}

/**
 * `/app/connect/callback` (Tamloot connect spec 6.1): the provider sends the
 * browser back here with `state` and `code` or `error`. It works in any tab
 * signed in as the member who started; it never posts the code otherwise.
 */
export function ConnectCallback(props: { account?: Account; session?: Session }) {
  const [returned] = useState(() => read(window.location.search));
  const [outcome, setOutcome] = useState<'working' | 'sign-in' | 'cannot'>('working');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The code and state leave the address bar and history at once.
    window.history.replaceState(null, '', window.location.pathname);
    if (returned.state) forgetAttempt(returned.state);
    const who = props.account
      ? { account: props.account }
      : props.session
        ? { session: props.session }
        : null;
    if (!who) {
      setOutcome('sign-in');
      return;
    }
    const to = target(returned.state, who);
    const { state, code, error } = returned;
    if (!to || !state || (code === null) === (error === null)) {
      setOutcome('cannot');
      return;
    }
    const land = (result?: ConnectResult) =>
      navigation.replace(connectionsHref(to.base, to.installationId, result));
    to.client()
      .completeExtensionAuthorization(
        to.installationId,
        code !== null ? { state, code } : { state, error: error ?? '' },
      )
      .then(
        (done) => land('cancelled' in done ? 'declined' : undefined),
        (e: unknown) => {
          // Expired, used, someone else's, or not this person's workspace: the server
          // doesn't say which, and neither does this page.
          if (
            e instanceof RetainerApiError &&
            (e.code === 'authorization_expired' || [401, 403, 404].includes(e.status))
          )
            setOutcome('cannot');
          else land('failed');
        },
      );
  }, [props.account, props.session, returned]);
  if (outcome === 'sign-in')
    return (
      <AccountFrame title="Sign in to Retainer">
        <Notice>{SIGN_IN_FIRST}</Notice>
        <Button asChild>
          <a href="/app/">Open Retainer</a>
        </Button>
      </AccountFrame>
    );
  if (outcome === 'cannot')
    return (
      <AccountFrame
        title="Connecting didn't finish"
        {...(props.account ? { account: props.account } : {})}
      >
        <Notice>{CANNOT_FINISH}</Notice>
        <Button asChild>
          <a href="/app/">Open Retainer</a>
        </Button>
      </AccountFrame>
    );
  return (
    <AccountFrame title="Connecting…">
      <Loading>Finishing the connection.</Loading>
    </AccountFrame>
  );
}
