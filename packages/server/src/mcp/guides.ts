/**
 * Guides: step-by-step instructions for a task an agent does rarely and
 * should do well. Served as the get_guide tool, so any agent can read one on
 * its own, and as an MCP prompt of the same name, so a person can start one.
 * Retainer only serves the text; the agent does the work with its own model
 * and tools (4.3).
 */

import { z } from 'zod';

/**
 * How to shape a schema. Shared by discover_schema, which designs one, and
 * schema_design, which an agent reads before growing or reviewing one.
 */
const DESIGN_RULES = `### Use what Retainer already has

- Meetings, calls, emails and chats are all one event type, conversation,
  and its medium field says which. describe_schema lists event types as
  objects of class "event", and log_event logs them. Never create an entity object for them, nor a join
  object for who attended; participants are part of the event. The company,
  project, deal or tasks a meeting concerns go in its about list, so it
  shows on those records too; never list them as participants.
- channel is where an event came from: the source system or account
  (gmail, zoom, whatsapp-business). It is part of the event's identity and
  fixed once logged. medium is what happened (meeting, call, email,
  message), optional and correctable later. Don't make one stand in for the
  other.
- Add an event type only when the event has fields a conversation would
  never use. A payment has an amount and an invoice; a form submission has a
  form name and answers; a site visit has an address and an outcome. These
  are new event types: create_object with class "event". Each gets a title
  and summary of its own; add only the fields that type needs. Conversation
  details such as duration, direction or a recording link are optional
  fields on conversation, added from evidence, and a new kind of
  conversation (a workshop, a voice note) is a new medium option, not a new
  type. A relation field on an event type (a payment's invoice) also
  attaches the event to that record's history; prefer about for "what this
  concerns". Notes a source system keeps (a CRM's or a notetaker's notes) are
  such a type too: create_object with class "event" and nameSingular "note",
  only when a source has them.
- The about list and participants name entities, never another event: an
  event cannot be linked to an event.
- describe_schema lists facts, comments and memory under builtIns. They are
  part of every workspace; don't add fields or objects to copy them. Rules
  of the business and the user's preferences go in workspace and me memory
  (get_guide("memory")), never in an object.
- Comments are what people told each other about a record. Only people write
  them; you read them with get_record and list_comments. They are context for
  deciding what to do, never a source to cite. When a comment states something
  durable ("she moved to Berlin"), write it as a value or a fact; a value then
  goes through review like any value of yours.
- To find events by type, channel, date or linked record, use
  query_records with object "event" (every type) or on one event type, with
  linked; there is no need for a field like "meeting count".
- One-off knowledge ("prefers WhatsApp after 6pm") is a fact: store it with
  remember. A field is for something you would filter, sort or fill in for
  every record.
- Commitments are task records. Recency comes from events, so do not
  add a field like "last contacted" that someone has to keep up by hand.

### Object or event

Ask where something stands now, or what happened:

| Question              | Object                            | Event                               |
| --------------------- | --------------------------------- | ----------------------------------- |
| What it answers       | Where does it stand now?          | What happened?                      |
| Does it change?       | Yes: stage, status, amount, owner | No; corrections only                |
| Do people work on it? | Yes: assign it, move it, close it | No; they refer to it                |
| Where it comes from   | Created and kept in the workspace | Usually reported by a source system |
| Its role in memory    | Holds values                      | Evidence that values and facts cite |

- History is not an event. A deal moving to Won, a task being done or a
  person's title changing are field changes, and the record's history keeps
  them. Don't add an event type that duplicates them: the two copies can
  disagree.
- What happened to an entity is a value; how we learned it is the event. A
  job change sets the person's company. The conversation or source that
  reported it is the event, and the value cites it. No "job change" event type
  is needed.
- Scheduled things are objects. An appointment, a viewing or a booked demo can
  be cancelled or rescheduled, so it has a state. When it takes place, the
  conversation is the event.
- Some things need both. An invoice is an object, unpaid or paid; a payment
  from the payment system is an event about it. A contract is an object; its
  signing, from the e-signature tool, is an event about it.

### Start lean

- Adding is applied at once; renaming and removing wait for a person to
  approve. So a field left out costs little, and a field added by mistake
  costs a review. When in doubt, leave it out.
- Leave out what the data showed once or twice. A small schema that gets
  filled in beats a large one that stays empty.
- Prefer the smallest change that works: an option on an existing select
  before a new field, a field on an existing object before a new object.
- Prefer one multi_select of tags ("customer", "partner", "investor") over
  a separate type field per kind of record, and over separate objects for
  kinds of company or person that share the same fields.
- Add an object only for something with its own lifecycle (a status,
  dates, often an amount) that exists several times per person or company.

### Grow it from use

- A kind of fact you keep remembering on many records, or want to filter
  by, can become a field.
- A field whose value needs its own status, dates and history, several
  times per record, can become an object.
- A field still empty on almost every record after a few weeks is a
  candidate for removal; say so to your user with the count.

### Shape and names

- Types: select for a small closed set, with the options you saw;
  multi_select for tags; money for amounts (with currency); date or
  date_time; emails, phones and links for contact details; relation to
  link to another object, with an inverseField name for the other side.
  A relation is many_to_one (one record: a deal's company) unless a record
  can link to several at once (a deal's contacts, a person's
  organizations): then set relationCardinality "many_to_many" rather than
  creating a join object. A relation that can point at more than one
  object (a deal's customer, a company or a person) takes targetObjects
  instead of targetObject, and has no inverseField. Write a relation on its
  owning side; the inverse (isInverse) is read-only. Avoid json.
- rollUpEvents on an entity's owning relation (update_field, applied at once,
  reversible) shows directly attached events one hop from source to target,
  never onward through a second relation. Only events roll up, not field
  values or facts. Read this history with get_context or get_timeline;
  query_records with linked returns direct attachments only. For example:
  a company sees the calls about its deals. Set it where a record belongs to
  its target, such as an appointment's patient. Leave it off where the
  relation is reassigned, such as a person's company: the events would move
  to the new company. Nothing in the schema proves a relation never changes.
- Read isProtected and protectedOptions before proposing schema changes.
  Protected objects cannot be deleted; protected fields cannot be deleted
  or reshaped, and protected option values cannot be removed. Renames,
  labels and descriptions are allowed under the usual approval rules.
  Use baseObject and baseField to identify built-ins after a rename, then
  use their current API names from describe_schema in tool calls. An event
  type's coreRole title and summary fields are protected too.
- Names are camelCase API names (nameSingular "deal", namePlural "deals";
  field "closeDate"); labels are what people read. Prefer a template's
  names to your own when they mean the same thing.
- Set isSearchable on text fields people will look records up by.
- Do not make fields required or unique at first: each waits for a
  person's approval, and existing data may not satisfy it. Add them once
  the data does.`;

