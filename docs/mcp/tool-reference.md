# Key MCP tools

Your MCP client discovers the tools and input schemas available to its connection. Start with `describe_schema` for workspace-specific object names, fields, and view definitions.

| Task | Tools |
| --- | --- |
| Inspect or initialize the workspace | `describe_schema`, `list_templates`, `apply_template`, `get_guide` |
| Find records | `query_records`, `search`, `get_record`, `get_context` |
| Write records and their evidence | `upsert_record`, `log_event`, `remember` |
| Update the schema | `propose_schema_change` |
| Find workspace-specific connection URLs | `list_workspaces` |

Tools that change a workspace require scopes such as `write` or `schema:write`. Some decisions require a person acting through the web app or a user credential.

The [agent guide](../agents.md#tools) covers additional tools and their behavior. Use [the API reference](../api/index.mdx) for HTTP clients.
