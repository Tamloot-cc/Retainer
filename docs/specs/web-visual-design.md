# Web visual design refresh

Status: implemented and verified locally on `feat/web-visual-refresh`. Not published or deployed.

## Purpose

Make Retainer feel like a coherent, polished workspace for people reviewing CRM
records and agent memory. Borrow Twenty's discipline around hierarchy, density,
surfaces and purposeful color while giving Retainer an identity drawn from its
own logo. This spec covers the entire agreed visual refresh, not just color.

## Decisions

- Keep the current wide record sheet (`min(38rem, 92vw)` on larger screens,
  full width on phones). Do not narrow it or introduce a resize requirement.
- Improve sheet integration with aligned headers, matching surfaces, a restrained
  divider and softer shadow. The underlying list remains usable.
- Replace the indigo interaction accent with a forest/lime system.
- Keep neutral page surfaces; concentrate color in navigation icons, identity,
  tags, selection and meaningful status indicators.
- Keep existing editing, permissions, routing, keyboard and provenance behavior.
- Implement in shared web components. No server, schema or API changes are needed
  for the initial palette. Color is presentation, not stored business meaning.

## Reference and current baseline

Reviewed the local Twenty checkout at `~/Development/twenty`, especially
`DESIGN.md`, theme tokens, navigation icon rendering, select tags and tinted icon
tiles. Its useful patterns are semantic text/surface roles, a 4px spacing grid,
48px aligned headers, 32px default controls, quiet hover, distinct selection,
and stable object/category colors. Its design guide and older implementation
occasionally differ; the recommendation is based on the pattern, not a promise
that every Twenty screen already follows it.

Retainer already has shared components, 48px headers, 32px default controls,
light/dark palettes, inline property editing and a wide nonmodal sheet. Preserve
those strengths. Current gaps include one muted text role, unbundled Inter,
indigo interaction colors, monochrome objects/select values, equally prominent
grid lines and a strong sheet shadow.

## Palette and semantic roles

The logo provides lime `#D4FA38`, coral `#FF603F` and dark ink `#111B21`;
the animated mark adds forest `#1F5E3A`. These are brand anchors, not colors to
apply indiscriminately to text.

