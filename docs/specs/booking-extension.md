# Booking extension

Status: proposal. This spec defines one general-purpose Booking extension for
Retainer. V1 covers staff scheduling and public self-booking. V2 expands the
same booking model and adds integrations.

## 1. Architecture

Booking is a first-party [standalone extension](../standalone-apps.md) with
its own web app, API, Postgres database and background worker. It owns booking
types, availability rules, reservations, and the public and staff experiences.
Retainer owns People and CRM records. Booking writes a summary through the
reviewed installation grant so Retainer users can see bookings on contact
records and Routines can react to them.

```mermaid
flowchart LR
    Guest["Public booking page"] --> Booking["Booking API"]
    Staff["Staff calendar"] --> Booking
    Booking --> DB["Booking Postgres"]
    DB --> Worker["Outbox worker"]
    Worker --> CRM["Retainer booking summary"]
    Worker --> Mail["Email"]
    CRM --> Routine["Record-triggered Routine"]
```

The booking database is authoritative for times, assignments and status.
Staff and guests use the same reservation commands. In Retainer the summary
is read-only, apart from its Person link. Retainer's views can display it,
but a person cannot edit or drag its times there. A staff link opens the live
booking for changes. This keeps a CRM edit from silently diverging from the
reservation (section 5).

This spec uses Booking-owned resource schedules. A shared Calendar primitive
can be introduced independently. V1 talks to Retainer only through the
standalone REST grant, using `@retainer/sdk`, and through `record` triggers
on the summary. Standalone releases cannot publish
[extension tools](extensions-tools.md) today, so agents and
[Routines](routines.md) cannot call Booking until the V2 bridge. Like the
other first-party extensions, Booking lives in this repository as an MIT
package, `packages/booking`. It depends only on `@retainer/sdk` and
`@retainer/shared` and never imports server code.

## 2. V1 experience

| Surface | Must-have behavior |
| --- | --- |
| Workspace setup | An owner connects the Retainer workspace, sets a time zone, invites schedulers, creates resources, and defines when they can be booked. The owner can preview and publish each booking type or pause new public bookings. |
| Staff calendar | Day and week views with resource and booking-type filters. Staff can see hours and blocks, find a slot, book for a guest, reschedule or cancel, and view the booking's history. |
| Public booking page | One shareable URL per published booking type, such as `/book/acme/intro-call`. Show the duration, time zone and available starts. Collect name and email. Confirm immediately if all required resources are still available. Offer refreshed alternatives on conflict. |
| Guest confirmation and management | Show confirmation after commit and email the time and a private link. From that link a guest can view, move or cancel their booking within policy. Staff can manage it separately. Guests can book without Retainer accounts. |
| Retainer contact record | Show the booking summary and a link to open it in Booking. A Retainer user links the summary to a Person, or corrects or clears that link, on the summary itself. Unlinked bookings stay visible in both apps. |
| Delivery and sync status | Staff can see confirmation emails and CRM writes that need attention and retry a failed delivery. |

Each workspace can publish several links. Booking types can share resources.
A 30-minute intro call can use any one eligible host. A room hire can book a
room on its own. A dental visit can claim a dentist and chair together. A
second public page for the same chair cannot sell an overlapping slot.

## 3. V1 model and rules

| Entity | Minimum contract |
| --- | --- |
| Booking workspace | Stable internal ID, public slug, IANA time zone, staff membership, and one binding to an approved Retainer workspace and installation. |
| Resource | A host, room, or asset, with a stable ID and independent occupancy. A host may have a staff account. A physical resource can be booked without a host. |
| Resource schedule | Weekly working windows, dated replacements or closures, and manual blocks. V1 uses the workspace time zone for all resource schedules. |
| Booking type | Stable ID and public slug, title, fixed duration, slot interval, and a list of requirements. Each requirement has a stable role ID and names a resource or an eligible pool. V1 allows one or two. A type also sets buffers, minimum notice, booking horizon and guest change cutoff. |
| Booking | Stable ID, monotonic version, confirmed or cancelled state, guest contact details, scheduled interval, its allocation, and policy snapshot. |
| Allocation | Stable ID and the claims that hold capacity for one scheduled interval. In V1 each booking has exactly one allocation, released on cancellation. |
| Resource claim | Belongs to an allocation. Records the role ID it fills, the resource, and the occupied interval including buffers. Exclusive across all booking types in the workspace. |
| Booking event | One row per mutation, written in its transaction: event ID, booking ID, version, kind (`booked`, `moved`, `cancelled`), actor (`staff`, `guest` or `system`, with an ID) and reason. Staff history and the outbox read it. |

