# test-agents guard

This file exists to **block upward `CLAUDE.md` discovery** from test
agent workspaces back to the control17 repo root.

Claude Code walks up the directory tree from its working directory,
reading every `CLAUDE.md` it finds along the way and concatenating
them into the session's ambient instructions. Without this guard, a
claude session launched from `test-agents/<something>/` would pick
up both its own `CLAUDE.md` (if any) AND whatever is in the repo
root — which would mix "test agent is pretending to work on an
unrelated project" with "here is how to hack on control17 itself."

Keeping this file present (even empty of substantive instructions)
gives test agents a clean boundary: their CWD-anchored traversal
terminates here instead of leaking into the parent repo.

Do not put real project instructions in this file. Real per-test
instructions belong inside the test agent's own subdirectory, e.g.
`test-agents/alpha/CLAUDE.md`.
