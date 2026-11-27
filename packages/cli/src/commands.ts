// Shared by terminal help and the public command reference.
export const commandGroups = [
  {
    title: 'Sign-in and workspace selection',
    commands: [
      [
        'login',
        '[--server <url>]',
        'Person · browser consent',
        'login --server https://retainer.tamloot.cc',
      ],
      [
        'wait',
        '<id>',
        'Person · waits for a response',
        'wait 01900000-0000-7000-8000-000000000000',
      ],
      ['logout', '', 'Person · ends this login', 'logout'],
      ['whoami', '', 'Person · read', 'whoami'],
      [
        'elevate',
        '[--workspace <w> | --org <o>] [--minutes <n>] [--reason <text>] | --end',
        'Workspace or organization · browser approval to start',
        'elevate --workspace sales --reason "review duplicate deals"',
      ],
      ['workspaces', '', 'Person · read', 'workspaces'],
      ['use', '<workspace>', 'Workspace · saves default on this machine', 'use sales'],
    ],
  },
  {
    title: 'Workspace administration',
    commands: [
      [
        'workspace create',
        '<name> [--org <o>] [--template <t>]',
        'Organization · elevation',
        'workspace create Support --org acme',
      ],
      [
        'workspace rename',
        '<name>',
        'Workspace · elevation',
        'workspace rename "Customer Support" --workspace support',
      ],
      [
        'workspace delete',
        '<workspace> [--approval <id>]',
        'Workspace · click each time',
        'workspace delete sandbox',
      ],
      ['mcp-address', '[<workspace>]', 'Workspace · read', 'mcp-address sales'],
    ],
  },
  {
    title: 'Members, keys, and connections',
    commands: [
      ['members', '', 'Workspace · read', 'members --workspace sales'],
      [
        'invite',
        '<email> [--org <o>] [--org-role <member|admin|owner>] [--workspace <w> --role <viewer|editor|admin>]… [--approval <id>]',
        'Organization · elevation, owner invitation needs a click',
        'invite ben@example.com --org acme --workspace sales --role editor',
      ],
      ['invitations', '[--org <o>]', 'Organization · read', 'invitations --org acme'],
      [
        'invitation revoke',
        '<id> [--org <o>]',
        'Organization · elevation',
        'invitation revoke <id> --org acme',
      ],
      [
        'role',
        '<email> --workspace <w> <viewer|editor|admin> | --org <o> <member|admin|owner>',
        'Workspace or organization · elevation, owner changes need a click',
        'role ben@example.com --workspace sales editor',
      ],
      [
        'remove',
        '<email> [--workspace <w> | --org <o>] [--approval <id>]',
        'Workspace or organization · elevation, removing an owner needs a click',
        'remove ben@example.com --workspace sales',
      ],
      ['keys', '', 'Workspace · read', 'keys --workspace sales'],
      [
        'key create',
        '<name> --access <read|write|schema> [--approval <id>]',
        'Workspace · click each time',
        'key create "Inbox agent" --access read --workspace sales',
      ],
      ['key revoke', '<id>', 'Workspace · elevation', 'key revoke <id> --workspace sales'],
      ['connections', '[--workspace <w>]', 'Person or workspace · read', 'connections'],
      ['disconnect', '<id>', 'Workspace · elevation', 'disconnect <id> --workspace sales'],
    ],
  },
  {
    title: 'Review and schema changes',
    commands: [
      ['review', '', 'Person or workspace · read', 'review --workspace sales'],
      ['review show', '<id>', 'Person or workspace · read', 'review show <id>'],
      [
        'duplicates merge',
        '<suggestion> --keep <record>',
        'Workspace · elevation',
        'duplicates merge <suggestion> --keep <record> --workspace sales',
      ],
      [
        'duplicates dismiss',
        '<suggestion>',
        'Workspace · elevation',
        'duplicates dismiss <suggestion> --workspace sales',
      ],
      ['pending accept', '<id>', 'Workspace · elevation', 'pending accept <id> --workspace sales'],
      ['pending reject', '<id>', 'Workspace · elevation', 'pending reject <id> --workspace sales'],
      ['schema-changes', '', 'Workspace · read', 'schema-changes --workspace sales'],
      [
        'schema-changes approve',
        '<id>',
        'Workspace · elevation',
        'schema-changes approve <id> --workspace sales',
      ],
      [
        'schema-changes reject',
        '<id>',
        'Workspace · elevation',
        'schema-changes reject <id> --workspace sales',
      ],
    ],
  },
  {
    title: 'Extensions',
    commands: [
      ['extensions', '', 'Workspace · read', 'extensions --workspace sales'],
      ['extension show', '<id>', 'Workspace · read', 'extension show <id> --workspace sales'],
      [
        'extension install',
        '<name>',
        'Workspace · finishes in the web app',
        'extension install enrichment --workspace sales',
      ],
      [
        'extension configure',
        '<id>',
        'Workspace · finishes in the web app',
        'extension configure <id> --workspace sales',
      ],
      [
        'extension upgrade',
        '<id>',
        'Workspace · finishes in the web app',
        'extension upgrade <id> --workspace sales',
      ],
      [
        'extension disable',
        '<id>',
        'Workspace · elevation',
        'extension disable <id> --workspace sales',
      ],
      [
        'extension remove',
        '<id>',
        'Workspace · elevation',
        'extension remove <id> --workspace sales',
      ],
    ],
  },
  {
    title: 'Routines and workspace agent',
    commands: [
      ['routines', '', 'Workspace · read', 'routines --workspace sales'],
      [
        'routine approve',
        '<id> <version>',
        'Workspace · finishes in the web app',
        'routine approve <routine> <version> --workspace sales',
      ],
      [
        'routine reject',
        '<id> <version>',
        'Workspace · elevation',
        'routine reject <routine> <version> --workspace sales',
      ],
      [
        'agent chat',
        '[<chat>] [--message <text>]',
        'Workspace · read; the agent writes while this login is elevated',
        'agent chat --workspace sales',
      ],
      [
        'routine pause',
        '<id>',
        'Workspace · elevation',
        'routine pause <routine> --workspace sales',
      ],
      [
        'routine resume',
        '<id>',
        'Workspace · elevation if the existing approval is still valid',
        'routine resume <routine> --workspace sales',
      ],
    ],
  },
] as const;