The allocation keeps capacity separate from the guest's booking. A V2 group
session shares one allocation across many bookings, and a V2 hold owns an
allocation until checkout converts it, without releasing its claims. Role IDs
keep each assignment tied to its requirement when V2 adds larger role
combinations or per-segment claims.

- A dated replacement takes precedence over weekly hours. A closure or
  manual block removes capacity. A candidate fits only when each required
  resource is working and free for its own occupied interval. When several
  assignments fit, prefer the configured resource order and use a stable
  tie-breaker. The requirements must resolve to distinct resources.
- Store instants in UTC. Generate slots in the workspace zone and show the
  displayed time zone on every guest screen and email. V1 skips ambiguous
  or nonexistent local start times at daylight-saving transitions.
- Public availability enforces minimum notice and the booking horizon.
  Guest moves and cancellations enforce the cutoff on the current booking.
  Snapshot the guest change policy and duration when the booking is made. A
  move keeps the duration and checks current hours, resource eligibility,
  buffers, and availability.
- Staff can book or move outside notice and horizon with an audit reason.
  All channels enforce working hours and hard capacity. Staff can edit
  schedules explicitly when the clinic or business changes its hours.
  Show existing bookings affected by closure or schedule edits. Preserve
  those bookings and let staff move or cancel them. The change blocks
  conflicting new reservations from its commit onward.
- Pausing a type closes its public page to new bookings. Existing guest
  links keep view and cancellation access. A guest can reschedule only
  when the type accepts bookings, with staff handling exceptions.
- V1 books at form submission. The selected slot is a candidate while the
  guest enters their details. Expiring holds arrive in V2 for flows such as
  payment or longer intake.

## 4. V1 API and consistency

The app exposes the same domain operations to the staff and public surfaces,
with authorization and response fields appropriate to each caller.

| Operation | Behavior |
| --- | --- |
| `findSlots` | Given the booking type and a bounded date range, return start times and the display zone. The public response carries candidate times and public labels. |
| `book` | Accept a start, guest details and a request key. Re-evaluate policy under the current configuration and select eligible resource assignments. Confirm all claims together. Return the saved booking or a conflict that lets the caller refresh availability. |
| `moveBooking` | Accept a booking ID, expected version, new start and request key. Replace old claims and advance the version in one transaction. On conflict, retain the original booking. |
| `cancelBooking` | Accept a booking ID, expected version and request key. Release its claims and write the cancellation once. A retry with the same key returns the prior result. |
| `getBooking` | Return the live booking. Guest access is scoped to one booking. Staff access is scoped to their Booking workspace. |

Booking mutations and configuration edits share one lock order:

1. Guard the booking type and its eligibility configuration.
2. Lock the selected resources in ID order, including the old ones on a move.
3. Recheck hours, blocks and claims under those locks. If the selection no
   longer fits, retry selection in a fresh transaction.

Schedule and block edits take the same resource locks. Type and eligibility
edits take the same configuration lock. Postgres enforces exclusive time
claims with half-open ranges and an overlap constraint keyed by workspace
and resource. That constraint is the final guard, including for overlapping
candidates with different start times. Cancelled claims leave the active
set, and a move replaces claims inside its transaction.

Scope request keys to workspace, authorized caller or public session, and
operation. Store the request digest and final result with the transaction.
Reject same-key requests with a different payload. An authorized retry with
the same key receives the durable result. Stale edit versions return the
current authorized state for refresh rather than overwriting someone else's
change.

Each successful mutation writes its booking event and outbox work in the
same transaction. A confirmation email or CRM outage can delay those
effects while Booking continues to treat the reservation as confirmed.

- **Guest notices.** Key each notice by event ID and notice type. A move
  replaces a pending notice about the old time. A cancellation replaces any
  pending confirmation or move notice. Nothing else cancels guest mail.
  Handle ambiguous provider outcomes idempotently where the provider
  supports it.
