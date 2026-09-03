# zhnote Desktop

This file is auto-generated on app startup.

## Meeting data

Use zhnote's typed, read-only interfaces for meeting data. Do not use `find`,
`grep`, `rg`, filesystem crawling, or direct SQLite queries to find or read
meetings.

Prefer the zhnote MCP tools when they are available:

- `list_meetings` to resolve a meeting ID
- `get_meeting` for notes, summaries, participants, and action items
- `get_meeting_transcript` for bounded transcript pages
- `get_recurring_meeting_history` for meetings in the same recurring series

If MCP is unavailable, use the zhnote CLI with `--json`:

```sh
zhnote --json meetings list --query "planning"
zhnote --json meetings get MEETING_ID
zhnote --json meetings transcript MEETING_ID --limit 200 --offset 0
zhnote --json meetings history MEETING_ID
```

The CLI discovers zhnote's database from the platform application-data
directory. Use `--db-path ABSOLUTE_APP_DB` only when the user explicitly
provides a non-default database path; do not crawl the filesystem to find one.
Never guess a meeting ID. Keep transcript requests bounded and continue from
`pagination.next_offset` only when more context is needed.

Documentation: https://docs.anarlog.so

Agent skill: https://docs.anarlog.so/skill.md
