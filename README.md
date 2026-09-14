<p align="center">
  <img src="assets/logo.svg" width="120" alt="Continuum logo — an unbroken loop" />
</p>

<h1 align="center">Continuum</h1>

<p align="center">
  <strong>The agent can stop. The project context doesn't.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D23.4-339933?logo=node.js&logoColor=white" alt="Node 23.4+" />
  <img src="https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-blue" alt="Cross platform" />
  <img src="https://img.shields.io/badge/tests-29%20passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" />
</p>

<p align="center">
  A local, <strong>provider-neutral continuity runtime</strong> for AI coding agents.<br />
  Continuum orchestrates <strong>Codex CLI, Claude Code, OpenCode</strong> and <strong>Antigravity CLI</strong>
  over one shared project context — so when the active agent hits a usage limit or dies,
  the task <strong>checkpoints, hands off, and continues</strong> with the next agent instead of restarting from scratch.
</p>

---

## ✨ Why Continuum?

| Pain | Continuum answer |
|---|---|
| Agent hits a 5-hour / weekly limit mid-task | `QUOTA_EXHAUSTED` → checkpoint → compact handoff capsule → next provider continues |
| Each CLI lives in its own context window | Virtual shared context: repo state + durable memory + working state + handoff capsule |
| Parallel agents overwrite each other | Single-writer `workspace.lock` — one active writer, clean handoffs |
| "What was the plan again?" after switching tools | `.continuum/` memory: decisions, constraints, sessions, event log, checkpoints |

## 🚀 Quickstart

```bash
# 1. Install in one line (needs Node 23.4+ and git; builds automatically)
npm install -g github:EmadEdu2033/Continuum
# now `continuum` is global. From a clone instead:
# npm install && npm run build && npm link

# 2. Inside any project you want to protect
cd my-project
continuum init          # creates .continuum/ (config, memory, state dirs)
continuum doctor        # which real CLIs are installed & authenticated

# 3. Guided run — pick the starter, then watch the live dashboard
continuum start         # interactive: choose codex/claude/opencode/antigravity
# or one-shot:
continuum run "Build the authentication system and run all tests"

# 4. Watch state
continuum status        # task + provider states + event count
continuum handoff       # latest handoff capsule
continuum logs          # normalized event log
continuum search "auth" # search decisions + compacted task memory
continuum compact       # fold the latest task history into memory
continuum switch claude # start next run with claude
continuum resume        # resume a paused task
continuum config        # change order, mode, models, retries — no YAML editing
```

> Offline demo? Add `--mock` to `run` / `start` / `doctor` (needs scripted providers in `.continuum/mock-providers.json`).
> Prefer plain logs? Add `--no-tui`.

## 🖥️ Live dashboard

`continuum start` (and `run` on a TTY) opens a full-screen dashboard:

```text
┌─ CONTINUUM · continuity runtime                        futureteach [live] ─┐
│ ⠹ claude step 2/4 run 02:05 active 00:45     files 7  cmds 3  caps 1      │
┌─ Providers ───────────────────┐  ┌─ Context ────────────────────────────┐
│ ◌ codex        EXHAUSTED      │  │ Task       Build the authentication…  │
│ ◉ claude       ACTIVE ◀ write │  │ Progress   ██████░░░░░░░░░ 25%        │
│ ● opencode     READY          │  │ Checkpoint #4                         │
│ ● antigravity  READY          │  │                                      │
└───────────────────────────────┘  └──────────────────────────────────────┘
┌─ Handoff chain ───────────────────────────────────────────────────────────┐
│  codex → claude → opencode → antigravity                                  │
└───────────────────────────────────────────────────────────────────────────┘
┌─ Live ────────────────────────────────────────────────────────────────────┐
│ codex failed: [QUOTA_EXHAUSTED] usage limit reached                       │
│ Checkpoint #4 created.                                                    │
│ Handoff capsule #1 created. Transferring to next provider...              │
│ claude is now the active writer (2/4).                                    │
└───────────────────────────────────────────────────────────────────────────┘
└─ q quit  s switch  h handoff  c checkpoint                       running ─┘
```

Keys: `c` checkpoint · `h` peek at the latest handoff · `q`/`Ctrl+C` abort (frees the writer lock).
Zero dependencies — hand-rolled ANSI, so it works on Windows Terminal, PowerShell 7, Linux and macOS.

## 🧠 How it works

```mermaid
flowchart LR
    subgraph Core["CONTINUUM CORE — deterministic, no LLM"]
        R[Ordered routing]
        L[(Shared context<br/>SQLite + NDJSON + md)]
        H{Handoff engine}
    end
    R --> A1[Codex]
    R --> A2[Claude]
    R --> A3[OpenCode]
    R --> A4[Antigravity]
    A1 -.->|quota / crash| H
    A2 -.->|quota / crash| H
    H -->|checkpoint + capsule| L
    L -->|resume with context| A3
```

