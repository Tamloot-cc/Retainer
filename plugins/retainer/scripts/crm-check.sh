#!/bin/sh
# Runs the CRM check with Node. Claude Code's native installer needs no Node,
# so when it is missing, say so once and stay quiet afterwards.
[ "$RETAINER_CRM_HOOK" = off ] && exit 0
if command -v node >/dev/null 2>&1; then
  exec node "$(dirname "$0")/crm-check.mjs"
fi
data="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/retainer-plugin}"
[ -e "$data/node-missing" ] && exit 0
mkdir -p "$data" && touch "$data/node-missing"
echo "Retainer's CRM check needs Node.js 20 or later, and none was found. Tell the user, in one line, to install it from https://nodejs.org so turns are checked for CRM updates, or to set RETAINER_CRM_HOOK=off. Do nothing else." >&2
exit 2
