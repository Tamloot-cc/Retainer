# Retainer web app

Status: implemented, including record creation, deletion, merges and suggested
merges, `forget` and global
search, plus saved views with table, board and calendar layouts (5.3b), and
the Records and Activity split: event type lists, the activity feed,
comments and developer view
([conversations and activity spec](docs/specs/conversations-and-activity.md),
[comments spec](docs/specs/comments.md)).
Read `ARCHITECTURE.md` first; this document uses its section numbers.

Retainer is used by agents through REST and MCP. The web app is for the
people those agents work for. It does the jobs only a person can do and lets
them see what the agents remembered and why. It is not a CRM front end:
no dashboards, email sync or agent chat.

---

## 1. Decisions

| Decision      | Choice                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package       | `packages/web`, the private (unpublished) `@retainer/web`, **MIT**                                                                                 |
| Data source   | `@retainer/sdk` over the REST API only. Never imports `packages/server`                                                                            |
| Data model    | Every list, form and filter is built at runtime from `GET /v1/schema`; nothing is written per object                                               |
| UI kit        | Own components on Radix primitives and Tailwind CSS 4 (Button adapted from shadcn/ui), React 19                                                    |
| App shape     | Single-page app built with Vite; TanStack Router for routes, TanStack Query for server state                                                       |
| Hosting       | Static files served by the Retainer server at `/app`, same origin as the API, so the image stays one process and there is no CORS                  |
| Auth          | Key mode: a person signs in with their own `user`-actor API key, turned into an httpOnly cookie. Accounts mode: Google, Microsoft or a passkey (4) |
| Twenty        | A behaviour reference only. No Twenty code is copied or translated (2)                                                                             |
| First screens | Retainer's own: the review inbox, then records with provenance, facts and events                                                                   |

### Why a single-page app and not Next.js

Retainer has no use for server rendering: every screen is behind sign-in and
reads a JSON API. A Next.js server would be a second runtime to deploy next to
the Retainer image and a second place for the API key to live. A static build
served by the existing Hono server keeps self-hosting at one container.

---

## 2. Licensing rules

`packages/web` is MIT, like `shared`, `sdk` and `mcp`.

- **No server code.** `packages/web` depends only on `@retainer/shared`,
  `@retainer/sdk` and third-party packages. Types the UI needs from a
  response (the review queue, a presented record) move to `@retainer/shared`
  or the SDK; they are never imported from `packages/server`.
- **No Twenty code.** `twenty-front` is AGPL-3.0, and Twenty's application
  exception covers apps that call its APIs, not code taken from it. People
  may read Twenty to learn how a field type behaves (what an emails input
  does with additional values, how a relation picker searches). They must
  not paste, port or translate its files, and no file in `packages/web` may
  be written with a Twenty file open as the template. Section 6 names what
  to read for each type.
- **MIT sources may be copied** with their notice kept: shadcn/ui, and Comp
  AI CRM's `packages/ui` (`github.com/trycompai/crm`, MIT). Copied files keep
  a header naming the origin, and `packages/web/THIRD_PARTY.md` lists them
  with the upstream license text.
- Serving the built files from the AGPL server is aggregation; it does not
  change either license.

---

## 3. Package layout

```
packages/web/
  index.html
  vite.config.ts
  vitest.config.ts
  THIRD_PARTY.md
  src/
    main.tsx            router, query client, session, schema query, ⌘K, theme
    style.css           Tailwind theme tokens, light and dark
    api/                SDK client, session transport, workspace context, scope checks,
                        the /account client and Better Auth's browser client
    accounts/           accounts mode: sign-in, first run, invitations, settings, your account,
                        connecting an app over OAuth and the connected apps lists
    auth/               key-mode sign-in screen
    fields/             one folder per field type (6), shared code in common.tsx
    provenance/         actor badges, sourced values, pending markers
    routes/             the screens (5), grouped: records/, views/, events/, schema/, review/
    ui/                 the only source of UI (8): shell, data grid, sheet, popovers
```

The Vite dev server proxies `/v1`, `/auth`, `/account` and `/health` to
`pnpm dev`, so development is same-origin too.

---

## 4. Sign-in and permissions

### 4.1 Who a person is

Retainer knows callers only by API key (7). Each person gets their own key
from the operator CLI, with a `user` actor:

```sh
retainer key create --workspace acme --name "Maayan (web)" \
  --actor user:maayan --scopes read,write,admin
```

A shared key for several people is not supported: writes, accepted
assertions and approvals must name the person who made them (rule 2.3).

### 4.2 Session cookie (new server routes)

| Route                  | Does                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/session`   | Takes `{ key }`, checks it through `retainer_lookup_api_key`, sets the cookie and returns the same body as `GET /v1/me` |
| `DELETE /auth/session` | Clears the cookie                                                                                                       |
| `GET /v1/me`           | The caller's workspace (`id`, `name`, `slug`), actor and scopes. Works with a bearer key or the cookie                  |

- The cookie is `retainer_session`, `HttpOnly`, `Secure` (except on
  localhost), `SameSite=Strict`, `Path=/`, 30-day `Max-Age`. Its value is the
  key itself: the authentication middleware already looks a key up on every
  request, so revoking the key ends the session at once and no session table
  is needed.
- `authenticate` accepts the bearer header or the cookie. When both are
  present, the header wins.
- Cookie-authenticated `POST`, `PATCH` and `DELETE` requests must carry
  `X-Retainer-Client: web`, or they get `403 csrf`. Bearer requests are
  unaffected.
- The key is typed once on the sign-in screen and sent to `POST /auth/session`.
  The app never stores it in `localStorage`, `sessionStorage` or memory after
  that call.
- In accounts mode people sign in with an account instead of a key (4.4).

For TLS termination at a reverse proxy, set `RETAINER_PUBLIC_ORIGIN` to the
external origin (for example `https://retainer.example`). CSRF checks compare
the browser Origin to this configured value; forwarded headers are not trusted.
The setting also controls the cookie's public host and Secure handling.

### 4.3 What the UI shows by scope

