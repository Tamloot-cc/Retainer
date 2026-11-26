# Connect to Retainer Docs

The **Retainer Docs** MCP server lets an agent search and read the public product documentation. It takes no Retainer credentials and has no access to workspace records. Use [the workspace MCP guide](./index.mdx) to connect to a Retainer workspace.

A server-enabled docs deployment exposes Streamable HTTP at `/api/mcp/` on the docs origin. For a local copy of the docs app running on port 3000, connect with:

```sh
codex mcp add retainer-docs --url http://localhost:3000/api/mcp/
```

Use the docs deployment's origin in place of localhost when connecting to a hosted endpoint. Static-only deployments provide the [Markdown index](/llms.txt) and Markdown pages for agents to read directly.

| Tool | Use it to |
| --- | --- |
| `search` | Find relevant guides or API operations by keyword |
| `list_pages` | Browse the documentation index and get page paths |
| `get_page` | Read the Markdown for one page |

Try asking your agent to find the Retainer API authentication guide and read the page it recommends.
