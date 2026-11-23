# Retainer CLI

The `retainer` command reads and manages workspaces in accounts mode. It uses
browser sign-in and the signed-in person's workspace and organization roles.
Use Retainer MCP for record work. Server operators use `retainer-ops` for
commands that connect directly to Postgres.

```sh
npm install -g @retainer/cli
retainer login --server https://retainer.tamloot.cc
retainer wait <login-id>
retainer workspaces
retainer whoami --workspace sales
retainer review --workspace sales
```

Login prints a URL and returns immediately. Open the URL in a browser on the
same machine, sign in if needed, and allow the connection. The CLI stores
credentials per server in `~/.config/retainer/credentials.json` and honors
`XDG_CONFIG_HOME` where set. Use `--server` or `RETAINER_URL` to choose a
server. Use `retainer logout` to disconnect the current login or revoke it from
Connected apps in Your account.

A login lets the CLI read. To make decisions with an agent, approve a short
window in a browser.

```sh
retainer elevate --workspace sales --reason "review the proposed schema changes"
retainer wait <approval-id>
retainer schema-changes approve <change-id> --workspace sales
retainer elevate --end --workspace sales
```

A window lasts 30 minutes by default and up to 60 minutes. It covers one
workspace or organization, and any process using the same local login can use
it. Your account lists active windows and lets you end them. When you have an
enrolled passkey, approval requires device verification. Without a passkey,
approval requires a recent sign-in.

Creating a key, deleting a workspace, or granting or removing owner access
needs its own approval. After allowing the exact action, run it again with
`--approval <id>`. Routine approval and extension installation, upgrades and
configuration open their existing review screens in the web app.

Noninteractive commands print one JSON document. Pass `--json` to get the same
output in a terminal. Exit status 0 means success, 1 failure, 2 invalid usage,
3 login required, 4 elevation required, 5 timed out, 6 browser action needed,
and 7 denied. Run `retainer --help` for all commands and examples.