The server enforces scopes. `admin` implies `read`, `write` and
`schema:write`; UI checks use these effective scopes. The web app additionally
restricts every mutation to a `user` actor. This UI restriction does not change
which actors the REST and MCP APIs allow to edit or retract data.

| Action                                                                 | Needs                             |
| ---------------------------------------------------------------------- | --------------------------------- |
| Browse records, facts, events                                          | `read`                            |
| Edit fields, retract facts and events, accept or reject pending values | `write` and a `user` actor        |
| Create, delete and merge records; dismiss merge suggestions            | `write` and a `user` actor        |
| Approve or reject schema changes                                       | `admin` and a `user` actor        |
| Apply a template                                                       | `schema:write` and a `user` actor |
| Erase a record for privacy (`forget`)                                  | `admin` and a `user` actor        |

A key with a non-`user` actor can sign in read-only, with a banner saying
why actions are missing.

### 4.4 Accounts mode

When the server runs in accounts mode
([accounts spec](docs/specs/accounts-and-access.md)), people sign in with Google,
Microsoft or a passkey and have a role in each workspace. The sign-in page asks
`GET /account/providers` which of Google and Microsoft are on, and shows a
button for each. The button for the way this browser last signed in says "Last
used", read from the `retainer.last_sign_in` cookie the server sets. The app finds out at startup:
`GET /account` answers `404` in key mode, `401` to someone signed out, and the
person otherwise.

