# macOS companion for hosted Retainer

Status: exploratory discussion, November 17, 2026. The preferred direction
is option 1 below; it is not a final implementation decision.

## Intent and constraints

Build a macOS app focused on the hosted product. Reuse the existing web app
through Electron, keep the desktop application code in a private repository,
and allow additional desktop functionality, including a local MCP server.

The desktop app should complement hosted Retainer. Hosted Retainer remains
the shared source of truth; this approach does not require a local Retainer
server or database.

## Why install a desktop app?

A local MCP endpoint that only forwards existing CRM tools to the hosted
service adds little value. The useful addition is access to the user's Mac,
with MCP providing an interface for agents to use those capabilities.

Possible workflows discussed, not committed scope:

- Attach a local proposal to the appropriate customer or deal.
- Capture meetings or selected text and submit relevant context.
- Integrate with supported local applications through their APIs or automation.
- Watch an approved folder and upload new customer documents.
- Extract or redact local content before uploading selected information.
- Let local agents combine files on the Mac with hosted customer history.

These require implementation and appropriate permissions; installing an MCP
server does not grant them automatically. Capture and background uploads can
also operate without an MCP call.

A cloud agent cannot automatically reach the Mac's localhost. Supporting
cloud-initiated local work would require a separate authenticated connection,
such as an outbound connection from the companion to the backend, and the Mac
would need to be available. This remains an optional future capability.

## Options for reusing the web app

| Option | Approach | Tradeoff |
| --- | --- | --- |
| 1. Load the hosted website | Electron displays the live hosted web app; private local code supplies desktop features. | Least duplication; web releases must account for older installed apps. |
| 2. Bundle the web app | The private build packages web assets from a pinned public Retainer revision. | Predictable UI versions; web UI updates require desktop releases. |
| 3. Compose from shared UI packages | Public packages supply reusable UI; the private app adds screens and workflows. | Most flexibility; requires refactoring the web app into reusable pieces. |

All three can use the hosted backend. Avoid copying and independently editing
the entire web app, which would create ongoing reconciliation work.

## Preferred direction: load the hosted website

The user leans toward option 1 because it is the leanest approach.

```text
Public Retainer repository
└── Hosted web app, with optional desktop integration points

Private desktop repository (proposed: retainer-desktop)
├── Electron application and narrowly scoped web-to-desktop bridge
├── Local MCP server and desktop integrations
├── Background tasks
├── Desktop-only settings or control windows
└── Signing, packaging, and updates
```

Local agents could call the companion's MCP tools, which access approved local
resources and call hosted Retainer as needed. Cloud agents could continue
using hosted Retainer directly.

Electron separates the web UI from privileged desktop code using its main
process, preload scripts, and IPC. Expose specific operations such as
`startRecording()` or `chooseAttachment()`, rather than general filesystem or
shell access. Remote content should have Node integration disabled, context
isolation enabled, and IPC requests validated.

## Limitations of option 1, with examples

### Web and desktop features update separately

The CRM UI changes with normal web deployments. Local capabilities change
when users update the installed app.

For example, the latest website might support recording while an older
installed app does not. The website must check available capabilities and
hide unsupported actions or ask the user to update. Web deployments must
remain usable with supported older desktop versions.

### Private logic and private UI are different requirements

A recording button embedded in a customer's CRM page would normally live in
the public web app. The recording implementation can remain private.

If the recording controls must also remain in the private repository, Electron
can display them in a separate local window. This is convenient for settings,
recording controls, and MCP status. Many private screens deeply integrated
throughout the shared CRM UI would make option 3 more attractive.

### Offline CRM use is not automatic

The main UI loads from the hosted website and its data comes from the hosted
backend. Do not assume it works offline.

Local recording, local MCP operations, or folder watching could continue
independently if designed that way. Saving locally and uploading later would
need explicit implementation. Tools that need hosted data still need a
connection unless a separate caching strategy is built.

### Web deployments affect desktop users immediately

A web regression can affect browser and desktop users together; a web fix can
also reach both immediately. Delaying an Electron release does not keep its
users on an older website version.

### Each local capability needs an explicit bridge

A web button cannot automatically access the Mac. The private app must expose
the particular operation, enforce permissions, and return its result. Once
built, this interaction can feel seamless, but it is additional integration
work.

## Suggested starting point and open decisions

Start with the hosted web UI, a private Electron application, and private
local windows for desktop settings. Choose a concrete desktop workflow that
justifies installation before expanding the companion's capabilities.

Reconsider this approach if the product needs a substantially different
desktop interface, extensive offline CRM functionality, or many private UI
features embedded directly in shared CRM screens.

Still to decide: the first desktop workflow, which UI integration points may
be public, authentication for desktop and local MCP access, supported client
connections, desktop update policy, and whether cloud agents need to request
local work. No implementation or delivery timeline was agreed.

## References

- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