1. **You pick a starter** (`continuum start`); the rest stay on standby — zero tokens spent until needed.
2. **The active agent works**; every output is normalized into one event protocol (`SessionStarted`, `FileChanged`, `CommandExecuted`, `AgentError`, …).
3. **On failure** the supervisor classifies the error, freezes the writer, snapshots `git status/diff`, writes a checkpoint and a compact **handoff capsule** (built from stored state — works even if the agent died mid-sentence).
4. **The next provider resumes**: it reuses its native session when available, inspects the repo first, and continues the same task.

## 🔌 Providers

| Provider | Binary | Session resume |
|---|---|---|
| Codex | `codex exec --json` | `resume <id>` |
| Claude Code | `claude -p --output-format stream-json` | `--resume` |
| OpenCode | `opencode run --format json` | `-s <id>` |
| Antigravity | `agy -p --output-format stream-json` | `--conversation` |

Uninstalled providers are skipped automatically (preflight `detect()`), never failing the run. `doctor` also verifies Codex login via `codex login status`; other providers report auth on their first real run. Per-provider model overrides live in `.continuum/config.yaml` (or `continuum config`, no YAML editing needed).

## 🔁 Failover policy

| Normalized error | Behavior |
|---|---|
| `QUOTA_EXHAUSTED` / `PROVIDER_UNAVAILABLE` | checkpoint → handoff capsule → next provider |
| `TEMP_RATE_LIMIT` / `NETWORK_FAILURE` | retry with backoff (configurable), then next provider |
| `AUTH_REQUIRED` / `USER_CANCELLED` | pause task (`continuum resume` later) |
| `CONTEXT_EXHAUSTED` | compact context → handoff capsule → next provider |
| `AGENT_CRASH` | pause, recover from latest checkpoint |

## 🧭 Routing

`routing.mode` in `.continuum/config.yaml` (or via `continuum config`):

- **`ordered`** (default) — follow the configured list verbatim. Predictable.
- **`smart`** — keep the configured list as the tie-breaker, but demote providers that are on cooldown or have failed recently, and skip ones that are exhausted/unavailable. Deterministic (no clocks, no randomness).

## 🧩 Context & memory

- **Compactor** — `CONTEXT_EXHAUSTED` (and every handoff) folds raw events into a bounded, hierarchical summary: raw events → per-session summaries → task memory. Deterministic, so it is safe inside the control path.
- **Semantic memory** — durable memory files and compacted summaries are indexed in **SQLite FTS5** and searched with BM25 via `continuum search "<query>"`. No vector database, no external calls; falls back to `LIKE` if FTS5 is unavailable.

## 📁 `.continuum/` layout

```text
.continuum/
  config.yaml          routing order, failover rules, provider options
  state.db             SQLite: tasks, providers, checkpoints, summaries, FTS index
  events.ndjson        append-only normalized event log
  project.md  decisions.md  constraints.md   durable human-readable memory
  current-task.json    quick-look task state
  handoffs/            capsules (+ latest.txt)
  checkpoints/         git status/diff snapshots
  sessions/            native session ids for resume
  workspace.lock       one active writer at a time
  mock-providers.json  optional mock scripts (for --mock)
```

## 🔧 Troubleshooting

| Symptom | Fix |
|---|---|
| `npm` not recognized (Windows) | Use `npm.cmd` — PowerShell blocks the `npm.ps1` shim by execution policy |
| `doctor` says `auth=NO` for codex | Run `codex login`, then `continuum resume` |
| `No providers available` with `--mock` | Add scripts to `.continuum/mock-providers.json` (one entry per provider id) |
| Task paused after a failure | `continuum resume` retries; `continuum switch <provider>` changes the starter |

## 🗺 Roadmap

- [x] Deterministic supervisor, ordered routing, writer lock
- [x] Checkpoints + system-generated handoff capsules
- [x] Codex / Claude / OpenCode / Antigravity adapters
- [x] Retry with backoff, preflight skip, mock mode
- [x] Hierarchical context compactor
- [x] Smart routing (health-aware, deterministic)
- [x] Full-screen live TUI (zero-dependency ANSI)
- [x] Semantic memory (SQLite FTS5 BM25 + LIKE fallback)

## 🤝 Contributing

PRs welcome! Run the checks before pushing:

```bash
npm run build && npm test   # 29 tests, must stay green
```

Keep adapters isolated (no provider logic in core) and add a regression test with every failover fix.

## 📄 License

[MIT](LICENSE) — free for personal and commercial use.
