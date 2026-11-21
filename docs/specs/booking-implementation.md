# Booking: implementation plan

Status: plan, 2026-11-21. Implements [booking-extension.md](booking-extension.md)
and the platform rules it relies on in [extensions.md](extensions.md) §8 and
§9.4. Paths are relative to the package named, or to `packages/server/src`.
Line numbers in the specs are navigation hints only.

## 0. Ground rules

- **No users.** There is no data, installation, token or bundle to keep
  working. Rebuild or replace anything; never add compatibility code.
- **Lean.** Build V1 of the product spec and nothing from its §6. Screens are
  plain and simple. When a feature and a seam compete for time, keep the seam
  (§1) and cut the feature.
- **Architecture first.** The goal of V1 is a structure later features can
  extend without rework, and clean boundaries that make later refactoring
  local. Each PR states what it leaves out.
- **Repo rules apply** (`CLAUDE.md`): real Postgres in tests, never a mocked
  database; a concurrent test for every rule described as atomic or
  idempotent; actors from credentials; schema changes through the schema
  engine; `pnpm lint` layering; server code AGPL, `packages/booking` MIT.

## 1. Seams that must be right

These are the decisions that are expensive to change later. Review every PR
against them.

| Seam | Rule | What it makes cheap later |
| --- | --- | --- |
| Booking and Retainer | Booking reaches Retainer only through `@retainer/sdk` and its tool functions. It has its own database and never imports server code. | Moving, scaling or replacing Booking; the next standalone app |
| Platform stays generic | Nothing in PR 1 names Booking. Its tests use the generic fixture app. | Every future standalone app reuses PR 1 unchanged |
| One command layer | Staff screens, guest pages and tool functions call the same commands, each with an actor. No caller writes tables directly. | Agents, partners and webhooks as new callers |
| Pure domain core | Availability, policy and assignment are pure functions with no I/O. Availability takes busy intervals as input. | External calendars add a busy source, not a new algorithm |
| Capacity model | Allocations own claims; claims carry role IDs. | Group sessions, holds, larger role combinations |
| Event log | Every mutation writes one event; history and the outbox read only events. | Webhooks, reminders, calendar sync, replay |
| Effects as outbox adapters | Email and the CRM summary are separate adapters behind one interface, each keyed for safe retries. | Calendar sync, webhooks and SMS as new adapters |
| Staff identity as a port | Commands receive an authenticated staff identity and role; how it was obtained lives in one adapter. | Embedded pages later, a different sign-in |

## 2. Booking package layout

`packages/booking`, MIT, on Retainer's stack: Hono for the API, Drizzle for
its own database, React with Vite and TanStack Router for the pages.

| Folder | Holds | May import |
| --- | --- | --- |
| `src/domain` | Slots, policy, assignment, time zones. Pure functions. | Nothing outside `domain` |
| `src/store` | Drizzle schema, migrations, locks, the overlap constraint, request keys | `domain` |
| `src/commands` | `findSlots`, `book`, `moveBooking`, `cancelBooking`, `getBooking`, `deleteBooking`, configuration edits | `domain`, `store` |
| `src/outbox` | The worker and one adapter per effect | `commands`, `store` |
| `src/auth` | Guest capabilities, the staff identity port and its adapters | `store` |
| `src/api` | Hono routes for staff, public and guest callers | `commands`, `auth` |
| `src/web` | Staff screens, public pages, guest management page | the API over HTTP only |
| `src/functions` | The tool functions bundle (`@retainer/extension`) | Booking's API over HTTP only |

Add `packages/booking` to `scripts/check-layers.mjs` with these rules, and
forbid imports from `packages/server`. The pages reuse `packages/web`'s styles
and components. If importing from that app package proves awkward, move the
shared pieces to a small MIT `packages/ui`; that is a refactor, not a redesign.

## 3. PR 1: platform (Retainer)

Generic changes the product spec's §5 lists. Tests use the existing fixture
extension (`scripts/build-extension-artifacts.mjs`), extended into a
standalone release with one tool.

1. **Standalone releases with functions.** Drop the ban in
   `packages/extension/src/index.ts` (`standalone apps cannot contain hosted
   functions`). Make every place that reads `execution: 'standalone'` as
   "nothing to run" follow the rule in extensions.md §8: `runtimeReady` and
   install health in `extensions/service.ts`, `runtimeEnabled` in
   `extensions/catalog.ts`, activation in
   `extension-control/configuration.ts`, `extension-runtime/availability.ts`
   and uninstall in `extension-runtime/queue.ts`. Lifecycle jobs run only for
   declared lifecycle functions.
2. **Hosted accepts the `tool` kind.** `extensionServices` must load a catalog
   with tool functions. Deploy this before any bundle with a tool reaches the
   hosted catalog; an unknown kind stopped catalog loading on 2026-11-15.
3. **Tool readiness.** A tool is ready only with a live, unrevoked credential
   and its generated secret present. Check in `extensions/tools.ts` and in the
   broker.
