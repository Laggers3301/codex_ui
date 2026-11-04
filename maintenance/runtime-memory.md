# Runtime memory

Native account runtimes default to a 4 GiB scope limit. To override one
account, set `CODEX_WEB_ACCOUNT_MEMORY_MAX_<account_id>` in the backend
service environment. Replace characters other than letters, digits and
underscores in the account ID with underscores. For example, account
`example-blue` can use `CODEX_WEB_ACCOUNT_MEMORY_MAX_example_blue=6G`.
Both `MemoryHigh` and `MemoryMax` use that value. API credentials and
account-specific deployment configuration must remain outside this repository.

The parent `codex-workers.slice` must also have enough headroom; an example
is provided alongside this document. Limits are ceilings, not reserved RAM.
Changing environment settings affects newly launched runtimes after the
backend loads the settings. An existing scope can be adjusted with
`systemctl --user set-property --runtime <scope> MemoryHigh=6G MemoryMax=6G`
without restarting it. Adjust its parent separately when necessary.

Native resume/fork operations share one loading lane across accounts.
History of at least 128 MiB uses a conservative loading budget of three
times its logical size plus 512 MiB, checked against host and account
headroom. This is an admission estimate, not measured consumption.
Queued operations that time out are never executed later.

Idle subscriptions are checked after five minutes. Active turns, pending
requests, active goals and background terminals prevent reclamation.
Eligible threads are unsubscribed, allowing the native runtime's 60-second
unload grace period. Reusing an unsubscribed thread resumes it first.
This neither edits stored history nor changes authentication credentials.
