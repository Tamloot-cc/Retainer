# Macro feature map

Researched 2026-11-19 from <https://macro.com/> (homepage, pricing, download,
security, the open-source blog post, the changelog, and the product pages for
each feature listed below) and the public repo
<https://github.com/macro-inc/macro> at commit `be50abb` (2026-11-19).
Marketing claims are recorded as the site states them and are not verified. The
email product page is very long and only its first part was read.

"In repo" means the code for the feature is in the public repo. Paths are
relative to the repo root. A feature marked in repo still depends on paid
outside services (model providers, LiveKit, Google and Microsoft APIs,
Pipedream, AWS) to run.

## What it is

Macro calls itself "the unified workspace for your company" and says it
"replaces 27+ apps with one connected system designed for humans and agents".
It puts email, chat, docs, tasks, calls, CRM, databases, calendar, files and
agents in one app, all linked by @mentions stored as a bidirectional graph. The
site claims 170k+ users and $30M+ raised, led by a16z. The team is about 15
people in New York and Toronto.

Stack: SolidJS web app (`apps/web`), Rust services and about 310 crates
(`services/`, `crates/`), Tauri for desktop and mobile (`apps/web/tauri`),
Postgres, OpenSearch, Kafka, Loro CRDTs, Cloudflare Durable Objects for
document sync, and Pulumi stacks on AWS (`infra/stacks`).

## Open source status

- **License:** AGPLv3 (`LICENSE.txt`). It moved from the Business Source License
  to AGPLv3 on 2026-05-31. The README and pricing FAQ say "fully open source,
  not open core". A non-AGPL license is sold through licensing@macro.com.
- **What the repo holds:** the whole product, as far as this survey found: web
  app, iOS, Android and desktop shells, every backend service, the MCP server,
  the SDK, the marketing site (`apps/marketing`), the docs site (`apps/docs`)
  and the production infrastructure as code. Every feature on the site maps to
  code in the repo. No private submodules and no "enterprise" folder.
- **Self-hosting:** allowed under the AGPL, but the hosted app is "our primary
  focus today". The blog says they "don't really recommend" self-hosting except
  for some military and healthcare cases. There is no self-hosting guide: the
  repo has `docs/development/running-locally.md` (Nix, Docker Compose for
  databases, local Rust services) and AWS Pulumi stacks. Help goes through
  self-host@macro.com. The hosted app's ISO 27001, SOC 2 Type II and CASA Tier 2
  certifications do not cover self-hosted installs.
- **Business model:** paid hosted seats, AI usage billing, and commercial
  licenses.

## Feature map

### Email

| Feature                                                       | In repo                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Email client on Gmail and Google Workspace                    | Yes: `services/email_service`, `crates/gmail_client`      |
| Outlook accounts (site: sign in with Microsoft)               | Yes: Microsoft OAuth, `crates/outlook_emulator` for tests |
| Custom IMAP/SMTP ("coming soon")                              | No: not found                                             |
| Several accounts in one inbox; shared and delegated inboxes   | Yes: `features/email-view`, `crates/email`                |
| Mail copied into Macro's own database, not read live          | Yes: `services/email_refresh_handler`                     |
| Keyboard triage (`j`, `k`, `e`) and split panes               | Yes: `apps/web`                                           |
| Signal and Noise inbox sorting                                | Yes: `services/email_focus_worker`                        |
| Scheduled send                                                | Yes: `services/email_scheduled_handler`                   |
| Email digest                                                  | Yes: `crates/email_formatting`                            |
| Share a live thread into a channel; make a task from an email | Yes                                                       |
| Agents search mail and attachments, draft and send            | Yes: MCP and AI tools                                     |
| "Sent with Macro" footer on Free                              | Yes                                                       |

### Chat (channels)

| Feature                                                    | In repo                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| Team and private channels, DMs, first replies inline       | Yes: `crates/channels`, `features/channel`                    |
| Guests by email, notified by email                         | Yes: `features/channel-invitations`                           |
| @mention people, docs, tasks, emails, files, dates, groups | Yes                                                           |
| @mentioning an item shares it with the channel             | Yes: entity access crates                                     |
| Attachments saved to Drive with previews                   | Yes                                                           |
| Polls (`/poll`) and forms in the composer                  | Yes: `crates/forms`                                           |
| Bots and bot webhooks                                      | Yes: `crates/bots`, `crates/channel_bots`                     |
| WhatsApp: read, reply and share linked chats               | Yes: `services/whatsapp_session_service`, `crates/whatsmeow*` |
| Slack import                                               | Yes: `services/slack_import_worker`                           |

### Docs

