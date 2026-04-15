# test-agents/

Scratch space for running `c17 claude-code` against real claude
sessions during development. Everything under this directory
(except this README, `.gitignore`, and `CLAUDE.md`) is ignored by
git — drop test workspaces in here freely.

## One-time setup: the `c17-dev` alias

The runner writes `.mcp.json` in its process CWD and spawns claude
with that CWD inherited, so **where you invoke it matters**. A
shell alias pointing at the built cli gives you a stable command
that works from any directory without the runner misattributing
CWD.

Add this to your `~/.bashrc` / `~/.zshrc` (adjust the path for your
checkout):

```bash
alias c17-dev='node ~/path/to/control17/packages/cli/dist/index.js'
```

Reload your shell (`source ~/.bashrc`) and you're set. The alias is
a thin wrapper — `c17-dev <anything>` is the same as running the
built cli binary with those args. It doesn't matter which directory
you're in when you set up the alias; it only matters which
directory you're in when you invoke it.

## The dev loop

```bash
# 1. Build the cli (or run `pnpm --filter @control17/cli dev` in
#    another terminal to watch-build on changes):
pnpm --filter @control17/cli build

# 2. Create a scratch workspace (anything you want — it's gitignored):
mkdir -p test-agents/alpha
cd test-agents/alpha

# 3. Authenticate as a slot on your local broker:
export C17_TOKEN=c17_your_slot_token
export C17_URL=http://127.0.0.1:8717   # optional, this is the default

# 4. Preflight the environment:
c17-dev claude-code --doctor

# 5. Wrap a claude session. .mcp.json is written HERE, claude runs
#    with CWD=test-agents/alpha, and the runner restores everything
#    on exit.
c17-dev claude-code
```

## Auto-injected claude flags

`c17 claude-code` prepends these two flags to the claude invocation
automatically — you don't need to pass them:

- `--dangerously-skip-permissions` — c17's tools live behind the
  squadron authority model, not per-call permission prompts. Needed
  so `broadcast`, `send`, `objectives_*`, etc. work without the
  agent being asked "allow this tool call?" on every turn.
- `--dangerously-load-development-channels server:c17` — enables
  claude's `claude/channel` experimental capability against our
  bridge (keyed `c17` in the written `.mcp.json`). Without it, the
  bridge declares the capability but claude ignores it and push
  events never reach the agent.

If you explicitly pass either flag on the command line, the runner
de-dupes so claude doesn't see it twice:

```bash
c17-dev claude-code -- --dangerously-skip-permissions --your-other-flag
```

Any other claude flags can be forwarded by putting them after `--`:

```bash
c17-dev claude-code -- --model opus --continue
```

## Running from outside the repo

Since `c17-dev` resolves via absolute path, you can also run test
agents as **sibling directories** to control17 instead of inside
`test-agents/`:

```bash
mkdir -p ~/sandbox/cmdcntr/test-scenario-alpha
cd ~/sandbox/cmdcntr/test-scenario-alpha
export C17_TOKEN=c17_your_slot_token
c17-dev claude-code
```

That's useful when a test scenario needs a fully clean
working-dir tree with no relation to the control17 repo (no
upward `CLAUDE.md` inheritance to worry about). The `test-agents/`
subdirectory is just a convenient bundling option; the alias
works either way.

## Why inside control17/

Testing `c17 claude-code` requires that claude's CWD be a real
working directory (the runner writes `.mcp.json` in CWD, and the
agent may walk the tree looking for project files). Keeping test
workspaces inside the monorepo means:

- Relative paths to the built cli work out of the box
- You can iterate on the cli and immediately retry a scenario
  without shell reconfiguration
- No absolute-path aliases that break when the repo moves

The tradeoff is that a test agent is one extra directory level
above the repo root, so Claude Code's upward `CLAUDE.md` discovery
would normally leak the control17 repo's own instructions into the
test session. That's exactly what the sibling `CLAUDE.md` file in
this directory prevents — it acts as a guard that terminates the
upward walk before it reaches the repo root.

**Do not put real project instructions in `test-agents/CLAUDE.md`.**
It's intentionally empty of substance. Per-test agent instructions
belong in the test's own subdir, e.g. `test-agents/alpha/CLAUDE.md`.

## Running a local broker in parallel

Most test loops also need a broker. In another terminal, from the
repo root:

```bash
pnpm wizard   # first run only — creates ./control17.json
pnpm dev      # watch-mode server + vite for the web UI
```

The server picks up `./control17.json` and serves on
`http://127.0.0.1:8717`. The web UI lives at
`http://127.0.0.1:5173` with a vite proxy to the server.

Then from a test-agent dir, export one of the slot tokens printed
by the wizard as `C17_TOKEN` and wrap claude.

## Cleaning up

Because everything here is gitignored, `rm -rf test-agents/alpha`
is fine — the runner restores `.mcp.json` on every exit path, so
there shouldn't be stale backups to worry about. If something
crashed mid-run and left a mess, look under `/tmp/c17-runner-*`
and `/tmp/c17-keylog-*` for runtime artifacts.