| Role | Light mode | Dark mode |
| --- | --- | --- |
| Main action | Forest fill, white text | Lime fill, dark ink text |
| Focus | Forest outline | Lime outline |
| Selected row/navigation | Light gray (#EEEEF0) | Charcoal (#29292D) |
| Hover | Light gray (#F4F4F5) | Charcoal (#202023) |
| Workspace frame and sidebar | Off-white (#F7F7F8) | Near-black (#141415) |
| Content pane | White (#FFFFFF) | Black (#000000) |
| Main values | Strong neutral | Near white |
| Supporting labels | Secondary neutral | Secondary neutral |
| Metadata | Tertiary neutral, readable | Tertiary neutral, readable |

Add semantic tokens for frame, surface, primary, primary foreground, focus,
selection, selection foreground, secondary text, tertiary text and category
colors. Replace hardcoded indigo in CSS controls and text selection as well as
Tailwind primary/ring utilities. Theme switching must update them consistently.

Use sage, forest, teal, muted coral, amber and a small lime highlight to create
variety. Every category color has foreground and tinted background variants for
both themes. Keep errors red and review/pending amber. Coral category styling
must remain visually distinguishable from error styling; labels/icons always
express the meaning. Brand green must not imply that a record is verified.

## Workspace frame and navigation

- Give the desktop main pane a subtle outline and rounded outer corner against
  the frame. Avoid stacking several decorative borders.
- Keep mobile content edge to edge and preserve the navigation drawer.
- Keep 48px headers aligned across sidebar, main content and sheet. A frame inset
  must not shift the main header vertically below its neighbors.
- Give each object a stable icon color used in navigation, headers, pickers,
  relations and Schema. Start with forest People, teal Companies and coral Deals.
- Custom objects receive a deterministic palette assignment from their API name;
  translated/display labels and ordering do not affect it.
- Keep action icons neutral. Navigation selection uses the selection token,
  distinct from ordinary hover. Icons remain recognizable when collapsed.

## Typography, spacing and controls

- Bundle Inter locally, including its license, rather than relying on a font
  being installed on the user's machine. Preserve system fallbacks and
  `font-display: swap`.
- Define body/control text at 13px, secondary at 12px, group labels at 11px;
  record/page titles at 20px and section titles at 16px where appropriate.
  Preserve readable prose and a comfortable touch target on mobile.
- Use weight and text roles before adding more heading sizes. Keep code, API
  names and IDs in monospace and preserve Developer view.
- Use a 4px spacing rhythm (4/8/12/16/24/32). Default controls are 32px;
  compact desktop toolbar actions are 24px, with comfortable mobile targets.
- Group view/filter/sort/column controls together. Keep the primary create action
  prominent and routine configuration actions quiet. Active filters remain clear.
- Use consistent icon sizes/stroke; dense metadata icons are smaller than standalone
  icons. Use sentence case for property group headings.
- Keep cards flat with outlines; reserve elevation for floating layers. Use
  consistent radii. Squircle adoption is not required.

## Tables and categorical data

- Keep the identifying column strongest and supporting values quieter where that
  does not erase the meaning of rich field renderers.
- Soften grid lines, especially vertical separators. Preserve resize handles,
  pinned columns, sorting indicators and clear column alignment.
- Hover and selected rows use distinct neutral grays. Keyboard focus
  must remain visible on selected or hovered cells.
- Known select and multi-select values get soft colored tags. Unknown legacy
  values stay neutral. Use the same tag component in display, edit pickers and
  filters. Assign colors by stable option value, not label or array index.
- Hash collisions may share a hue: color supplements readable labels and is not
  a unique identifier. Do not infer status from words such as "won" or "lost".
- Carry option colors into board stage markers/headings and calendar categories.
  Prefer small dots/tags to saturated column or card backgrounds.
- Table empty states should be quiet and sit within the table context. Keep
  useful recovery/create actions where applicable. Do not remove error notices.

## Record identity and wide sheet

- Preserve the current wide-sheet dimensions and full-page opening action.
- Use matching pane surfaces and a subtle divider with restrained shadow.
- Introduce a compact record identity header: initial avatar for a person without
  a supported photo, object tile for other records, prominent name and useful
  existing secondary information. Do not add image fetching or new record fields.
- Share identity styling between record page, sheet and references. Identity
  colors remain stable for a record; object colors remain stable for an object.
- Follow with clearly separated property groups and readable label/value columns.
  Editing remains in place; action space is reserved to avoid layout shifts.
- Keep tabs and content edges aligned. Avoid repeating title/description text.

## Provenance, review and status

- Use subtle actor/source identity colors consistently in attribution and history,
  alongside actor names/icons. They identify a source, not reliability.
- Review pending, conflicts, failures and completion retain explicit labels and
  distinct semantic indicators. Never encode confidence using decoration alone.
- Keep source/history available without exposing technical identifiers in normal
  views. Preserve Developer view and all existing provenance information.

## Accessibility and motion

- Validate normal text at WCAG AA 4.5:1 and meaningful UI boundaries/focus at 3:1
  against adjacent surfaces. Pale category backgrounds require dark text in light
  mode; bright lime is not body text on white.
- Validate every token in light and dark mode, including selected + focused,
  hover + selected, disabled, error, empty and long-content states.
- Keep keyboard paths, labels, screen-reader names and mobile targets intact.
- Honor reduced motion for new transitions. Keep motion short and subtle, with
  no layout jumps or decorative looping animations. Preserve the logo animation's
  existing cycle/pause behavior.

## Implementation sequence

1. **Foundations (first pass):** semantic tokens, self-hosted typography, green
   actions/focus/selection, desktop frame, stable object/category colors,
   display/picker tags, softer table lines and wide-sheet integration.
2. **Identity and consistency:** record identity header shared across full page
   and sheet; object colors in headers/pickers/relations/Schema; stage/calendar
   markers; compact controls and view-toolbar organization.
3. **Review and polish:** provenance/source identity, empty states, consistent
   settings/Extensions layouts, overflow handling and motion review.

Use the People table with an open wide record sheet as the representative
composition. Then verify board, calendar, Extensions, Schema and Review. Each
pass must stay usable on its own; do not leave partial interaction behavior.

## Validation and acceptance

- Run web unit tests, web build/typecheck, lint and import-layer checks.
- Add behavior tests for stable color assignments, option renaming/reordering,
  unknown option fallback and shared display/picker colors. Do not mock Postgres;
  this pass does not change database behavior.
- Capture desktop light/dark, collapsed sidebar, open sheet and narrow/mobile
  screenshots using actual components. Distinguish fixture previews from a real
  authenticated user flow. Inspect rendered results before claiming visual QA.
- Verify selection, row editing, navigation, filter/sort, sheet close/full-page,
  long names, empty values and error states.
- Confirm the wide sheet remains the same width and logo motion is unchanged.
- Update the status below as work lands; keep deliberate deferrals explicit.

## Progress

- [x] Agreed direction documented; isolated `feat/web-visual-refresh` worktree created.
- [x] Foundations implemented and checked (see first-pass evidence below).
- [x] Record identity and cross-screen consistency complete.
- [x] Provenance and responsive/light/dark visual QA complete against the local authenticated app.

### First-pass evidence

Implemented semantic palette tokens, 13px body/control type with self-hosted
Inter, desktop frame, green selection/action/focus, colored object icons in the
sidebar, select/multi-select tags shared with pickers, softened vertical table
lines, sentence-case property headings and a restrained wide-sheet shadow.
Added behavior tests for category identity, renaming/reordering, unknown options
and inherited object names. No database or API changes.

Validation: 273 web tests passed; web build/typecheck and repository lint/import
layer checks passed. Lint reports existing warnings outside these changes.
Inspected actual shared components in a temporary fixture in desktop light/dark
and mobile light mode. The sheet measured 608px at a 1440px viewport and 390px
at a 390px viewport. No document-level horizontal overflow was observed.
Category text/background contrast measured 5.67:1 or higher in light mode and
6.80:1 or higher in dark mode. These measurements cover the category palette,
not a complete app-wide accessibility audit.

The first pass was followed by the completion work below. Its early screenshots
used isolated components; the final screenshots exercise the authenticated app
with neutral records in real, per-test Postgres databases.

### Completion evidence

Implemented the remaining scope:

- Shared initial avatars for people and object tiles for other records, used in
  list rows, record pages/sheets, relations, pickers, search and Review. Renaming
  a record retains its identity color. Event tiles retain the event icon family.
- Stable object colors in object-page headers, Schema navigation/detail/diagram,
  activity rows and source attribution. Extensions use stable registration
  identity tiles in the catalog and installed detail page.
- Board heading markers share the option-value palette with select tags.
  Calendars use the first populated, known single-select option in schema field
  order, with the object color as fallback. Labels describe the category; colors
  do not infer success/failure from option names. Drag previews share the marker.
- Actor attribution is colored consistently between review, assertion provenance
  and record history; source badges share event-object colors. Explicit pending,
  conflict and error text remains separate from identity.
- Column/card configuration lives with view controls instead of creation actions.
  Compact desktop buttons are 24px; their mobile counterparts remain 32px.
  Toolbars put mobile view controls on their own row so filter values stay visible;
  long create labels truncate within a bounded action, and empty
  table results use the quiet state.
- Supporting values/labels use secondary text; metadata uses the tertiary role.
  Shared settings/detail spacing and headers are consistent. Cards stay flat.
  Wide sheets retain 608px desktop width and full width at 390px.
- Long titles wrap with top-aligned avatars; mobile property labels leave more
  room for values. New control transitions and loading placeholders honor
  reduced motion. The logo component and its animation cycles are unchanged.
- Strengthened input/checkbox boundaries and muted text after contrast checks
  exposed marginal contrast on selected/hovered backgrounds.

Final checks (2026-11-15):

| Check | Result |
| --- | --- |
| Web unit tests | 289 passed across 32 files |
| Web production build and TypeScript | Passed |
| Server and browser-test TypeScript | Passed |
| Repository lint / import layers | Passed; 49 existing warnings and 12 informational diagnostics |
| Authenticated browser regression | 43 passed across lists, records, review, schema, extensions, events and visual design; all 7 visual tests passed again after the final mobile-toolbar adjustment |
| Palette contrast guards | Text/category/selection/action labels >= 4.5:1; focus/input boundaries >= 3:1 on tested surfaces in both themes |
| Layout checks | No document-level horizontal overflow on tested mobile record, long title, empty/error, Schema and Extensions states |

The browser tests exercise real API authentication and fresh cloned Postgres
instances. They cover inline editing and stale writes, selection, filter/sort,
column resizing, sidebar collapse, saved views, board/calendar keyboard moves,
review accept/reject, provenance/history, Schema navigation and extension setup.
The error-state test aborts a request for an absent test record to verify its
visible retry control; database behavior is never mocked.

Screenshots are generated by `packages/server/e2e/visual-design.spec.ts` under
`test-results/visual-refresh/` (gitignored): light/dark sheets and record pages,
collapsed sidebars, board/calendar, Schema, Extensions, review/history, mobile
long-name records and empty/error states. Theme capture waits for the document
class and rendered frames to settle. These are authenticated local test data,
not production/customer records. Desktop/mobile Chromium was verified; this is
not a cross-browser certification or a full audit of every legacy color usage.

All implementation items in this spec are complete. Publication/merge/deployment
is a separate delivery action and has not been performed.

### PR review follow-up

Calendar entry accessible names include their category alongside the record name
and optional time. Screen-reader users get the category directly from the button;
they do not have to discover the nested visual marker. Component tests cover both
categorized and uncategorized entries, and the authenticated calendar test checks
the complete accessible name. Keyboard-drag announcements share the same label.