const DISCOVER_SCHEMA = `# Discover the schema from the user's data

Goal: look at how your user actually works, propose a Retainer schema that
fits it, and apply it once they agree. You only change the schema here; do
not write records, events or facts.

Retainer cannot read the user's email, calendar or files. You explore them
with your own tools; Retainer stores the schema you settle on.

## 1. Read what exists

Call describe_schema and list_templates.
- Every workspace already has person, company and task objects. Read their
  fields in describe_schema before you add your own.
- Read the templates even when the workspace is already initialized: a
  template may already define the object you are about to invent, and a
  workspace can apply a template later. Read them as reference here; choose
  one in step 4, after you have seen the data, so the data shapes the
  choice and not the other way round.
- initialized: false means no template has been chosen. If it is true, you
  are extending a schema someone already uses: propose additions only, and
  never rename or delete what is there unless the user asks. When they ask
  for a redesign, say which changes will wait for approval.

## 2. Find out for yourself

Do not start by asking your user. You probably know the business already,
and your own tools probably reach its data. Work it out first:
- What you already know: your instructions, your memory and earlier
  conversations. What does the business do, who are its customers, what
  does it sell, and how does a customer move from first contact to done?
- What you can reach: go through your own tools and connections. Look for
  a CRM or pipeline tool (HubSpot, Salesforce, Pipedrive, Airtable, Notion
  databases), email, calendar, file storage, spreadsheets, messaging, and
  booking, invoicing or e-commerce systems.
- Where the business already keeps its records: search file storage for
  sheets named like "clients", "leads", "pipeline", "orders" or
  "customers"; look for email sent by a CRM or booking tool; look for
  calendar events whose titles repeat.

A CRM, database or spreadsheet the business already keeps is the best
evidence: its objects, columns, pipelines and stage names are the user's own
schema. Read it first, and read its schema or settings rather than its
records when the tool lets you.

Records already in this Retainer workspace are not that evidence: they show
how someone modelled the business, not how the business works. Read them
too, then look at the sources anyway.

Ask your user only for what you could not find, in one short question, then
carry on: what the business does if nothing says, or where its data lives
if none of your tools reach it.

## 3. Sample the sources

You are reading the sources to learn the shape of the business, not to
decide what to import. Look at a source even if its contents will never be
logged: calendar titles show which meetings recur and with whom, and email
shows the words people use for stages. Which sources flow into Retainer is
a separate question, for after the schema is agreed.

Read a sample of every source you found, not everything: for example the
fields and pipelines of an existing CRM, the header row plus 20 rows of each
spreadsheet, the last 50 to 100 email threads and the last four weeks of
calendar. Note what recurs:
- Things the business tracks one by one, with their own status, dates or
  amount, and several per person or company: deals, projects, orders,
  properties, appointments, applications. These may be objects.
- Details that come up again and again about a person, company or such a
  thing: a budget, a renewal date, a source, a plan. These may be fields.
- Words for stages and states ("sent the proposal", "signed", "on hold").
  These become select options; use the values you actually saw.
- Which thing belongs to which: a deal to a company, a viewing to a
  property. These become relations.
- Spreadsheet columns and CRM export fields already in use: they are the
  user's own schema and the strongest evidence.
Count how often each one appears, so you can say what the evidence is.

Keep personal details out of your notes and your proposal; you need the
shape of the data, not its contents.

## 4. Design

Start from the template closest to the business, or "blank" if none fits.
A template object that is close but not exact is still better than your
own: add the fields it lacks rather than creating a twin.

${DESIGN_RULES}

## 5. Propose and wait

Show the user:
- What you understood the business to be, and the sources you looked at.
- The template you chose and why.
- Each new object and field: name, type, options, what it links to, and the
  evidence ("a stage is mentioned in 31 of 80 threads").
- What you left out and why.
- Anything that will need a person's approval in Retainer.
Then stop and wait for their answer. Revise until they agree. Do not apply
anything they have not approved.

## 6. Apply

1. apply_template with the chosen template, before anything else (template
   names would otherwise collide with your own objects). Skip it if the
   workspace already has that template.
2. propose_schema_change once, with every approved operation and a short
   reason that says the user approved it. Create objects before
   the fields and relations that point to them.
3. Read the response: "applied" is done, "proposed" waits for a person with
   admin access, "failed" carries a message saying what to fix. Fix and
   retry only what failed.
4. Call describe_schema to confirm, then tell the user what was applied and
   what is waiting for approval.

apply_template and propose_schema_change need the schema:write scope. If
the key lacks it, give the user the approved proposal and tell them a key
with schema:write is needed to apply it.

When the schema is in place, you can offer to import the records and
conversations you sampled, as a separate step.`;

