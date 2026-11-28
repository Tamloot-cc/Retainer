# Right-click menu for records: spec

Status: **proposed**, 2026-11-28. Prior art: Twenty's right-click menu
([§8](#8-prior-art-twenty)), read in `~/Development/twenty` at `037adf06b`.

This spec amends:

- `FRONTEND.md` §5.3 (object list: right-click on rows, cards and calendar
  entries), §5.4a (record actions come from one shared list) and "Not in
  v1" (running a routine on selected records is now in).
- `command-palette.md`, whose deferred "context-specific record actions"
  will later read the same list ([§7](#7-later)).

No server route, schema or write rule changes. Every action calls a route
the web app already uses.

## 1. The idea

Right-clicking a record in a list, board or calendar opens a menu of the
actions for that record, at the pointer. With several rows selected, it acts
on all of them. Right-clicking one value in the table also offers to copy it
and to show where it came from.

The menu is a shortcut. Every action in it is also on screen somewhere else:
the record's "…" menu, its buttons, or the bar for selected rows. A person
who never right-clicks loses nothing.

## 2. One list of actions

Today the same actions are written out in several places:

| Where                                      | Actions                           | Code                                   |
| ------------------------------------------ | --------------------------------- | -------------------------------------- |
| Record "…" menu (sheet and record page)    | Merge a duplicate, Delete, Erase  | `routes/records/record-actions.tsx`    |
| Bar for selected rows                      | Merge (exactly 2), Delete         | `routes/views/objects.tsx`             |
| Routine buttons on a record                | One per approved `manual` routine | `routes/routines/record-buttons.tsx`   |
| Extension buttons on a record (Enrich now) | One per installed record button   | `routes/extensions/record-buttons.tsx` |

A new module, `routes/records/actions.tsx`, returns the actions available for
a target. Every menu reads from it:

```ts
type ActionTarget = {
  records: PresentedRecord[];
  object: ObjectView | undefined;
  field?: FieldView; // the cell right-clicked, if any
};

type RecordAction = {
  id: string;
  label: string; // "Delete…", "Delete 4 people…", "Enrich now"
  icon: LucideIcon;
  group: 'cell' | 'open' | 'run' | 'change' | 'danger';
  destructive?: boolean;
  run: () => void; // opens the existing dialog, or starts the run
};

function useRecordActions(target: ActionTarget | null, host: ActionHost): RecordAction[];
```

The hook checks permissions (`canMutate`, `admin`), the record class (an
event can't be merged) and the count (merge needs exactly two) in one place.
The "…" menu, the bar for selected rows and the right-click menu all render
what it returns, each the groups it shows (§4). The dialogs (merge, delete,
bulk delete, erase, field history) keep their code. An action only opens
them.

A menu closes as soon as an item is picked, and its target with it, so
the dialog can't live in the menu. Each surface holds an **action host**
(`useActionHost`): the dialog open now, with its own copy of the records,
and the extension runs started from a menu. An extension button watches
its run until it ends and then reports how it went
(`extensions/record-buttons.tsx`); the host does the same for a run started
from a menu, so the report still comes after the menu has gone. Reports go
to the shell (`useReport`), as a deletion's does. After a delete, erase or
merge, the host tells its surface which records are gone, so a list drops
them from its selection and closes the sheet if it showed one.

Routine and extension buttons are the only actions that come from the
server. The hook reads them with the queries the buttons use today, so the
cache is shared.

Unlike Twenty ([§8](#8-prior-art-twenty)), actions are not stored on the
server and have no availability language. Twenty needs both because
workspaces and apps add and edit actions. In Retainer the only actions added
at runtime are routine and extension buttons, and those already come from
the server.

## 3. The menu

A new `PointMenu` in `ui/menu.tsx`: the Radix dropdown menu `Menu` already
uses, with the same item styles, opened at a point instead of under a
button. Its trigger is an empty fixed element at the pointer, so Radix
places the menu there and keeps it inside the window, as Twenty does with
`createVirtualElementFromPosition`.

`@radix-ui/react-context-menu` doesn't fit a list. Its trigger wraps the
element it serves: one per row is a menu per row, and one around the whole
list takes over the browser's menu everywhere in it, between records too.
Instead, one `PointMenu` serves a surface: a `contextmenu` listener on the
list finds the record under the pointer (`data-row`, and `data-column` for
the cell) and opens the menu there. When there is none, it does nothing and
the browser's menu opens.

It also opens from the keyboard (Shift+F10 or the menu key), which fires
`contextmenu` on the focused link or button inside a row; with no pointer,
the menu opens at that element. On touch it opens with a long press, except
on a card that can be moved: there the long press picks the card up, as
today, and the sheet's "…" menu has the same actions. When the menu closes
without opening a dialog, focus goes back where it was.

The browser's own menu still opens on inputs (a cell being edited) and
anywhere outside a record.

Groups, separated by a line, in this order:

1. **Cell:** Copy value, History of the field (a right-clicked cell of one
   record).
2. **Open:** Open, Open in new tab, Copy link.
3. **Run:** the record's routine buttons, then its extension buttons.
4. **Change:** Merge a duplicate… / Merge….
5. **Danger:** Delete…, Erase for privacy….

An empty group is left out, with its line.

## 4. What is in it

| Target                   | Actions                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| One record               | Open, Open in new tab, Copy link; routine buttons; extension buttons; Merge a duplicate…; Delete…; Erase for privacy… (`admin`) |
| One event                | As one record, without Merge a duplicate… (events can't be merged, as today)                                                    |
| Several selected records | Run a routine on these N (one item per routine button); Merge… (exactly 2, not events); Delete N…                               |
| The "…" menu             | Change and Danger, as today                                                                                                     |
| Bar for selected rows    | Run (a "Run" menu when there are routine or extension buttons), Change and Danger                                               |
| A value in a table cell  | The row's actions, after two of its own: **Copy value** and **History of this field**                                           |
| Read-only people, agents | Open, Open in new tab, Copy link, Copy value, History of this field                                                             |

- **Running a routine on several records** calls
  `api.runRoutine(routineId, ids)`, which already takes a list. The report
  says how many runs started and links the routine's runs. The routine's
  limit of 200 queued runs an hour still applies (`routines.md`), and a
  refused run is reported like a refused button press. The route takes up
  to 50 records, the size of a page, so a selection always fits.
- **Open** opens the record in the sheet, as a click on the row does.
  **Open in new tab** opens its page (`/r/:id`, or `/e/:id` for an event)
  and **Copy link** copies that page's full address.
- **Extension buttons** take one record (`runExtensionRecordButton`), so they
  appear only when one record is the target.
- **Copy value** copies the cell's value with `primaryCopyValue`
  (`fields/copy-value.ts`), as the copy buttons in the sheet and the table
  already do.
- **History of this field** opens the "History of …" dialog the record sheet
  already has (`record-view.tsx`, `api.assertions` filtered by field): every
  claim on that field, who made it, from which source, and which one won.
  Twenty has nothing like this. It is Retainer's provenance, put where a
  person doubts a value. It is offered on the object's own fields, as in
  the sheet, not on an event's built-in columns (when, participants,
  about, source, external ID), which have no claims of their own.
- **Copy value** is offered only when the cell has a value to copy.

## 5. Selection

- Right-clicking a row that is **not** selected selects only that row, then
  opens the menu for it. The rest of the selection is cleared.
- Right-clicking a row that **is** selected opens the menu for all selected
  rows.

Twenty instead adds the right-clicked row to the selection
(`useOpenRecordContextMenu.ts`). That makes it easy to bulk-delete rows the
person forgot were selected. We follow Finder and Gmail.

Selection exists only in tables today (`GridSelection`), and only for
people who can change records. On boards and calendars, and for read-only
people, the menu acts on the one row, card or entry right-clicked.

## 6. Where it appears

| Surface                     | First release | Code                                                |
| --------------------------- | ------------- | --------------------------------------------------- |
| Table rows and cells        | Yes           | `ui/data-grid.tsx`, `routes/views/objects.tsx`      |
| Board cards                 | Yes           | `ui/board.tsx`, `routes/views/board-view.tsx`       |
| Calendar entries            | Yes           | `ui/calendar.tsx`, `routes/views/calendar-view.tsx` |
| Activity feed               | No            | `routes/events/activity.tsx`                        |
| Sidebar, dashboards, schema | No            |                                                     |

An event type's list is an object list (`objects.tsx` with the helpers in
`events/event-list.tsx`), so its table and calendar get the menu with the
rest. The Activity feed lists changes, not records; it can come later.

Twenty also has a sidebar menu (add item, new section, expand or collapse
all). Retainer's sidebar is short and has no sections to edit, so it gets
none.

## 7. Later

- **⌘K actions for the open record.** The palette lists `useRecordActions`
  for the record on screen, as Twenty's command menu does. This settles the
  deferred item in `command-palette.md`.
- **Ask the agent about these.** Opens the chat with the selected records
  attached.
- **Extension buttons on several records**, if the run route takes a list.

## 8. Prior art: Twenty

Read in `~/Development/twenty` (`github.com/twentyhq/twenty`) at
`037adf06b`. Paths are under `packages/twenty-front/src/modules/` unless
they start with `packages/`.

| What                                                                     | Where                                                                                                                                                                                                                                                                                                                          | Taken or not                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Right-click opens the command menu's dropdown at the pointer             | `command-menu-item/hooks/useOpenCommandMenuDropdownAtCursor.ts`, `components/CommandMenuDropdownAtCursor.tsx`                                                                                                                                                                                                                  | Taken: the menu is a view of one action list. Positioning by Radix instead |
| The dropdown shows only actions on selected records, then "More actions" | `command-menu-item/components/RecordIndexCommandMenuDropdown.tsx`                                                                                                                                                                                                                                                              | Taken: the menu repeats actions found elsewhere                            |
| Right-clicking a record adds it to the selection                         | `object-record/record-selection/hooks/useOpenRecordContextMenu.ts`                                                                                                                                                                                                                                                             | Changed: we replace the selection ([§5](#5-selection))                     |
| Actions as server data with an availability expression                   | `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/constants/standard-command-menu-item.constant.ts`                                                                                                                                                                                             | Not taken: a client-side list is enough ([§2](#2-one-list-of-actions))     |
| Sections in a fixed order                                                | `command-menu-item/constants/CommandMenuItemSectionsInDisplayOrder.ts`                                                                                                                                                                                                                                                         | Taken, simplified to five groups                                           |
| Workflows and apps add their own actions                                 | `packages/twenty-server/src/engine/core-modules/application/application-manifest/converters/` (workflow manifest → command menu item)                                                                                                                                                                                          | Taken: routine and extension buttons appear in the menu                    |
| Where it is wired                                                        | `object-record/record-table/record-table-cell/components/RecordTableCellDisplayContainer.tsx`, `object-record/record-board/record-board-card/components/RecordBoardCard.tsx`, `object-record/record-calendar/record-calendar-card/components/RecordCalendarCard.tsx`, `object-record/record-list/components/RecordListRow.tsx` | Same surfaces ([§6](#6-where-it-appears))                                  |
| Sidebar menu                                                             | `navigation/components/MainNavigationDrawerContextMenu.tsx`, `MainNavigationDrawerContextMenuContent.tsx`                                                                                                                                                                                                                      | Not taken                                                                  |

## 9. Testing

- **Unit:** `useRecordActions` for each row of the table in §4: one record,
  one event, two and three selected, read-only, agent, admin, with and
  without routine and extension buttons. The "…" menu and the bar for
  selected rows render the same items for the same target.
- **Component:** the selection rule (§5); the menu opens from a
  `contextmenu` on a focused link in a row (what Shift+F10 fires); the
  browser's menu is left alone outside a record and in an input; empty
  groups leave no line; an extension run started from the menu is reported
  after the menu has closed.
- **End to end** (Playwright, real Postgres): right-click a row and delete
  it; select three rows, right-click one of them and delete all three;
  right-click an unselected row while two are selected and see only it
  selected; run a routine on two selected records and see two runs; right-click
  a cell and open its field history; a read-only person sees no change
  actions.

One PR: the shared list, the menu, the four surfaces and the tests.