- **Addresses.** A workspace's pages live under `/app/w/<slug>/`; the router's
  base path is read from the address once. Switching workspaces is a full page
  load, so nothing cached crosses over and a tab stays on its workspace.
  `/app/` opens the last workspace used, or the first-run screen ("Name your
  workspace") for someone with none. `/app/account`, `/app/invite/<token>`
  and the OAuth pages are outside any workspace.
- **Requests.** The SDK client sends `X-Retainer-Workspace` with the
  workspace's ID. Inside a workspace the `Session` is the same as in key mode,
  with the person's role as scopes, so `canMutate` and the table above apply
  unchanged.
- **Settings** (`/app/w/<slug>/settings`) and **Your account** (`/app/account`)
  follow the accounts spec 5.1. Screens show only what the person can do; the
  server checks every action again. Organization owners and admins delete the
  workspace from Settings, Workspace, by typing its name. Connected
  apps are listed under Settings, Agents (all of them for an admin, otherwise
  the person's own) and under Your account, each with Disconnect.
- **Connecting an app** (accounts spec 4.7). An app such as Claude sends the
  browser to `/app/oauth/sign-in`, which signs the person in if needed and
  continues the authorization, then to `/app/oauth/consent`. That page names
  the app, lists the person's workspaces with their role in each, and shows
  what the app could do in the one picked, which is the app's scopes capped by
  that role. Any app can register under any name, so the page also names the
  site Allow sends the person back to (the signed `redirect_uri`'s host).
  Allow posts the choice to `POST /account/oauth/consent`. No other
  site may frame `/app` (`frame-ancestors 'none'`), so the consent page cannot
  be clickjacked. `/app` sends only its origin as `Referer`
  (`Referrer-Policy: strict-origin`), so an OAuth page's long address doesn't
  push a request past API Gateway's 10 KB header limit.
- Better Auth's browser client and the passkey plugin load only in accounts
  mode.

---

## 5. Screens

URLs hold all list state (filters, sort, cursor, open tab), so a copied
address reproduces the view.

### 5.1 Sign in — `/app/sign-in`

One field for the key, one button. Errors from `POST /auth/session` are shown
as the server words them.

### 5.2 Review inbox — `/app` (home)

The first screen built and the default after sign-in. Source: `GET /v1/review`
and `GET /v1/schema/changes?status=proposed`.

Tabs, each with a total count from the server, independent of the loaded
page. Each tab has its own cursor and Next page and First page controls (9.1); no tab may
silently truncate outstanding items. Counts and pages reflect live data and
are refreshed after decisions. A record links to a review item using its
assertion ID in the URL; the inbox fetches that item directly even when it
is outside the loaded page.

Tabs:

1. **Pending values.** One row per pending assertion: record label and
   object, field label, **current value → proposed value** rendered with the
   field type's display (6), who proposed it (actor badge, 7), the reason in
   plain words, confidence, `observedAt`, and the source event's type, title
   and date with a link to it (5.6).

   | `reason`          | Shown as                                                           |
   | ----------------- | ------------------------------------------------------------------ |
   | `outranked`       | "Newer than a value a person or integration set"                   |
   | `low_confidence`  | "Below the workspace's confidence threshold"                       |
   | `unique_conflict` | "Another record already has this value" with a link to that record |

   Accept and Reject per row (`POST /v1/assertions/:id/accept` · `/reject`),
   and for a selection of rows. Accepting writes as the signed-in person
   (rule 2.3), preserving the original `observedAt` and source. Acceptance
   does not promise that the proposed value becomes current: inspect the
   returned per-field outcome and record. If a newer human value still wins,
   show "Accepted; a newer value remains current" and the current value.
   A unique conflict leaves the item pending and shows the conflicting record
   when available. A `409 not_pending` removes the row with a note that it is
   no longer pending. Deleted sources, deleted fields, merged records and
   values that no longer validate show the server error and refresh the item;
   they must not be presented as successful decisions.

   Bulk review calls the existing single-item routes with bounded concurrency.
   Results are independent, not atomic: report success or failure per item,
   keep failed pending items selected, and retry only failures. Never replay
   successful decisions automatically.

2. **Schema changes.** Proposed changes with their operations listed in
   words ("Add field _Renewal date_ (date) to _Company_"), the proposing
   actor and time. Approve and Reject for `admin` keys
   (`POST /v1/schema/changes/:id/approve` · `/reject`). Approving refreshes
   the cached schema (6.3). An approval that no longer validates shows the
   engine's reason and links the records in the way (`recordIds`), such as
   those still holding an option being removed.

3. **Unresolved participants.** Handles from logged events that match only
   a deleted record (1.2). Read-only in v1, with links to the event.

4. **Suggested merges.** One card per pending pair from the consolidator:
   the reason, the object and both records' labels (`records` on each
   suggestion, resolved through `references()`). "Compare and merge" opens
   the merge dialog (5.4a) for the pair, which also offers "Not duplicates"
   (`POST /v1/review/merges/:id/dismiss`).

### 5.3 Object list — `/app/o/:object`

One route for every object. Source: `POST /v1/objects/:object/query`.

- A full-width, spreadsheet-style grid with a sticky header and a sticky
  label column.
- Columns come from the object's fields in schema order. The label field is
  first and pinned. Inverse relations and `json` fields are hidden by
  default. The column menu shows, hides and reorders the rest; headers can
  also be dragged to reorder and their edges dragged (or arrow-keyed) to
  resize. Order and widths are saved per object in `localStorage`
  (`retainer:columns:v2:…`, migrating the v1 visible-columns list).
- Filters are offered for `isFilterable` fields only, with the operators
  each type supports (6). Each active filter is a removable chip in the
  toolbar; several chips are ANDed. The URL filter is read as one flat AND:
  parts the chips can't express (`or`, `not`) show as "Custom filter" chips
  and stay in place while other chips are added, replaced or removed.
- Click a sortable header to sort ascending, descending, then off. The Sort
  menu also offers Updated and Created.
- Cursor pagination with `limit` 50. A footer shows the row range out of
  the total the view matches ("51–100 of 230") and Previous/Next; Previous is
  remembered for pages reached in this visit, otherwise it returns to the
  first page.
- Under the rows, each column's footer offers **Calculate**: empty and not
  empty (count or percent) for every column, unique values for scalar,
  select and many-to-one relation columns, sum and average for number and
  money, min and max (earliest and latest for dates). They come from
  `POST /v1/objects/:object/aggregate` with the list's filter, so they cover
  every matching record, not the page; "empty" counts the same records as
  the `isNull` filter. Money in more than one currency shows "mixed
  currencies" rather than a sum. The chosen calculations are saved with the
  column preferences.
- With `write` and a `user` actor, each row has a checkbox, and the header
  box selects the page. Selecting replaces the filter bar with the count and
  its actions: **Delete…** for any number, **Merge…** when exactly two are
  selected (the merge comparison of 5.4a). The delete warning comes from
  `POST /v1/records/delete-impact`, which counts what all the selected
  records cascade to once each. Records are then deleted one by one; one
  already gone counts as deleted, and any that fail stay selected and are
  named in the report. Selection belongs to the page and view: paging,
  filtering or sorting clears it.
- Writable cells (as in 5.4) show a pencil on hover or focus that opens the
  record page's inline editor in a layer next to the cell, with the same
  stale-write guard. Editing does not open the record, and the footer
  totals refresh after a save.
- A **New** button (`write` and a `user` actor) opens a form built from the
  object's fields: the label field first, then required fields, then the
  rest; inverse relations, read-only fields and `json` are left out. Empty
  optional fields are skipped, required ones are checked before sending and
  values pass the shared validation (9.3). It sends
  `POST /v1/objects/:object/records` with an `Idempotency-Key` that lives as
  long as the form, so a retry after a lost response cannot create a second
  record. Server errors land on their field: `422 invalid_values` per field,
  and a `409 unique_conflict` or `409 suppressed` on the field it names, with
  a link to the record that holds a conflicting value. The new record opens
  in the side sheet.
- **Event type lists** use the same grid with event defaults. They sort by
  `occurredAt`, newest first, until another sort is chosen. After the title
  they show Occurred, the type's own fields (`medium` first, for
  conversations), Participants, About and Source (`channel`); the summary and
  External ID are available in the column menu but hidden. These built-in
  columns are read-only; Occurred, Source and External ID can be filtered
  and sorted with the operators the query engine takes on them, and they
  have no footer totals. A **Table / Calendar** switch shows a month
  calendar of when events happened (`?layout=calendar`) without a saved
  view. In place of the New button the top bar shows one muted line,
  "Logged by agents and integrations.", which opens a short help popover
  naming `log_event` and `POST /v1/events`. Merge is never offered; with two events selected the
  selection bar says "Events can't be merged".
- Clicking a row, or its label link, opens the record in a side sheet that
  slides in over the list (5.4 content). The open record is the `record`
  search parameter, so Back closes the sheet and a copied address reopens
  it; the row stays highlighted. The sheet is non-modal: clicking another
  row swaps the record without closing it. Escape or the close button
  closes it, and "Open full page" goes to `/app/r/:id`. Its memory tab and
  page are local to the sheet, since the list owns `cursor`.

### 5.3a Shell

- A left sidebar: workspace, Find anything (⌘K), Review inbox with its
  pending count, then two labeled groups. **Records** lists the entity
  objects (standard ones first, each with its icon). **Activity** starts
  with **All activity** (5.3c), then lists each event type. Event types
  take their icons from one family (squared speech marks), so the two
  groups are told apart at a glance. Then Schema, and the signed-in actor,
  whose account menu holds the **Developer view** switch (5.8) and Sign out.
  `main.tsx` passes each object's `class` to the shell.
- It collapses to an icon rail with its toggle or ⌘\, remembered in
  `localStorage`; the rail keeps a divider between the two groups. Below
  `md` it is a drawer opened from the top bar.
- Every screen has a slim top bar with a breadcrumb and the screen's
  actions. Record lists fill the width; other screens use a readable
  centred column.

### 5.3b Saved views — `?view=`

A saved view (`ARCHITECTURE.md` 1.4) is a named filter, sort and column
set for one object, shown as a table, a board or a calendar. Source:
`GET /v1/objects/:object/views`.

- **Switcher.** The toolbar's first control names the open view and lists
  "All {objects}" (the plain list of 5.3) and every view the caller can
  see; private views carry a lock. With `write` it also offers New view,
  Edit view and Delete view. New view copies the filter, sort and columns
  on screen, and asks for a name, a layout (Table, Board, Calendar), the
  field the layout needs, and who can see it. Only a view's creator can
  change who can see it.
- **State.** The open view is `?view=`. The last view used per object is
  remembered in `localStorage` (`retainer:view:v1:{workspace}:{object}`)
  and reopened from the sidebar. A view that is gone or hidden says so and
  returns to All. The server repairs a view when the schema changes under
  it; anything a read still drops is listed in a notice (the view's
  `issues`). A board or calendar whose field went asks for a new one.
- **Unsaved changes.** The URL `filter` and `sort` run over the view's own;
  `{}` and `[]` mean "none" where the view has some, and a change back to
  the view's value clears the parameter. While they differ, the toolbar
  shows **Reset** and, with `write`, **Save view**, which writes them to
  the view. Without a view, a filter or sort offers **Save as view…**.
  Column changes on a view save to it directly; keys that can't write keep
  them for the session.
- **Board.** One column per option of a single-select field, in option
  order, then "No {field}" if the field is optional. Each column pages on its own (25 at a time, "Show
  more"), shows its count, and can show a sum, average, min or max of a
  number or money field, from `POST /v1/objects/:object/aggregate` with
  `groupBy`. Options shows or hides columns and picks the total. Cards show
  the label and up to four non-empty fields in the view's column order
  (the Card fields menu).
- **Calendar.** A month of whole weeks, starting on the viewer's first day
  of the week (`Intl.Locale` week info), with records on the day of a date
  or date-time field (a date-time on the viewer's local day). The month is
  `?month=yyyy-MM`. A day shows three records, or two and "N more", which
  opens the rest. The header counts records with no date. A month loads up
  to 1,000 records and says when there are more.
- **Moving.** With `write` and a writable field, a card can be dragged to
  another column, or a calendar record to another day, with a mouse, by
  touch (after a short press) or from the keyboard: Space picks it up, the
  arrows jump to the next column or day, Space drops it and Escape cancels.
  Each step is announced to screen readers. A move is a normal record
  `PATCH` with the stale-write guard; a date-time keeps its time of day. The
  card shows at its new place while it saves; a value held for review, a
  superseded value or a stale write puts it back and explains why. Cards
  have no manual order: a column follows the view's sort.
- Clicking a card or calendar record opens the side sheet as in the table.

### 5.3c All activity — `/app/activity`

A feed, not a grid: people read activity by time, not by column. Source:
`POST /v1/events/query` (every visible event type, never internal notes),
with `include: ["relationReferences"]` so participants and `about` records
are named without a read each.

- Newest first, 30 at a time with **Load more** on the cursor. Events are
  grouped by the viewer's local day under a heading that stays in view:
  Today, Yesterday, then the date (with the year when it is not this one).
- Each row shows the type's icon, the medium as a chip when there is one,
  the title, two lines of summary, participants ("With", matched ones
  linked, other handles as text), the `about` records as linked chips
  ("About") and the time.
- Filters live in the address only (saved views stay per object): event
  type (`eventTypes`, several allowed), source (`channel`), a date range
  (`from` and `to`, local days, both included) and one linked record
  (`linked`, chosen with a record picker over every entity object). Each
  shows as a removable chip, like list filters; a linked record's chip
  names it from the page or a single label read.
- Clicking a row opens the event in the side sheet, as record lists do
  (`?record=`).

### 5.4 Record — `/app/r/:id`

Source: `GET /v1/records/:id`, its provenance (9.1), facts and events.
An ID that was merged loads the surviving record and says so. The header's
breadcrumb (and the side sheet's) starts with a quiet class label before
the object's name: "Record · Company" or "Activity · Conversation".

Three areas:

- **Fields.** Every field with its type's display. Each value carries its
  provenance (7): who wrote it, when it was observed, and the source
  event. A field with a pending assertion shows a marker that links to
  that row in the review inbox. Clicking a field's value (or its Edit
  button) edits it in place with the type's input, here and in the list's
  side sheet; Enter or Save writes and Escape cancels (inside the sheet,
  Escape cancels the edit before it closes the sheet). Saving sends
  `PATCH /v1/records/:id` with the record's
  `updatedAt` as `expectedUpdatedAt` (rule 2.5). A `412 stale_write` shows
  the new value instead of overwriting it, preserving the unsaved draft so
  the person can compare, discard it, or explicitly retry against the latest
  version. A history button opens every
  assertion for that field, including superseded, rejected and retracted
  ones, newest first.
- **Relations.** Many-to-one fields render as a link to the target. Each
  inverse (one-to-many) field renders as a short list of linked records with
  a link to the filtered object list.
- **Tabs** (`MemoryTabs`), the same on the record page, the event page and
  the side sheet. An entity has Comments, Facts, Activity, History and, only
  when a relation field on the `task` object can point at its type, Tasks.
  An event has Comments, Claims and History: an event has no activity
  of its own, and no tasks. `remember` can still store a fact on an event, so
  one that has some also shows Facts. A record opens on Comments when it has
  any and an entity otherwise opens on Facts; an event opens on Comments.
  That is chosen once per visit, so deleting the last comment moves nobody.
  Comments, Facts, Claims and Tasks show a count from
  `GET /v1/records/:id?include=counts` when above zero; for Tasks it counts those
  not done. Activity and History don't, since they fan out. An info button at the end of the row explains
  the current tab in plain words, in a tooltip; it stays in view when the row
  scrolls.
  - _Comments_: `GET /v1/records/:id/comments`. Oldest first, as a
    conversation reads, with "Load earlier comments" above and the box below.
    Author, time, "edited", text with its line breaks. Enter adds a line and
    ⌘/Ctrl+Enter posts. A draft is kept per person and record for the visit,
    in memory only, with an idempotency key that changes only with the text,
    so a retry after a lost response posts once and keeps the draft until it
    has. The author edits in place; the author or an admin deletes, after
    confirming. Agents and read-only keys read and see no box. Comments are
    in no other list.
  - _Facts_: `GET /v1/records/:id/facts`. Content, `validFrom`, writer, and
    each source with its quote; a fact resting on an internal note says so,
    without a link. Retract (`DELETE /v1/facts/:id`) asks for confirmation.
  - _Activity_ (`?tab=events`): `GET /v1/records/:id/events`, newest first (9.1). Type badge,
    title, date, how the event is attached (participant, about, through one
    of its fields, or rolled up from a record pointing at this one, linked),
    summary, and participants, matched ones linked.
  - _History_: `GET /v1/records/:id/timeline?types=field_change`, grouped by
    day, newest first, on entities and events alike. Each value asserted for
    a field reads "<Field> set to <value>" with who set it and the cited
    event, and one that is not the current value says so, never as a change
    from an earlier value. Events and facts have their own tabs, so they are
    not repeated here. Filtered by field, kept in the URL (`fields`); a stale
    cursor offers to start again. An address with the old `?tab=timeline`
    opens History.
  - _Tasks_: tasks linked to the record. A status menu, built from the status
    field's options since a workspace can add, rename and remove all but
    `done`, shows every task that is not done by default, and any statuses
    chosen, kept in the URL (`tasks`: a comma list, or `all` when none is
    chosen). Done tasks have a checked circle and a struck-through, muted
    title; the rest have an empty circle. Soonest due first, or latest due
    first when showing only done tasks. Each row has its status and due date
    read through their role fields, so a rename keeps working.
  - _Claims_ (events): `GET /v1/events/:id/claims?own=false`. Values on
    records and facts that cite the event, not the values it logged itself.

  One list style across every tab: `Entry` rows in `EntryList`, an icon, a
  title, the time at the far end, then the text and who or where it came
  from, divided by a line. Long text wraps inside the row; facts and summaries
  clamp with "Show more". Every list adds its next page in place with "Load
  more". Empty tabs say what would appear, without a frame, and a first load
  shows placeholder rows. The tab row sticks under the header while the tab
  scrolls; the panel always fills the screen under it, so switching tabs never
  moves the row, and a tab opened while the row is stuck starts at its top.

### 5.4a Record actions

A menu in the sheet's header and the record page's top bar, for `write` keys
with a `user` actor. Each action confirms in a dialog first. When the
record is gone, the screen leaves it (the sheet closes; the page goes to the
object list) and the shell shows what happened above the next screen until
dismissed.

- **Merge a duplicate…** searches the same object for the other record,
  then opens the merge dialog with the current record as the survivor. The
  dialog (shared with suggested merges) asks which record keeps its ID, the
  older one by default, and lists only the fields where the two differ. A
  field only one record has keeps that value. Where both have one, the
  person picks the kept record's, the merged record's, or the server's rule
  ("Newest wins", or "Combine both" for emails, phones and links); only
  explicit picks are sent as `values`. `POST /v1/records/:id/merge` carries
  an `Idempotency-Key` per dialog. A merge cannot be undone, so its button
  is `destructive`.
- **Delete…** soft-deletes the record (`DELETE /v1/records/:id`). The
  dialog names the records a delete would take with it, counted by object
  (`GET /v1/records/:id/delete-impact`, which follows cascading relations
  at any depth with the same traversal as the delete), and enables its
  button once that count is in. The report counts what the server deleted.
- **Erase for privacy…** (`admin`) runs `forget` (ARCHITECTURE.md 2.1). The
  dialog lists what is erased and that emails and phones are blocked from
  coming back, and enables its button only once the person types the
  record's label (or "erase" when it has none). The report gives the
  server's counts and links the review candidates' records and events
  (labels fetched for the first ten of each), and counts candidate facts.

### 5.5 Search — `⌘K`

`POST /v1/search` as the person types (after a 200 ms pause): records grouped
by object, then events, then facts, each list ranked by the server. A
record hit found only by the fuzzy label fallback is marked "similar name".
A fact opens its record on the Facts tab. Below the results, objects whose
name matches jump to their list.

### 5.6 Event — `/app/e/:id`

Source: `GET /v1/events/:id`. Type, medium (when the type has a `medium`
select and it is set) and source beside it, time, title, summary, the
type's other fields, participants (matched and unmatched with the reason),
the records it is about (by label, each a link), and everything that cites
it: field assertions and facts (9.1). The UI calls `channel` **Source**
everywhere. A source or external ID erased for privacy says so.
Participants and `about` records can be added and removed (a person only).
Delete (`DELETE /v1/events/:id`) shows the server's counts afterwards:
retracted assertions, recomputed records and hidden facts. An event opened
as a record (`/app/r/:id`) shows the same details and links here.

Events are logged by agents and integrations, so event types have no "New"
button. People write comments on them instead (5.4). An event's **About**
picker, and the Activity feed's **Linked record**, offer entities only; links
to events from before that rule still show and can be removed.

### 5.7 Schema — `/app/schema`

Read-only in v1. Agents change the schema; people approve (5.2). Three tabs
(`?tab=`), with a "N proposed" link to the review inbox in the top bar when
changes are waiting:

- **Objects.** It opens with one short paragraph per class: what a record
  is and how it is written (`upsert_record`,
  `POST /v1/objects/:object/upsert`), and what an event is and how it is
  logged (`log_event`, `POST /v1/events`). Then a list of objects (standard first, with icon and field count)
  beside the selected one (`?object=`): its API names, owner, label field,
  description and a link to its records. Its fields are a table that can be
  filtered: label and API name, type with an icon and what the settings add
  ("Single select · 4 options", "Relation · One Company"), checks for
  Required, Unique, Filterable and Searchable, and the owner (`system`,
  `workspace`, `agent`). Clicking a field opens it in a side sheet
  (`?field=`): definition, select options, the relation's target,
  cardinality, other side (linked) and delete behaviour, and each flag in
  words. Entities are listed under **Records** and event types apart under
  **Activity**, with an "Event" badge and their built-in columns
  (`occurredAt`, `channel` shown as Source, `externalId`); their protected
  title and summary fields are marked. Under the objects, a "Built-in" list holds facts
  (`builtIns` from `GET /v1/schema`): each shows its description, its fields
  with a line on each, and the tools that write and read it, with nothing to
  edit.
- **Diagram.** The objects as cards on a React Flow canvas (`@xyflow/react`)
  that pans, zooms and lets cards be dragged. Each card lists the field that
  names its records and its relation fields, with what each links to ("One
  Company", "Many People"). Each relation is one line from the many side's
  row to the one side's row (an unmatched one-to-many field still gets one),
  ending in a crow's foot on the many side and a bar on the one side.
  dagre (`@dagrejs/dagre`, MIT) lays the cards out in columns, with what is
  linked to on the left; a line that skips a column runs above or below the
  cards in it, and lines between two columns get their own lanes. Dragging a
  card switches the lines to plain stepped paths. Hovering a card or a line
  highlights its lines. Clicking a card's header opens the object in the
  Objects tab, and clicking a row or a line opens that field there. React
  Flow and dagre load only when the tab is first opened (`Diagram` in
  `src/ui` is lazy). Event types are drawn as a distinct card (a tinted
  header and a round icon, "Event" in the meta) with an About row, and each
  draws `about` as a dashed line to one dashed "Any record" card, so the
  link shows in the model without a fake relation field. The legend
  explains the dashed line; clicking either opens nothing, as neither is a
  field.
- **Change history.** `GET /v1/schema/changes` as a timeline, filterable by
  status (`?status=`): each change's operations in words, reason, proposer,
  who decided, and the schema version it produced.

A workspace with no template applied shows the template list
(`GET /v1/templates`) and an Apply button for `schema:write` keys.

### 5.8 Developer view

A **Developer view** switch in the account menu, remembered per browser in
`localStorage` (`retainer:developer-view:v1`; refused storage leaves it off
and the switch still works for the visit), available to every actor. It
changes what is displayed, never what is sent. When on:

- Object and field labels show their API names beside them: list column
  headers and the list's title, the filter and sort menus, the record's
  fields and relations, the event's details, and the create form.
- Record and event pages, and the side sheet, show a Developer section: the
  object's API name and class (`entity` or `event`), the record ID with a
  copy button, and the write path: `upsert_record`,
  `POST /v1/objects/:object/upsert` and `PATCH /v1/records/:id` for
  entities, `log_event` and `POST /v1/events` for events.
- Event rows show their raw identity: on a record's Activity tab, `via` and
  `externalId`; in the activity feed, the type's API name, `channel` and
  `externalId`. The Comments tab names its route, and each comment its ID and
  author actor.
- A **JSON** tab on record and event pages shows the REST response as
  returned (`?tab=json`; without developer view the address falls back to
  the first tab).

### Not in v1

Creating or editing objects and fields in the UI, manual card order on
boards, week and day calendars, dashboards, workspace and key management (operator CLI only, 7.1), several
workspaces per session, bulk record actions, and context packs
(`GET /v1/records/:id/context`, which serves agents).

---

## 6. Field types

### 6.1 One module per type

`src/fields/<type>/` exports:

| Export    | Does                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `Display` | Read-only rendering for a table cell (`compact`) and the record page (`full`)         |
| `Input`   | Editing control; produces a value that passes the type's schema in `@retainer/shared` |
| `Filter`  | The operators offered in the list filter bar for `isFilterable` fields                |
| `isEmpty` | Whether a value counts as empty for display                                           |
| `label`   | The type's name where the schema is shown, e.g. "Single select"                       |
| `icon`    | The type's icon on the schema page                                                    |

A registry maps every `FieldType` in `@retainer/shared` to its module, and a
unit test fails when a type has no module. Before implementing inputs,
extract the server's pure field-aware validation and normalization into
`@retainer/shared` (9.3). Both server and UI use it; the existing composite
Zod shapes alone are not equivalent to server validation. Local validation
covers value shape and field settings. The server remains authoritative for
uniqueness, relation targets, scopes, concurrency and other database checks.

### 6.2 Behaviour per type

The last column is where to read how Twenty behaves (2). Paths are under
`packages/twenty-front/src/modules/`.

| Type           | Display                                                  | Input                                                                 | Twenty reference                              |
| -------------- | -------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `text`         | Single line, full text on hover                          | Text field                                                            | `ui/field/display/components/TextDisplay`     |
| `number`       | Locale formatting                                        | Numeric field                                                         | `NumberFieldInput`                            |
| `boolean`      | Check or dash                                            | Yes / No list in place; a switch in forms                             | `BooleanDisplay`                              |
| `date`         | Date in the viewer's locale                              | Date picker                                                           | `DateDisplay`                                 |
| `date_time`    | Date and time in the viewer's time zone, ISO on hover    | Date and time picker                                                  | `DateTimeDisplay`                             |
| `select`       | Option label as a badge                                  | Searchable list of `settings.options`; saves on the pick              | `SelectDisplay`, `SelectFieldInput`           |
| `multi_select` | Badges, overflow as "+n"                                 | Searchable list, a check per option; saves when the list is left      | `MultiSelectDisplay`, `MultiSelectFieldInput` |
| `money`        | Amount from `amountMicros` with `currency`               | Amount plus searchable currency picker; micros without floats         | `CurrencyDisplay`, `CurrencyFieldInput`       |
| `emails`       | Primary, "+n" for additional                             | List editor: add, remove, set primary; at most `settings.maxValues`   | `EmailsDisplay`, `EmailsFieldInput`           |
| `phones`       | Primary with country, "+n"                               | List editor with country code                                         | `PhonesDisplay`, `PhonesFieldInput`           |
| `links`        | Primary label or host, "+n"                              | List editor of URL and label                                          | `LinksDisplay`, `LinksFieldInput`             |
| `full_name`    | "First Last"                                             | Two fields                                                            | `FullNameFieldInput`                          |
| `address`      | One line: city, country; full address on the record page | Grouped fields; `lat`/`lng` shown, not edited                         | `AddressFieldInput`                           |
| `relation`     | Target record's label as a link                          | Record list searching the target object; inverse fields are read-only | `RelationManyToOneFieldInput`                 |
| `json`         | Collapsed preview, formatted on the record page          | Read-only in v1                                                       | `JsonDisplay`                                 |

In a table cell, a list (`multi_select`, `emails`, `phones`, `links`, a set
of `relation`s, an event's participants) stays on one line: `FitList` shows
as many items as the column's width holds, then "+n" for the rest, and
widening the column shows more and lowers the count. Single values truncate
with an ellipsis.

Composite values are replaced whole (rule 2.2), so list editors send the
complete value, not a diff.

Editing in place (a grid cell or a record's field) opens the list itself
for `select`, `multi_select`, `relation` and `boolean` (`FieldPicker`), and
a small form for the rest. A click outside saves a changed draft, Escape
drops it, and an unchanged value is never written, so it adds nothing to
the field's history. A multi select keeps its picks until the list is left:
a click outside, Enter with no option highlighted, or ⌘/Ctrl+Enter.

### 6.3 Schema cache

`GET /v1/schema` returns `workspace.schemaVersion`. The schema is cached in
TanStack Query under `[workspaceId, 'schema']`, with a copy under
`[workspaceId, 'schema', schemaVersion]`, and re-read on window focus and
after any schema approval. A `404` on any API read triggers one schema
refetch and one retry of the request before showing an error.

### 6.4 Mutation and session cache rules

All workspace queries include `workspaceId` in their keys. On logout, an
expired or revoked session, or replacement of the signed-in identity, cancel
in-flight queries and clear cached data before rendering another session.
Responses from the previous session must not repopulate the new cache.
Column preferences use workspace and object identifiers in their storage keys.

After a mutation completes, invalidate the affected queries:

| Mutation                                                   | Refresh                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Record edit                                                | Record, object lists, field provenance/history, review pages and totals                                         |
| Assertion accept or reject, including partial bulk results | Review pages/totals and affected records, lists, provenance/history and event claims                            |
| Schema approval or template application                    | Schema, schema changes, review totals, and record/list queries built from the old schema                        |
| Fact retraction                                            | Record facts and the cited events' claims                                                                       |
| Event deletion                                             | Event and claims, affected records and their lists, provenance/history, facts, event lists, review pages/totals |

If the response does not identify all affected queries, invalidate the broader
workspace query group. On `412`, refetch the record before offering an explicit
retry. Refetch active data on window focus to pick up agent and reviewer writes
from other clients; mutation responses are not a substitute for fresh reads.

---

## 7. Provenance

Provenance is what sets this app apart, so every value shows it the same
way.

- **Actor badge.** The four actor types (`user`, `integration`, `agent`,
  `system`) each get a fixed icon and label, with the actor's `name` (or
  `id`) next to it.
- **Sourced value.** A value written by anyone other than the viewer has a
  dotted underline. Hovering or focusing it shows: who wrote it, when it was
  observed and the source event's title and date (field assertions
  carry no quote). This follows Comp AI's `SourcedValue` and `Provenance`
  components, which may be copied (2).
- **Pending marker.** A field with a pending assertion shows a small badge
  with the proposed value on hover and a link to review it.
- **History.** Opened per field (5.4): every assertion with status, actor,
  `observedAt`, source and, for reviewed ones, who decided.

---

## 8. Design rules

Taken from Comp AI CRM's `docs/design.md`, which works well for a tool like
this:

- `src/ui` is the only source of UI. Screens compose its components and do
  not pass styling `className`s; a new look is a new variant in `src/ui`.
- Only two things are filled: `primary` for the action you want and
  `destructive` for the one you cannot undo. Everything else is outline or
  ghost.
- One brand colour, the same value in light and dark. Neutral greys.
- Radius from the scale only: `rounded-sm` for small controls, `rounded-md`
  for buttons and inputs, `rounded-lg` for popovers, dialogs and table
  shells.
- Light and dark themes from the start, following the system setting.
- Keyboard first on the review inbox: `j`/`k` to move, `a` to accept,
  `r` to reject, `x` to select.
- No native `<select>`. A choice is a `SelectMenu` (a button opening a
  searchable `OptionList`); a list of actions or of one-of-many settings is
  a `Menu`. Lists move with the arrow keys and pick with Enter.
- Checkboxes, radios and switches use the drawn `ui-checkbox`, `ui-radio`
  and `ui-switch` styles in `style.css`, never the browser's.

---

## 9. Server and SDK work this needs

### 9.1 New or changed routes (AGPL server)

| Route                                                     | Purpose                                                                                                                         | Needed by |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `POST` · `DELETE /auth/session`                           | Cookie sign-in (4.2)                                                                                                            | 5.1       |
| `GET /v1/me`                                              | Workspace, actor and scopes of the caller                                                                                       | 4.3       |
| Cookie in `authenticate`, CSRF header check               | 4.2                                                                                                                             | all       |
| Static files at `/app`                                    | Serves `packages/web/dist` when `RETAINER_WEB_DIR` is set; the Docker image sets it. Unknown `/app/*` paths return `index.html` | all       |
| `GET /v1/records/:id/assertions`                          | Every assertion for the record, optionally by `field`, with status, actor, `observedAt`, source and reviewer                    | 5.4, 7    |
| `GET /v1/records/:id/events`                              | Events attached to the record, newest first, with `via`, cursor-paginated                                                       | 5.4       |
| `GET /v1/records/:id/timeline`                            | Events, asserted field values and facts, newest first, filtered and cursor-paginated                                            | 5.4       |
| `GET /v1/events/:id/claims`                               | Assertions and facts that cite the event                                                                                        | 5.6       |
| Per-field provenance on `GET /v1/records/:id`             | With `?include=provenance`, each field's winning assertion: actor, `observedAt`, source, and whether a pending assertion exists | 5.4, 7    |
| Review and schema-change pagination                       | Add the contracts below to the existing list routes                                                                             | 5.2, 5.7  |
| `GET /v1/assertions/:id`                                  | Fetch an assertion directly for review deep links, including its current status                                                 | 5.2, 5.4  |
| Review enrichment                                         | Source event summary and current conflicting record reference, as below                                                         | 5.2       |
| Relation references on record reads and queries           | Optional resolved labels alongside existing relation ID values, as below                                                        | 5.3, 5.4  |
| `POST /v1/objects/:object/aggregate`                      | Total and per-column calculations over the records a filter matches                                                             | 5.3       |
| `POST /v1/records/delete-impact`                          | What deleting several records together would cascade to, overlaps counted once                                                  | 5.3       |
| `groupBy` on the aggregate route                          | The same calculations per option of a single-select field, plus the overall result                                              | 5.3b      |
| Saved views: `/v1/objects/:object/views`, `/v1/views/:id` | List, create, read, update and delete views (`ARCHITECTURE.md` 1.4)                                                             | 5.3b      |
| `POST /v1/events/query`                                   | Events of every visible event type, newest first, filtered by `type`, `channel`, `occurredAt` and `linked`, cursor-paginated    | 5.3c      |
| Participant and `about` labels on event queries           | `include=relationReferences` on per-type and cross-type event queries also names participants, candidates and `about` records   | 5.3, 5.3c |

The v1 read contracts are:

- **Review pages.** Preserve the existing arrays on `GET /v1/review` and add
  `totals` and `nextCursors`, each keyed by `pendingAssertions`,
  `unresolvedParticipants` and `mergeSuggestions`. Accept a separate cursor
  for each collection; each has a limit and deterministic ordering by time
  and ID. Schema changes return `{ changes, total, nextCursor }`, accepting
  `cursor` and retaining the `status` filter. Totals count all matching items,
  not just a page. Define cursors so removing reviewed items does not skip
  remaining work; do not paginate a shrinking inbox by offset.
- **Review details.** List items and direct assertion reads include nullable
  `source: { id, title, occurredAt }` and
  `conflictingRecord: { id, object, label }`. A missing, retracted or no-longer
  conflicting reference is represented as null. Conflict links describe the
  current claim, which the server rechecks on acceptance.
- **Object-scoped keyword lookup.** `POST /v1/objects/:object/query`
  accepts optional `search` text, ANDed with structured filters. Use Postgres
  full-text matching over the existing record search vector, under the same
  workspace/object restrictions. This supports relation pickers and the
  current-object command palette even when the label field is not filterable.
  Global search, ranking and context packs are separate routes.
- **Relation labels.** Record reads and queries support
  `include=relationReferences` (an `include` array on query requests), returning
  one separate response-level map keyed by target ID
  with `{ id, object, label }`, leaving field values as IDs. Resolve targets
  in batches through the shared record-reference presentation path under RLS;
  the UI must not fetch each relation separately. Omit unavailable targets
  and render an unavailable-reference state rather than inventing a label.
- **Other growing collections.** Assertion history, record events, event
  claims and record facts provide cursor pagination and
  `nextCursor`; their screens expose a Next page or Load more control rather than silently stopping
  at the current server limits. Comments page the same way.

Relation filters by target ID already exist in the query engine (`eq` and
`in`); use them for inverse-relation links, respecting `isFilterable`.

Each route lands with API-layer tests (12, layer 3). The cookie and CSRF
rules get tests for: cookie only, header only, both, revoked key, and a
cookie-authenticated write without the CSRF header.

Merge suggestions in `GET /v1/review` carry `records`: the object and label
of each live record in the pair, resolved through `references()`, so the
inbox needs no read per record.

The one shipped route the app does not use is `GET /v1/records/:id/context`,
which serves agents.

### 9.2 SDK (MIT)

`@retainer/sdk` exposes a typed method per REST route, with public response
and schema-operation types in `@retainer/shared`. It supports abort signals
and typed API errors. The app uses it with `credentials: 'include'` and the
CSRF header instead of a bearer key.

### 9.3 Shared value validation (MIT)

Extract pure value validation/normalization from `records/values.ts` into
`@retainer/shared`, expressed against public field definitions and settings.
Do not import server code into MIT packages. Cover all field types, nullability,
select options, text limits, real dates and time zones, phone syntax, HTTP(S)
links, nonempty full names, deduplication and multi-value limits. Match current
server behavior: `maxValues` caps the total primary plus additional values.
The shared setting's comment describes the same total-value cap. Keep tenant, uniqueness, relation-target and write-precondition
checks in the server. Preserve existing normalization and API error behavior
when switching the server to the shared helpers.

---

## 10. Testing

Same rules as `ARCHITECTURE.md` section 11: a real database, never a mock.

| Layer      | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | How                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Unit       | Field modules: every type round-trips through its shared schema; money to micros; registry completeness; list URL state, columns, paging and footer totals; event list columns; feed filters in the URL, its query and day grouping; comment permissions, order and drafts; which tabs a record has and their counts; the developer view switch; saved views over the URL, board columns and calendar days; schema page descriptions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Vitest                                                                                                                           |
| Component  | Displays and inputs per type, composite list editing, the inline property editor, Escape order and outside clicks in the side sheet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Vitest and Testing Library                                                                                                       |
| End to end | Sign in; review accept, reject, bulk and keyboard; schema approval; inline and stale record edits; list sort, filters, columns and side sheet; list selection with bulk delete and merge, column totals and editing in the grid; saving a board view with column totals, moving a card and a calendar record from the keyboard, and saving or resetting a view's unsaved filter; ⌘K search across objects, events and facts; record creation and its field errors; delete with cascade warning; suggested and manual merges; erase for privacy; deleting an event; read-only keys; session replacement; the Records and Activity sidebar groups and event list explanations; activity feed filters; commenting on a company and on a conversation with a retried post, editing and deleting; an agent refused; event page tabs; an `about` link to an event refused; long text and still tabs in the sheet; developer view | Playwright against the real server and Postgres, a fresh database per test, seeded through the REST API with agent and user keys |

Add coverage for inboxes larger than one page (including decisions between
page loads), accurate totals and off-page review links; acceptance that leaves
a newer value current; unique conflicts; partial bulk failures; relation-label
batching; cache refresh after retraction; preserved drafts after stale writes;
and logout followed by another session with requests still in flight. Permission
checks cover admin-only scopes and non-user actors. Shared validation tests
include invalid values previously accepted by composite schemas alone.

End-to-end tests run in CI after layers 1–4.

---

## 11. Open questions

1. **Brand colour** and a name for the app, if it is not just "Retainer".
2. **Cookie holds the key.** Simple and revocable, but a stolen cookie is a
   stolen key until revoked. The alternative is a `sessions` table with
   short-lived tokens. Is the simple version enough for v1?
3. **Schema editing in the UI.** v1 only approves what agents propose. Should
   people be able to propose changes from the schema page?