| Feature                                                          | In repo                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| Markdown docs with live collaboration (CRDT) and offline editing | Yes: `packages/loro-mirror`, `services/sync-service`     |
| Agents edit as CRDT peers, open or closed docs                   | Yes: `services/ai-editing-worker`                        |
| Blocks: tables, code, KaTeX, images, video, embeds               | Yes: `packages/lexical-core`, `services/lexical-service` |
| Version history with restore and fork                            | Yes                                                      |
| Threaded comments                                                | Yes                                                      |
| Embedded database views and live queries                         | Yes: `features/database-query`                           |
| Notion import; Markdown export                                   | Yes: `crates/import_notion`                              |
| Snippets: reusable Markdown inserted with `;`                    | Yes: `crates/documents` (`create_snippet.rs`)            |

### Tasks and projects

| Feature                                                        | In repo                                           |
| -------------------------------------------------------------- | ------------------------------------------------- |
| Tasks from email, messages, doc checkboxes, agents or `c` `t`  | Yes: `features/task-composer`                     |
| Assign to people or agents; an assigned agent starts a session | Yes                                               |
| Statuses, priority, custom properties                          | Yes: `crates/properties`                          |
| List, board and timeline views; saved views                    | Yes: `crates/saved_views`                         |
| Projects with discussion threads                               | Yes: `crates/projects`                            |
| Duplicate task detection                                       | Yes: `crates/task_dedup`                          |
| Status follows the linked GitHub branch and PR                 | Yes: `crates/github_pull_requests`                |
| Import from Linear, Jira, CSV                                  | Yes: `crates/import_linear`, `crates/import_jira` |

### Calls

| Feature                                                | In repo                                          |
| ------------------------------------------------------ | ------------------------------------------------ |
| Video calls with screen sharing from any channel or DM | Yes: `crates/call`, LiveKit (hosted service)     |
| Guest meeting links                                    | Yes                                              |
| Recording, transcript with speakers, AI summary        | Yes: `services/transcription` (Python, Deepgram) |
| Search and ask about past calls                        | Yes                                              |
| Native iOS calling (CallKit)                           | Yes: `apps/web/tauri/callkit_plugin`             |
| Granola import                                         | Yes: `crates/granola_sync`                       |

### CRM

| Feature                                                               | In repo                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Companies and contacts created from the team's email                  | Yes: `crates/crm`, `crates/contacts`, `services/contacts_service` |
| Email privacy rules for CRM backfill                                  | Yes: `docs/CRM_EMAIL_PRIVACY.md`                                  |
| Company enrichment from the domain                                    | Yes: Apollo is now only a legacy ID field                         |
| Several pipelines, Kanban or table, custom stages                     | Yes: `features/block-pipeline`                                    |
| Custom fields: text, number, select, date, checkbox, people, formula  | Yes                                                               |
| Record discussions; linked emails, calls, tasks and files on a record | Yes                                                               |
| CSV import and export                                                 | Yes                                                               |
| Agents update fields and stages, draft follow-ups, write summaries    | Yes                                                               |
| The changelog shows the CRM UI behind an `ENABLE_CRM` flag            | Yes: `crates/feature_flags`                                       |

### Databases, sheets, forms, canvas

| Feature                                                              | In repo                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Databases: typed columns, relations, table, board and timeline views | Yes: `crates/databases`, `crates/database_sql`             |
| Database webhooks; form answers land as rows                         | Yes: `crates/database_webhooks`                            |
| Spreadsheets: formulas, charts, Excel and CSV import and export      | Yes: `packages/spreadsheet`, IronCalc in `vendor/ironcalc` |
| Forms with sections, gates and branding                              | Yes: `crates/forms`                                        |
| Canvas whiteboard with live @mentions                                | Yes: `features/block-canvas`                               |

### Drive and file viewers

| Feature                                                | In repo                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Files from email, channels and uploads, auto-tagged    | Yes: `services/document_storage_service`                                                  |
| PDF viewer with highlights, annotations and comments   | Yes: `features/block-pdf` (the site only says "open PDFs")                                |
| Word, PowerPoint, Figma and Photoshop viewers          | Yes: `crates/docx_engine`, `crates/pptx_engine`, `crates/fig_engine`, `crates/psd_engine` |
| Full-text search of file contents                      | Yes: `services/document_text_extractor`                                                   |
| Folders with owner, editor, commenter and viewer roles | Yes                                                                                       |

### Calendar and booking

| Feature                                                               | In repo                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Several Google and Outlook calendars, two-way sync                    | Yes: `services/calendar_service`                                     |
| Team availability with busy-only sharing                              | Yes                                                                  |
| Booking links: personal, collective, round robin, form gate, insights | Yes: `crates/calendar_scheduling`, `routes/public-booking-shell.tsx` |
| Agents find times and draft invites for approval                      | Yes                                                                  |

