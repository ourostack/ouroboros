The old Ouro Mailbox page is gone: `ouro mailbox` and its `outlook` alias are no longer commands, the daemon no longer serves a page on port 6876, and `ouro status` no longer shows a Mailbox row. A fresh Mailbox will be built in its place. Data the old page left in agent bundles (`state/mailbox/` and its prefs files) is not read, moved or deleted.
- `ouro shepherd status` still shows the same supervision view; its reader moved out of the old Mailbox code.
- The mail setup guide and the agent's mail prompts now point at the mail tools for auditing mail instead of the old page.
