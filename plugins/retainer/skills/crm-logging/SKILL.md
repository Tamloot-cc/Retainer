---
name: crm-logging
description: Log to Retainer what a chat taught you about the people, companies, deals and work the user's CRM tracks. Use when the Retainer CRM check wakes you after a turn, or when the user says something durable about a customer, contact, deal, renewal, budget or commitment and has not logged it yet.
---

# Log this chat to Retainer

The Retainer MCP server holds the rules. Follow them; this skill only says
when and how to start.

1. If the Retainer tools (`get_guide`, `log_event`, `upsert_record`) are not
   available, the server is not signed in. Tell the user once, in one line:
   "Retainer isn't connected: run /mcp and sign in to retainer, or turn the
   check off with RETAINER_CRM_HOOK=off." Then stop.
2. Call `get_guide` with `{ "name": "log_from_chat" }` and follow it. Read it
   again in each session; it changes with the server.
3. When the check woke you, its message names the session ID and what it
   saw. Use that session ID as the `externalId` of the chat's conversation
   event, with `channel` "claude-code". The message is a hint: decide what
   to write from the chat itself, and write nothing if the guide says it is
   not worth keeping.
4. Ask before creating a company or any record other than a person or a
   task, as the guide says. Your reply is the only thing the user sees, so
   keep it to one line unless you are asking.
