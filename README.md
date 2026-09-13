# Continuum

> The agent can stop. The project context doesn't.

Continuum is a local, provider-neutral continuity runtime for AI coding agents. It orchestrates Codex CLI, Claude Code, OpenCode and Antigravity CLI over a shared project context, durable memory and workspace state. When the active coding agent becomes unavailable or exhausts its usage window, Continuum checkpoints the current work, creates a compact handoff capsule, and continues the same task with the next configured agent — without restarting the project from scratch.

## How to run

```bash
# 1. Install (from this repo)
npm install && npm run build && npm link
# now `continuum` is a global command

# 2. Inside any project you want to protect
cd my-project
continuum init          # creates .continuum/ (config, memory, state dirs)
continuum doctor        # which real CLIs are installed & authenticated

# 3. Run a task through the provider chain
continuum run "Build the authentication system and run all tests"

# 4. Watch state
continuum status        # task + provider states + event count
continuum logs          # tail the normalized event log
continuum handoff       # print the latest handoff capsule
continuum providers     # per-provider state
continuum checkpoint    # manual checkpoint of workspace state
continuum memory        # durable project memory (decisions/constraints)
continuum switch claude # put claude first in the routing order
continuum resume        # resume a paused task
```

Uninstall the global link with `npm unlink -g continuum`.

### Real vs mock providers

By default `continuum run` uses the **real CLIs** when installed (checked honestly via PATH/paths), and **skips providers that aren't installed**. Add `--mock` to `run`/`resume`/`doctor` to use scriptable mocks instead (offline demos/tests).

Which CLIs are supported and how they're invoked:

| Provider | Binary used | Notes |
|---|---|---|
| Codex | `codex exec --json` (+ `resume` for sessions) | sandbox `workspace-write` |
| OpenCode | `opencode run --format json` (`-s` to resume) | real .exe resolved from npm global dir |
| Claude Code | `claude -p --output-format stream-json` (`--resume`) | needs install + login |
| Antigravity | `agy -p --output-format stream-json` (`--conversation`) | beta; best-effort |

Per-provider options (model) live in `.continuum/config.yaml`:

```yaml
providers:
  opencode:
    model: opencode/nemotron-3.5-lightning-free   # optional; default = CLI's own default
  codex:
    model: ""                                     # empty = CLI default
```

Install the missing ones when you need them:

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
# Antigravity: install from Google (beta); the adapter auto-detects `agy` on PATH
```

### What happens on failure (real, verified behavior)

```
claude is not installed; skipping.
antigravity is not installed; skipping.
opencode is now the active writer.
opencode failed: [NETWORK_FAILURE] Cannot connect to API...
Transient failure; retrying opencode in 2s (attempt 1/3).
...
opencode exhausted retry attempts; moving on.
codex is now the active writer.
...task completed by codex...
Result: completed (last provider: codex)
```

Error classes and their routing:

| Normalized error | Behavior |
|---|---|
| `QUOTA_EXHAUSTED` | checkpoint → handoff capsule → next provider |
| `PROVIDER_UNAVAILABLE` | checkpoint → handoff capsule → next provider |
| `TEMP_RATE_LIMIT` / `NETWORK_FAILURE` | retry same provider with backoff (config `max_attempts`), then next |
| `AUTH_REQUIRED` | pause task (resume later with `continuum resume`) |
| `CONTEXT_EXHAUSTED` | provider marked, task paused (compaction: roadmap) |
| `AGENT_CRASH` | task paused; recover via checkpoints |
| `USER_CANCELLED` | task paused |

### `.continuum/` layout

```
.continuum/
  config.yaml          routing order, failover rules, provider options
  state.db             SQLite: tasks, providers, checkpoints
  events.ndjson        append-only normalized event log
  project.md  decisions.md  constraints.md   durable human-readable memory
  current-task.json    quick-look task state
  handoffs/0001.txt..  handoff capsules (+ latest.txt)
  checkpoints/0001.json  git status/diff snapshots
  sessions/codex.json  native session ids for resume
  workspace.lock       writer lock (one active agent)
  mock-providers.json  optional mock scripts (for --mock)
```

## Status

- ✅ Core runtime: deterministic supervisor, routing, writer lock, checkpoints, handoff capsules, normalized events/errors, SQLite+NDJSON state, CLI
- ✅ Real adapters: **Codex** and **OpenCode verified live on Windows** (real failover + retries demonstrated); Claude/Antigravity adapters implemented, pending verification until those CLIs are installed
- ✅ Retry-with-backoff for transient failures; preflight skip for uninstalled providers
- 📌 Roadmap: context compactor (hierarchical summarization), smart routing, full Ink TUI, semantic memory (optional)

## Tests

```bash
npm test    # 14 tests: acceptance scenario (quota → checkpoint → handoff → continue),
            # lock semantics, AUTH_REQUIRED pause, retry-then-success, error classifier
```