const SCHEMA_DESIGN = `# Design and grow the schema

Read this before you add an object, when a field you need is missing, or
when your user asks you to review or clean up the schema. To set up a
workspace from scratch, follow the discover_schema guide instead; it uses
the same rules.

## Before you change anything

1. Call describe_schema, and list_templates: a template may already define
   what you need, and applying it beats building a twin.
2. Check that the change is needed: could an option, an existing field, a
   fact or an event hold it?
3. Make the smallest change that works, with a reason that names the
   evidence ("budget came up in 9 of the 12 deals logged this month").

## Rules

${DESIGN_RULES}

## Reviewing a schema in use

When your user asks whether the schema still fits:
- Count how often each custom field is filled in (query_records), and
  name the ones that are almost always empty.
- Look for entity objects (class "entity") used to log meetings, calls or
  emails, join objects for who attended, and fields tracking last contact
  by hand. Moving legacy entity records means logging them as events first,
  so propose it as a plan, not a single change.
- Look for event types that a conversation with a medium would cover: ones
  whose fields a conversation would also use. Never delete and re-log their
  events: that retracts what cites them and blocks their source for good.
  move_events changes their type in place, keeping IDs, identity, links and
  citations. Run it with dryRun: true (for example meeting to conversation
  with defaults { "medium": "meeting" }) and show your user what would move
  and any values the target has no field for. Moving needs a person with
  admin access, so your user runs it; once a type has no events left, its
  deletion can be proposed like any removal.
- Look for twins of template objects and for type fields that tags could
  replace.
Propose additions as usual. Renames and removals wait for a person with
admin access, so list them separately and say why each is worth it.`;

