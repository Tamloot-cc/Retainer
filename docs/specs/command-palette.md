# Command palette

Implemented first release: ⌘K / Ctrl+K opens workspace search and commands.

- Uses cmdk inside the existing Radix modal, styled with Retainer's visual tokens.
  The input and keyboard footer stay fixed while grouped results scroll.
- Search records, current facts and events with the existing Postgres keyword
  search. Record hits show a primary email, phone or website when available;
  facts show their owning record; events show type, date and linked record names.
- Local matches for objects, Home, Review, Activity, Schema, Extensions and
  account settings appear immediately. Server results are debounced, and results
  for a previous query cannot be selected while a new query settles.
- Arrow keys select, Enter opens, Escape closes. Cmd/Ctrl+Enter or Cmd/Ctrl+click
  opens a destination in a new tab. Closing and reopening starts with an empty query.
- Recent records/events and objects are stored as six identifiers in tab storage,
  scoped by workspace and actor. Record labels are fetched again before display;
  deleted or inaccessible records are omitted. No labels or search queries are stored.
- People with write access can start an existing create-record form for any entity
  object. Events continue to be created through event logging. Agent credentials
  and read-only people receive no create actions.
- Selecting a record fact opens its facts tab, loads further fact pages if needed,
  and focuses/highlights the matching fact. Profile facts lead to account memory.
- Search returns five hits per category initially. “Show more results” increases
  that to 50 per category; this is bounded expansion, not a full search-results page.

Saved-view search, context-specific record actions and a dedicated full-results
page are deferred. The search algorithm, schema and write rules are unchanged.