4. **App-written generated secrets.** A route the installation credential can
   call to write its own generated secrets, nothing else. It reuses the CAS in
   `extension-runtime/secrets.ts`; a `409` carries the current revision, never
   the value.
5. **Tool calls in `Retainer-Caused-By`.** Accept up to 8 tool call IDs of the
   same installation in `changes/collect.ts`, copy each job's chain, and
   return `410` for a pruned job.
6. **Installation-owned fields.** A manifest flag on contributed fields. The
   write path refuses any other writer, and `schema-engine/present.ts` marks
   the field `readOnly`, which already disables editing and calendar drag.
   Merge (`records/merge.ts`) and delete (`records/write.ts`) of a record whose
   unique field is installation-owned are allowed only to that installation;
   admin `forget` still works. Amend `ARCHITECTURE.md` write rules and
   extensions.md.
7. **Sidebar link and sign-in.** A `sidebarLink` in the manifest, rendered in
   `packages/web/src/ui/shell.tsx` for members of workspaces where the
   installation is active. An identity-only flow on the existing OAuth server
   in `accounts/auth.ts`: `openid`, `email`, `profile`, no API resource, no
   consent page, the installation named by the link, the claims listed in
   extensions.md §8.

**Done when** the fixture app installs, a routine calls its tool, its
credential writes the tool's secret, a write citing the tool call does not
retrigger the routine, a person cannot edit, merge or delete a record keyed by
its owned field, and a member opens its sidebar link signed in.

**Leaves out:** mapping and member connections for standalone releases, and
showing an app's page inside Retainer's own page.

This is the largest PR. If review becomes unwieldy, split sign-in (item 7)
into its own PR; nothing else depends on it until PR 3.

## 4. PR 2: Booking core

Runs on its own, with no Retainer connection. It can start while PR 1 is in
review.

- **Domain:** working windows, dated replacements, closures and blocks;
  buffers; minimum notice and horizon; skipping ambiguous or missing local
  times at daylight-saving changes; assignment by configured order with a
  stable tie-break and distinct resources.
- **Store:** workspaces, resources, schedules, booking types and their
  requirements, bookings, allocations, claims, events, outbox items, request
  keys and guest capabilities. Claims use a half-open `tstzrange` with an
  exclusion constraint on workspace and resource (`btree_gist`).
- **Commands:** the six operations in the product spec §4, the lock order,
  request-key replay and stale-version responses. Configuration edits take
  the same locks.
- **Outbox:** the worker and the email adapter (Resend, notice key as its
  idempotency key). The CRM adapter is an interface with no implementation
  yet.
- **Auth:** guest capability links (hashed, expiring, revocable, exchanged for
  a booking-scoped session). Staff identity is the port from §1 with a
  development adapter only.
- **Web:** setup, calendar and delivery status for staff; the public booking
  page; the guest management page.

**Tests:** competing staff and guest bookings with different starts never
overlap; a failed two-resource booking leaves no claim; a failed move keeps
the original claims; a schedule edit and a booking commit cannot race past a
new block; replays return the first result; overrides and daylight-saving
boundaries give the documented slots; a guest link reaches only its booking;
an email retry sends once.

**Leaves out:** Retainer sign-in, the connection, the CRM summary and the tools.

## 5. PR 3: the Retainer link

Needs PR 1 merged.

- **Staff identity adapter:** Retainer sign-in; admins are owners, members are
  schedulers.
- **Binding:** OAuth connection and key mode verified with `GET /v1/me`; one
  binding per Retainer origin, workspace and installation; repeat consent
  refreshes it.
- **Tool key:** pending hash first, one rotation at a time, retry with the
  revision a `409` reports.
- **CRM adapter:** the five steps in the product spec §4, including
  `Retainer-Caused-By`; `deleteBooking` soft-deletes the summary; revocation
  halts the adapter and shows in delivery status.
- **Release:** the Booking object with permanent IDs and installation-owned
  fields, the sidebar link, and the five tool functions.

**Tests:** the product spec's §7 end to end against real Postgres for both
apps, and `pnpm test:docker` for Compose.

## 6. Rollout

1. Deploy PR 1 to hosted, including the `tool` kind, before any Booking bundle.
2. In `retainer-cloud`: Booking's database and login role on the existing
   Postgres server, Booking's API and worker next to Retainer's, the Resend
   domain and key.
3. Register Booking's OAuth client and catalog entry, add it to
   `EXTENSION_BUNDLES` and the cloud allowlist, and apply the Terraform
   variables.
4. Self-hosting: `docker/booking.compose.yml` and a section in
   `docs/self-hosting.md`. Booking needs accounts mode.

## 7. Where later features go

| Later feature | Change |
| --- | --- |
| Google or Outlook calendar | A busy-interval source for the domain and an outbox adapter for events |
| Holds and checkout | A hold becomes an allocation owner and converts to a booking |
| Group sessions | A session owns the allocation; bookings take seats |
| Webhooks, reminders | Outbox adapters reading the event log |
| Agents calling Booking | The same five tools, once Retainer offers tools to agents |
| Booking inside Retainer's page | A new staff identity adapter on the same sign-in |
| The next standalone app | PR 1 as is |