- **CRM summary.** Keep at most one CRM job per booking. It reads the
  booking's current state when it runs, so queued changes coalesce. The
  first write creates the summary with an `Idempotency-Key` derived from the
  booking ID, and the unique `bookingId` field refuses a second record. Later
  writes read the summary, then upsert by `bookingId` with
  `expectedUpdatedAt` from that read. Retainer checks it under the record
  lock, so a delayed older request is refused with `412 stale_write`. On a
  `412` the job reads again and resends.
- Surface delivery failures to staff.

## 5. V1 access, installation and CRM

- **Staff identity.** Booking authenticates staff to its own workspace.
  Booking owners manage configuration, staff grants and the Retainer
  connection. Schedulers manage bookings. The Retainer installation token
  is a server credential, and Booking staff authority comes from app
  membership. Bootstrap requires a signed-in Booking owner to complete
  Retainer's existing workspace-admin consent, using OAuth state and PKCE.
- **Binding.** A binding is unique per Retainer origin, workspace and
  installation. Retainer revokes the previous credential when an admin
  consents again, before Booking sees the callback. So a repeat consent for
  an installation that is already bound stores the new credential on the
  existing binding, and the owner who started it is told which Booking
  workspace holds that connection. In key mode, Booking verifies the
  workspace and installation through `GET /v1/me` before storing a key.
  Connecting a different Retainer workspace requires a new Booking
  workspace.
- **Guest access.** Public routes expose published settings and available
  times. Verify a staff session or a booking-scoped capability on every
  management request. Guest links use high-entropy, revocable tokens, stored
  as hashes, with an expiry and rotation when reissued. A browser exchanges
  its link for a booking-scoped session. Keep tokens out of logs, referrers
  and CRM fields. Rate-limit public searches, booking submissions and link
  redemption. Guests can view their own booking and submit changes through
  that capability.
- **CRM summary.** Booking's release contributes one Booking object through
  the schema engine, with permanent universal IDs for the object and its
  fields. It does not map onto a workspace's own objects. Writes use the
  installation's `integration` actor and ordinary field assertions.

  | Field | Type | Written by | Note |
  | --- | --- | --- | --- |
  | `bookingId` | text, unique | Booking | Create and upsert key |
  | `bookingTypeId` | text | Booking | Stable type ID |
  | `title` | text | Booking | Type title and guest name |
  | `guestEmail` | text | Booking | Lets a person find the right Person |
  | `startsAt` | date_time | Booking | |
  | `endsAt` | date_time | Booking | |
  | `status` | text | Booking | `confirmed` or `cancelled` in V1 |
  | `person` | relation → person | People | Optional |
  | `manageUrl` | links | Booking | Requires staff sign-in |

  `status` is text with documented values, not a select, because select
  options on a contributed field are structural and hard to extend later.
  Attendance and resource labels wait for the features that need them.
- **Installation-owned fields (platform change).** A contributed field can
  declare that only its installation writes it. The API refuses other
  writers, and the field is presented read-only, which already turns off
  editing and calendar drag in the web app. Without this, one person's edit
  outranks every later Booking write (write rule 2) and Routines act on the
  wrong time. All Booking fields above are installation-owned except
  `person`. This amends `ARCHITECTURE.md` and `extensions.md` when built.
- **Person link.** Booking never writes `person` and stores no Person ID.
  A Retainer user links, corrects or clears it on the summary. Booking does
  not link by email, because a guest can type anyone's address.
- **Visibility and lifecycle.** The summary holds only the fields above.
  Other guest details stay in Booking. Deleting a booking queues a final
  outbox job that holds only the booking ID. It runs after any CRM write
  still in flight, stays pending while disconnected, and soft-deletes the
  summary. Hard erasure in Retainer is an admin running `forget`. On
  credential revocation, halt CRM work, flag the disconnect, and keep
  existing bookings manageable in Booking. The Booking owner can pause
  public links separately. Resume projection only after a verified
  reconnection to the same binding.
- **Routines.** V1 Routines can create prep or follow-up tasks from summary
  changes. They see the summary's current state and can miss steps in
  between, such as a booking confirmed and cancelled during a CRM outage. A
  prep Routine should check `status = confirmed` and handle a Person link
  added later. Required confirmations and transactional notices run from
  the Booking outbox. Booking correctness and guest confirmation are
  independent of Routine timing.

