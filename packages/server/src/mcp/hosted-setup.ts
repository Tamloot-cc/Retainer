/** Public instructions an agent can fetch before it has any Retainer credentials. */
export function hostedSetup(origin: string): string {
  return `# Connect to hosted Retainer

MCP server: ${origin}/mcp
Web app: ${origin}/app/

If your agent already has Retainer tools, start with an authenticated
describe_schema call. Reuse that connection if it reaches the requested
workspace. For a web setup prompt, compare the returned workspace ID.
Otherwise ask which workspace to use if the connection is ambiguous.

## Codex

If the server is missing, run:

    codex mcp add retainer --url ${origin}/mcp

This may start OAuth immediately. If sign-in is still needed, run
\`codex mcp login retainer\`. Keep the command running while the user signs
in and approves the intended workspace in their browser. If a saved
connection points to a different workspace and the user wants to switch it,
run \`codex mcp logout retainer\` and then \`codex mcp login retainer\`.
If this session cannot see the server after configuration, have the user
exit Codex and run \`codex resume --last\` from the same directory, or
reload their IDE's Codex session and reopen this conversation.

## Claude Code

If the Retainer plugin already provides the right connection, use it.
Otherwise add the hosted server directly; no plugin or chat logging is needed:

    claude mcp add --transport http --scope user retainer ${origin}/mcp

Run \`claude mcp login retainer\` if authorization is needed, or use
\`/mcp\` → Retainer → Authenticate in Claude Code. If switching an existing
direct connection, use \`claude mcp logout retainer\` before logging in again.
If the server still isn't listed in \`/mcp\`, exit and run
\`claude --continue\` from the same directory, then continue verification.
For a plugin connection, use its entry in \`/mcp\` to reauthenticate.

If the agent has no browser, either login command supports
\`--no-browser\`. Give the user the displayed authorization URL, then follow
the client’s prompt to complete the loopback callback.

## More than one workspace

${origin}/mcp asks which workspace to use at sign-in. To keep a connection
for each workspace, add ${origin}/mcp/w/<workspace ID> as its own server,
under its own name such as retainer-acme: it signs in to that workspace
alone. The list_workspaces tool gives each workspace's address.

## After browser consent

Call describe_schema using the authenticated MCP tools in the agent. Report
the workspace it returned and compare its ID with the workspace specified
in the setup prompt, if there is one. If the workspace differs, stop before
writing and reconnect to the intended workspace. If the call fails, report
what the user should do next and verify again before reporting success.

If initialized is false, call get_guide with name discover_schema. Explore
the sources already available, ask only for missing information, and show
a complete schema proposal. Wait for the user's approval before applying
it. Then call describe_schema again to confirm. If initialized is true,
skip schema discovery unless requested.

An expired or canceled authorization can be restarted from the agent.
A valid existing connection and its workspace can be reused. No Retainer
installation, API key, or repository checkout is needed.
`;
}
