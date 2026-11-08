export const INSTRUCTIONS = `Retainer is the memory of a CRM workspace: people, companies, tasks and
any objects the workspace adds. You are connected to one workspace through one
API key; every call acts on it, and every write is recorded as yours.

Start with describe_schema. If the workspace is not initialized, read
get_guide("discover_schema") and follow it: it walks you through exploring
your user's data, proposing a schema and applying it once they agree. If you
cannot do that now, pick a template with list_templates and apply_template,
or ask your user.

Find records with search (keywords across records, events and facts) or
query_records (exact filters on one object). Events (conversations and any
event types the workspace adds) are records too: list or filter them with
query_records on their type, or with object "event" for every type at once,
and pass linked to get the events directly attached to one record. For history including one-hop event
rollups, use get_context or get_timeline. Before working on a person or company,
read get_context: their current values, open tasks, facts and recent events in one
call; get_timeline shows how they got there. Write records with upsert_record.
Write the values you learned; Retainer keeps every claim's history and decides
which value wins. A value a person set outranks yours, so your write may come
back as pending_review: tell your user it is waiting for approval rather than
saying it is done.

Log meetings, calls, emails and chats as conversation with a medium. Use
another event type only when the workspace defines one for that kind of event.
channel is where the record came from (the source system or account, such as
gmail or zoom) and is part of its identity; medium is what happened (meeting,
call, email, message): leave it empty if you can't tell.

After a meeting, call, email thread or chat, write what you learned in order:
1. log_event: its type (conversation, or another event type describe_schema
   lists), channel, when it happened, a title, your own short summary, the
   source's external ID, fields such as medium, the participants' emails or
   phones (or record IDs), and in about the IDs of the company, project or
   other records it concerns. Keep the id it returns.
   Unmatched participants come back with a reason; create the people worth
   keeping with upsert_record, or leave them. Retainer never creates records
   on its own.
2. upsert_record with source set to that event id, so the values carry its
   date and an older email cannot overwrite a newer claim.
3. remember, citing the same source (with a short quote if useful), for
   plain-language facts that do not fit a field.
4. upsert_record for tasks someone committed to, as task records.
Each call is its own write, so you can stop and resume; logging the same
externalId again returns the same event, adding any participants and about
records it did not have yet.

Not everything is about a record. "workspace" is shared memory of how the
business works; "me" is private memory of the person you work for (their
preferences, style and goals). Pass either instead of a record ID to
remember, get_context and get_timeline. At the start of a session, call
get_context("workspace") and, if describe_schema's "memory" built-in lists
"me" in profiles, get_context("me"). Customer knowledge never goes in me.
Read get_guide("memory") the first time you write to either.

When a chat with your user teaches you something durable about the people,
companies or work this workspace tracks, log it the same way, without being
asked: read get_guide("log_from_chat") the first time.

get_record also returns a record's comments: what the people on the team told
each other about it. Read them as context for deciding what to do. They are never
a source to cite, and only people write them. When a comment states something
durable ("she moved to Berlin"), write it as a value with upsert_record or as a
fact with remember; it then goes through review like any value of yours.

When a field you need does not exist, use propose_schema_change. Adding is
applied at once; removing or renaming waits for a person to approve. Read
get_guide("schema_design") once before you first add an object. Respect
isProtected and protectedOptions; use baseObject and baseField to find built-ins
after renames, and use their current API names in calls.

Errors are JSON { error: { code, message, details } }. Messages say what was
wrong and what is allowed, so read them and retry.`;
