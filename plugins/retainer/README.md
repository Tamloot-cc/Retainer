# Retainer plugin for Claude Code

Connects Claude Code to [Retainer](https://github.com/Tamloot-cc/Retainer),
the memory of your CRM, and keeps it up to date from your chats. When you tell
Claude something your CRM should remember (a renewal date, a new contact's
role, a promise you made a customer), Claude logs it to Retainer on its own,
citing the chat.

## Install

You need a Retainer account. In Claude Code:

```
/plugin marketplace add Tamloot-cc/Retainer
/plugin install retainer@retainer
```

Then run `/mcp`, pick `plugin:retainer:retainer` and sign in. Claude opens
Retainer in your browser, where you pick the workspace Claude may use.

The plugin connects to the hosted service at `retainer.tamloot.cc`. For your
own server, set `RETAINER_URL` (for example `https://retainer.example.com`)
before starting Claude Code. Your server must run in
[accounts mode](../../docs/self-hosting.md#accounts-mode) for the sign-in to
work.

## What it adds

- **The Retainer MCP server**, with every Retainer tool, its guides and its
  prompts.
- **A check after every turn.** When Claude finishes a turn, a Stop hook
  checks it in the background, so it never slows you down. It skips turns
  that already used Retainer, short turns, slash commands and turns you
  didn't start. For the rest, it asks Claude Haiku, through your own Claude
  Code sign-in, whether the turn holds something your CRM should keep. If it
  does, Claude wakes up and follows the server's `log_from_chat` guide: it
  logs the chat as a conversation event first, then the field values, facts
  and tasks that cite it, and asks you before creating a company or any
  record other than a person or a task.

The rules for what to log live on the Retainer server, not in the plugin, so
they improve without a plugin update. To log a chat yourself, pick the
`log_from_chat` prompt from the `/` menu, or ask Claude to "log this to
Retainer".

The check sends the turn's text (your prompt, Claude's replies and the names
of the tools it used) to Claude Haiku, under your own Claude account. It
sends nothing to Retainer: only Claude's own Retainer calls do that.

## Turning it off

- **The check only, everywhere:** set `RETAINER_CRM_HOOK=off` in your shell,
  or in the `env` of `~/.claude/settings.json`.
- **The check only, in one project:** add it to that project's
  `.claude/settings.local.json`:

  ```json
  { "env": { "RETAINER_CRM_HOOK": "off" } }
  ```

- **The whole plugin:** `/plugin disable retainer@retainer`.

## Troubleshooting

Every decision the check makes, and why, goes to `crm-check.log` in
`~/.claude/plugins/data/` (in the folder for this plugin).

The check runs `claude -p`, so it needs Claude Code's own sign-in. If that
expires, the check stops working; Claude tells you once a day to run
`claude auth login` until you do.

## License

MIT