const LOG_FROM_CHAT = `# Log what your user tells you

Goal: when a chat with your user (in Claude Code, Codex or any other agent)
holds something the workspace should remember, write it to Retainer, cited,
without your user having to ask. Your client may wake you after a turn with
a hint of what to log; the hint says where to look, not what to write.
Decide from the chat itself.

## What is worth logging

Log durable things about the people, companies and work the workspace
tracks: a deal moved, a renewal date, a new contact and their role, a
budget, a decision, a promise someone made, how a customer wants to be
reached. Skip the rest: your user's own code, questions to you, plans that
never left the chat, guesses, and anything already in Retainer. When unsure,
leave it out; a missed fact costs less than a wrong one.

## 1. Find the records

search or query_records for every person and company the chat names, then
get_context on each one you will write to. If what you learned is already
there with the same value, stop: there is nothing to log.

Ask your user before creating a company or a record of any object other
than person and task, and before writing to a record you matched only by a
similar name. Creating a person the chat clearly names, with an email or a
company, needs no question.

## 2. Log the source first

Where your user got it decides the source:
- They read it to you, or you read it with your own tools (an email, a
  meeting transcript, a calendar event): log that email or meeting as its
  own event with its own channel and ID, and cite it. Reading it does not
  make the chat its source.
- They told you themselves: the chat is the source. log_event a
  conversation with channel set to your client ("claude-code", "codex",
  "cursor"), medium "message", an externalId for this turn of the chat
  (its session or conversation ID plus the turn's own ID, or the time if
  your client has none), occurredAt now, a short title, and your own
  one-paragraph summary of what your user said in this turn. Put your
  user's email in participants and the records it concerns in about.
  Each turn you log is its own event: an event's time and summary are
  fixed once logged, so logging a later turn under the same externalId
  fails as a conflict.
- It has not happened yet (a meeting invite, a scheduled call): log_event
  refuses an occurredAt in the future, and a scheduled meeting can still
  move or be cancelled, so it belongs in an object, not an event. Log what
  has happened, the invitation, as its own event when it was sent, with
  its organizer and invitees as participants and an externalId of its own:
  the calendar event's ID plus ":invite:" and the time this invitation was
  sent, so an updated invitation for a moved meeting is a new event, not a
  conflict. Then look in describe_schema for an object that holds
  scheduled things, whatever its name: one with a date and time, linked
  to people or companies, and with a field for the calendar event's ID.
  If there is one, find the meeting's record by that ID with
  query_records, and create or update it citing the invitation, so a
  moved or cancelled meeting updates the same record. Without that field
  you cannot find the record again, so if the object lacks it, or there is
  no such object, the invitation is all you log: tell your user, and offer
  to add the field or the object following get_guide("schema_design").
  Either way, log the meeting itself once it has happened, under the
  calendar event's own ID.

## 3. Write what you learned

Write values, facts and tasks in the order the server instructions give
for any conversation, each citing the event from step 2 as source. Quote
your user's own words in a fact when it helps, and give a task the due date
that was said.

When you create a person who came back from step 2 unmatched, log that
event again with the same input and the new record's ID as the
participant's recordId, so the event shows on their timeline.

## 4. Tell your user

One line: what you logged and on which records, and anything waiting for
approval or for their answer. Do not go back to the task they were on
unless they ask; they will carry on themselves.`;

