---
name: retainer-cli
description: Use the Retainer CLI to manage workspace access, keys, connections, and review decisions with a person.
---

# Retainer CLI

Use Retainer MCP for records, events, facts, and search. Use `retainer --help`
for workspace administration, extensions, routines, and review decisions.
Install the CLI with `npm install -g @retainer/cli` if it is available from npm.

Pass `--workspace <slug-or-id>` on workspace commands, or set
`RETAINER_WORKSPACE` for this session. Other sessions share the default saved
by `retainer use`. Use `--org` for organization commands, and keep the same
`--server` throughout an approval flow when targeting a specific server.

1. Run `retainer login` if the person has no local browser login.
2. Read the relevant cases. Tell the person which decisions you expect to make
   before running `retainer elevate --workspace <workspace> --reason "<reason>"`.
   Start an elevation only while the person is present.
3. When a command returns a URL with exit code 6, show it to the person. Never
   open an approval URL or click Allow yourself. Wait for the person to say
   they are done, then run `retainer wait <id>` if there is an ID. If there
   is only a URL, read the result with `retainer routines` or `retainer
   extension show <id>`.
4. Discuss each decision individually. Explain the case, give your
   recommendation, and act only after the person tells you their decision.
5. If an action needs its own approval, resend the same arguments with
   `--approval <id>` after the person allows it. If creation of a key loses
   its response, use `retainer wait <id>` to find the key to revoke before
   creating another.
6. Run `retainer elevate --end` with the same workspace or organization
   when the person's review is done.
