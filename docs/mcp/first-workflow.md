# Read and write a first record

Use a test workspace or a record you intend to update. An agent needs `read` to look up data and `write` to save it.

1. **Read the schema.** Ask the agent to run `describe_schema` and identify the object and fields for a company. Use the returned API names in each tool call.
2. **Look up a record.** Ask the agent to query that object with `query_records` using a real company name. If multiple records match, have it show you the choices.
3. **Record an update.** Ask it to save a known detail. If the detail came from a conversation, have it log the event, then cite the event when it updates the record or saves a fact.
4. **Read it back.** Ask it to call `get_record` and report the value and source, or open the record's history in the web app.

For a workspace with an existing company object, try:

```text
Confirm that you're connected to my test workspace. Look up Acme and ask
me if several records match. For the Acme record I confirm, log a note
that the renewal needs legal review, remember that fact with the note as
its source, then read the record back and show me the source.
```

See [record and event provenance](../guides/concepts.mdx) for how Retainer stores the result.
