# How an agent should write

Read the workspace schema first. Use the object and field API names it returns, and keep each write tied to the workspace you verified.

## Write from evidence

- Log the event that taught you something, then cite it as the source when setting a field or adding a fact.
- Use a **field** for a typed value the workspace already tracks. Use a **fact** for context you can state in plain language and attribute to an event.
- Prefer an existing record when the evidence identifies it. Ask for clarification when several records are plausible.
- Read the result back. A write can leave a proposed value for human review, and the record may still show the prior value.

## Extend the schema with the user

Use `get_guide("discover_schema")` for an uninitialized workspace or `get_guide("schema_design")` to extend a schema. Show the proposed changes and get approval before applying them.

The [agent writing guide](../agents.md#how-an-agent-should-write) covers identity matching, provenance, confidence, and multiple agents writing in one workspace.