Ship the pilot with a Booking service, its Postgres store, a worker, email
delivery and a registered standalone installation. Keep database migrations,
backups and recovery under Booking's operational ownership. A self-hosted
Retainer connects a separately running Booking app through the applicable
standalone credential path. The pilot does not require a Booking container
in Retainer's base Compose deployment.

## 6. V2 additions

V2 features build on the booking IDs, allocations, requirement roles, the
booking event log and domain commands from V1. The first additions can ship
independently. Add the checkout flow only after the hold and expiry behavior
has been verified.

| Area | Extensions to V1 |
| --- | --- |
| Holds and approval | Add a short, bounded hold with expiry. A hold owns an allocation and converts it to a booking once, without releasing its claims. Holds take the same resource locks as bookings. Expire conflicting holds under those locks before admission. Add staff approval with an explicit capacity policy for pending requests. |
| Payments | Accept deposits, full payment, or package entitlements during a hold. Verify provider callbacks, deduplicate effects, and reconcile late payments, cancellations and refunds. A late callback cannot reclaim an expired slot. |
| Availability and assignment | Add resource-specific time zones, fair or weighted host routing, larger role combinations, and multi-day bookings. An external calendar connector can supply busy-only intervals with freshness. Treat a slot as unknown when a required source is stale. Suppress unknown slots on public pages and show the cause to staff. |
| Calendar sync and shared Calendar | Add Google or Outlook invite delivery and reconciliation, with a policy for external edits. When a shared Calendar contract exists, publish Booking entries and consume authorized availability from other sources. Keep the final capacity check in Booking. |
| Complex bookings | Add group sessions, where many bookings share one allocation with a seat limit counted inside the session. Add recurring series with explicit partial or all-or-none booking, and multi-service visits with claims per segment, each tied to its role. |
| Waitlists and disruptions | Match people by preferences, expiry and priority. Start with a staff shortlist, then add expiring offers and automatic backfill. Claim a freed slot through the regular booking command. |
| Guest and staff surfaces | Add an optional workspace directory, embeds, branding, locale and custom domains. Add configurable intake, guest verification and matching, attendance, branch roles, check-in or pickup, and utilization reporting. |
| Communications | Add durable appointment-relative reminders, two-way confirmation and more messaging channels. Moves and cancellations invalidate obsolete reminders through the same event-keyed notices. |
| Agent and extension interoperability | Expose scoped typed commands and lifecycle events from the booking event log, with the appropriate authorization and caller attribution. A reusable bridge for standalone extension tools would let a Retainer agent or Routine call these commands. Direct event subscriptions can follow when consumers need every transition rather than the summary's current state. Payment, calendar and door-access partners can use Booking's API and signed webhooks. |

## 7. Acceptance criteria

Run concurrency and persistence tests against real Postgres and exercise the
staff, guest and CRM paths end to end.

- A workspace can publish two booking types on distinct URLs that share a
  resource. Both show their own rules. A booking through either removes
  the overlapping time from both. Validate a host-only call, room-only hire
  and two-resource appointment.
- Competing staff and guest requests with different start times cannot
  overlap on one resource. If a two-resource operation fails, it leaves
  neither claim behind. A failed move keeps both original claims. Schedule
  edits and booking commits cannot race past a newly committed block.
- Replays after a response is lost return the original result. Stale moves
  and cancellation edits are rejected. Date overrides and daylight-saving
  boundaries produce the documented availability.
- A guest can book, receive confirmation, move and cancel without a
  Retainer account. Another workspace, another guest, and an expired
  capability cannot read or change that booking. Public responses contain
  no private schedule details or Retainer credentials.
- A CRM outage after booking preserves the reservation. Recovery writes
  one current summary. An older CRM write delayed past a newer one is
  refused. A Person link set in Retainer survives later Booking writes.
  A person cannot edit or drag Booking-owned fields. Deleting a booking
  with a CRM write in flight leaves the summary deleted. Revoking the
  grant stops CRM effects, and staff can still manage the booking.
- V2 additions extend these tests with hold expiration and late checkout,
  duplicate provider callbacks, concurrent last-seat claims, external
  calendar staleness, and reminder cancellation or rescheduling.

Background research: [booking feature inventory and precedents](../research/clinic-booking-features.md)
and [RapidOne feature mapping](../research/rapid-image-features.md).