### Agents and AI

| Feature                                                                 | In repo                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Built-in agent with workspace tools; model picker; auto mode            | Yes: `crates/agent`, `crates/ai_engine`                            |
| Models: Gemini Flash on Free; Claude, GPT and open models on paid plans | Yes: provider clients; the models are external                     |
| Custom agents, private or team                                          | Yes: `crates/team_agents`                                          |
| Team memory built nightly from email, chat, tasks, docs and calls       | Yes: `crates/memory`                                               |
| Agents write and run code against the Macro SDK ("code mode")           | Yes: `packages/code-mode-sdk`, `crates/code_execution`             |
| Hosted coding agents in Firecracker VMs that open PRs                   | Yes: `crates/firecracker_host_api`, `services/coding-agent-worker` |
| Cursor and Codex cloud agents                                           | Yes: `crates/cursor_cloud_agents`, `crates/codex_cloud_agents`     |
| MacroD: run Claude Code, Codex, OpenCode or Hermes on your own machine  | Yes: `crates/harnessd`, `crates/harnesses`                         |
| Routines: prompts on a schedule or on events                            | Yes: `crates/routines`, `services/agent_trigger_service`           |
| Skills: reusable instructions stored as docs                            | Yes: `crates/skills`, `crates/system_skills`                       |
| Third-party app tools through Pipedream                                 | Yes: `crates/pipedream_mcp`                                        |
| Web search and image generation tools                                   | Yes: `crates/web_search`, `crates/image_generation`                |
| Dictation                                                               | Yes: `crates/dictation`                                            |
| Starter agents that join as teammates                                   | Yes: `agent-teammates/`                                            |

### Search, links and permissions

| Feature                                                             | In repo                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| One search across email, messages, docs, tasks, calls and files     | Yes: `services/search_processing_service`, OpenSearch     |
| Embeddings (OpenAI) alongside full-text search                      | Yes: `crates/embedding`                                   |
| @mention graph with backlinks and hover previews                    | Yes: `crates/complete_graph`, `crates/mention_utils`      |
| Tags shared across all item types; agent tagging through routines   | Yes                                                       |
| One event feed driving routines                                     | Yes: `crates/macro_event_topics`, Kafka                   |
| Access follows channel membership; agents inherit the user's access | Yes: `crates/entity_access`, `crates/macro_authorization` |
| Data loss prevention handler                                        | Yes: `services/dataloss_prevention_handler`               |

### Developer surface

| Feature                                                          | In repo                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Remote MCP server (`mcp-server.macro.com/mcp`), OAuth, all plans | Yes: `services/mcp_auth_proxy`, `crates/mcp_toolset`            |
| ChatGPT app                                                      | Yes: `services/mcp-chatgpt-worker`                              |
| TypeScript SDK and SDK docs; user API keys                       | Yes: `packages/sdk`, `packages/sdk-docs`, `crates/user_api_key` |
| Agent sign-up flow with an SDK token                             | Yes                                                             |
| GitHub: PR review board, diffs, checks, merge from Macro         | Yes: `features/reviews-view`, `crates/github`                   |

### Apps and platforms

| Feature                                                | In repo                           |
| ------------------------------------------------------ | --------------------------------- |
| Web app                                                | Yes: `apps/web`                   |
| iOS app                                                | Yes: Tauri, `apps/web/tauri`      |
| Android app (site conflicts on whether it has shipped) | Yes: Tauri Android plugins        |
| Desktop for macOS and Linux ("coming soon")            | Yes: `apps/web/tauri/desktop-cef` |

### Billing and plans

| Plan | Price per seat per month | Includes                                                                     |
| ---- | ------------------------ | ---------------------------------------------------------------------------- |
| Free | $0                       | Gemini Flash with limited usage, 2 email accounts, 5 GB                      |
| Pro  | $40                      | All models, unlimited email accounts, 100 GB, call recording and transcripts |
| Max  | $200                     | 10x Pro usage, 1 TB, team-level memory for agents, priority support          |

Usage past the plan is billed at provider list price plus 25%, with prepaid
credit packs. Stripe billing and the usage meter are in the repo
(`crates/ai_billing`, `crates/ai_usage`, `crates/user_quota`). Plan limits are
enforced in code, so a self-hosted install can change them.

## CRM email privacy

Source: `docs/CRM_EMAIL_PRIVACY.md` and `crates/crm/src/domain/email_privacy.rs`.
The CRM fills itself from the team's email, so these rules decide whose mail
goes in, what stays out and who sees it.