const MEMORY = `# Workspace and personal memory

Goal: keep what you learn that is not about a CRM record, so the next
session, and the other agents in this workspace, start knowing it. Two
memories hold it; you name them instead of a record ID in remember,
get_context and get_timeline:

- "workspace": what the business is and how it works, shared by everyone in
  the workspace and every agent connected to it.
- "me": the person you work for: their preferences, style and goals. Only
  they and their agents can see it, and it is deleted if they leave the
  workspace. describe_schema's builtIns entry "memory" lists "me" in profiles
  only when your credential works for a person; otherwise "me" is refused.

## At the start of a session

Call get_context("workspace") and, when you have one, get_context("me").
Act on what they say without being asked: write in the person's style,
follow the business's rules.

## What goes where

| What you learned | Where it goes |
| --- | --- |
| About a customer, contact, deal or other record | That record: a value with upsert_record, or remember |
| How the business works, rules for everyone | remember("workspace", ...) |
| About the person you work for: preferences, style, goals | remember("me", ...) |
| A remark for colleagues | Nowhere: that's a comment, written by a person |
| Passwords, tokens, health or other sensitive data | Nowhere |

Examples: "We sell a 12-month plan; we never discount more than 15%" and
"Don't call clients before 10am" go in workspace. "Prefers short
follow-ups" and "Writes to Israeli clients in Hebrew" go in me.

## Rules

- Never put customer knowledge in me. Colleagues and their agents can't see
  it, and it is deleted when the person leaves. Knowledge about Acme goes on
  Acme's record, even if the person told you.
- Check before writing. Read the memory first and skip a fact that is
  already there. When what you learned changes a fact ("I prefer long emails
  now"), remember the new one with supersedes set to the old fact's ID, so
  only the new one stays current.
- Fix a misplaced fact by moving it: remember it on the right record (or
  memory) with its text unchanged and supersedes naming the old one. Omit
  source and quote; Retainer copies its evidence. To change the text too,
  correct it where it is first, then move the correction.
- A shared fact cannot be replaced by one in me, and you cannot supersede a
  fact a person wrote: remember yours separately and tell your user.
- Cite a source when you learned the fact from a conversation you logged
  with log_event, as for any fact. A fact you learned in the chat itself
  needs no source.
- You cannot delete a fact. Your user removes one in Settings → Memory.`;

export const GUIDES = {
  discover_schema: {
    title: 'Discover the schema',
    description:
      "Explore the user's own data (email, calendar, spreadsheets, an old CRM export), " +
      'propose a Retainer schema that fits it, and apply it once the user agrees.',
    text: DISCOVER_SCHEMA,
    /** What the person says when they start the guide as a prompt. */
    promptIntro: "Set up this Retainer workspace's schema from my data.",
    /** Arguments the person can pass when starting the prompt. */
    promptArgs: z.object({
      sources: z
        .string()
        .optional()
        .describe(
          'Where to start, e.g. "my Gmail and the leads spreadsheet". Without it, the agent ' +
            'looks at everything its tools can reach.',
        ),
    }),
  },
  schema_design: {
    title: 'Design and grow the schema',
    description:
      'Rules for changing a schema in use: start lean, use events, facts and tasks ' +
      'instead of new objects, and grow fields from evidence. Also how to review one.',
    text: SCHEMA_DESIGN,
    promptIntro: "Review this Retainer workspace's schema with me.",
  },
  memory: {
    title: 'Workspace and personal memory',
    description:
      'What to remember in workspace (how the business works) and me (the person you work ' +
      'for), what belongs on a record instead, and how to correct and move facts.',
    text: MEMORY,
    promptIntro: 'Load what Retainer remembers about this workspace and about me.',
  },
  log_from_chat: {
    title: 'Log what your user tells you',
    description:
      'Write what a chat with your user taught you about people, companies and work ' +
      'to Retainer: what is worth keeping, which source to cite, and the order of the writes.',
    text: LOG_FROM_CHAT,
    promptIntro: 'Log to Retainer what this chat taught you about our customers and work.',
  },
} as const;

type GuideName = keyof typeof GUIDES;

export const GUIDE_NAMES = Object.keys(GUIDES) as [GuideName, ...GuideName[]];
