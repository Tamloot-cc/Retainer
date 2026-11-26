# Connection options

Retainer serves Streamable HTTP at `/mcp`. Use browser OAuth in accounts mode, or send a workspace API key in the `Authorization: Bearer` header. Give each agent its own key and grant only the scopes its work requires.

## A self-hosted instance with an API key

```sh
claude mcp add --transport http retainer http://localhost:8787/mcp \
  --header "Authorization: Bearer ${RETAINER_API_KEY}"
```

The client must be able to reach the server URL. Use HTTPS for connections beyond localhost.

## Claude on the web

In accounts mode, add your server's `/mcp` URL as a custom connector. Sign in, select the workspace, and review what the connector can do. The connection only gets scopes the person granting it is allowed to use.

## One connection per workspace

Register `https://<your-host>/mcp/w/<workspace-id>` as a separate server for each workspace. This address pins consent and subsequent tool calls to that workspace. The `list_workspaces` tool returns the addresses available to the signed-in person.

## Clients that require stdio

Use the `@retainer/mcp` bridge with `RETAINER_URL` and `RETAINER_API_KEY` in the client's MCP server environment. The bridge runs locally and makes HTTP requests to Retainer. See [stdio setup and troubleshooting](../agents.md#over-stdio).

## The Claude Code plugin

The optional plugin sets up the MCP connection and can log what Claude learns in chats. See the [Claude Code plugin guide](../agents.md#the-claude-code-plugin) for installation and behavior.