- **Two separate permissions.** Seeing the CRM is on for every member by
  default; an admin can turn it off for a plain member, never for another
  admin. Contributing a mailbox is each person's own choice, and a member who
  can't see the CRM still controls their own contribution.
- **Opt-in per mailbox.** Each person opts in their primary mailbox, and the
  consent names that exact connection. A second mailbox doesn't inherit it.
  Disconnecting or re-authorizing revokes it; leaving the team deletes it.
  Opting in shares all past and future mail. A narrower "selected" mode (only
  threads with chosen contacts, companies or domains) is built but switched
  off.
- **Three exclusions.** A team domain (any member adds one, admins remove one)
  hides that domain's mail for everyone. A personal domain hides it from the
  caller's mailbox only. A thread exception hides one thread, including later
  replies, from the owner's copy only.
- **Exclusion details.** A domain covers its subdomains (`acme.com` covers
  `sales.acme.com`, not `notacme.com`). Any blocked participant, even on BCC,
  excludes the whole thread. Exclusions apply per copy: a teammate's consented
  copy of the same thread stays visible ("not a team-wide redaction"). A block
  that would cover a member's own mailbox domain is refused with HTTP 400.
- **Only sent mail creates companies.** Received-only mail can update an
  existing company but not create one, which keeps cold inbound and spam out.
- **Withdrawal hides, never deletes.** Opting out or adding an exclusion hides
  matching mail on the next read. Companies, contacts and interaction dates
  stay, and text already copied into messages, docs or agent transcripts is
  not redacted.
- **Enforcement.** One eligibility rule runs in three readers (a SQL function,
  the import scan and the team email view), kept equal by parity tests. CRM
  email reads use the primary database so replica lag can't undo a withdrawal.
  Import jobs recheck consent inside their write transaction. Advisory locks
  stop an opt-in racing a disconnect from reviving sharing. Every lapse is
  designed to hide mail, never to show it. Thread exceptions and selected mode
  are behind flags that are off by default.

Most of the 523-line document covers rollout and scale work for reading team
mailboxes directly. The parts that fit Retainer's basic integration privacy are
consent tied to one mailbox connection, team and personal domain blocks with
subdomains and whole-thread exclusion, the guard against blocking your own
domain, and creating companies only from sent mail.

## Model use in email ingestion

Turning email into CRM records uses no language model. `crates/crm` and
`crates/contacts` depend on no AI crate.

- Contacts come from participant addresses and companies from their domains,
  with common email domains like gmail.com handled separately
  (`generic_email_domains.rs`).
- Eligibility, interaction dates and "only sent mail creates companies" are
  plain code and SQL.
- Company enrichment fetches `https://{domain}` and keeps the page's title,
  description and favicon (`crates/crm/src/outbound/unfurl_resolver.rs`).
  Apollo is gone apart from a legacy ID field.

Language models read email in three other places:

1. **Focus inbox** (`services/email_focus_worker`, `crates/email/src/domain/focus.rs`).
   On every new message in an inbox thread, a yes/no classifier ("Jev" from a
   provider called TypeSafe) answers fixed questions about the thread, with the
   owner's stored memory as context. Fixed rules turn the answers and the
   owner's relationship with the sender into a verdict: in or out of Focus, a
   category, reply-needed and follow-up flags, a 0–100 importance score and a
   due date. It is billed as AI usage (`AiFeature::EmailFocus`) and only runs
   for users in its rollout.
2. **Nightly memory** (`crates/memory`). An agent reviews each user's day,
   including sent email, and writes an activity report
   (`prompts/daily.md`). Reports roll up into profiles, which become the team
   memory on the Max plan.
3. **Agents on request.** Agents update CRM fields and stages and write record
   summaries when a user or a routine asks them to, through tools. Nothing does
   this at import time.

## Notes for Retainer

- Macro is a whole workspace with a CRM inside it. Retainer is the memory layer
  that agents and other tools write to. They meet on CRM records built from
  email, team memory for agents, and an MCP server for outside agents.
- Macro's CRM import is deterministic, like Retainer's core. Model calls
  live in separate features: Focus classification (automatic on every inbox
  message), nightly memory, auto-tagging, task dedup, agent summaries and
  OpenAI embeddings. Retainer's core never calls a model.
- Macro grants access by channel membership. Retainer ties every write to an
  `Actor` from the credential.
- Both use AGPL for the server. Macro puts everything, including its
  infrastructure, under AGPL. Retainer keeps hosted infrastructure in the
  private `retainer-cloud` repo and its client packages under MIT.
- See "CRM email privacy" above for the rules worth borrowing before
  Retainer's email integrations go further.
