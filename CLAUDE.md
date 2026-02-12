# theninerd - AI Agent

This document explains the theninerd codebase for AI assistants working on this project.

## What is theninerd?

theninerd is an autonomous AI agent built on top of the thepopebot template. It features a two-layer architecture: an Event Handler for orchestration (webhooks, Telegram chat, cron scheduling) and a Docker Agent for autonomous task execution via the Pi coding agent. It uses **NVIDIA API** (build.nvidia.com free tier) as its only LLM provider and **Telegram** as its chat interface.

## Two-Layer Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          theninerd Architecture                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────────┐                                                   │
│   │  Event Handler   │                                                   │
│   │  ┌────────────┐  │         1. create-job                            │
│   │  │  Telegram  │  │ ─────────────────────────►  ┌──────────────────┐ │
│   │  │   Cron     │  │                             │      GitHub      │ │
│   │  │   Chat     │  │ ◄─────────────────────────  │  (job/* branch)  │ │
│   │  └────────────┘  │   5. update-event-handler.yml calls             │ │
│   │                  │      /github/webhook                 │           │
│   └──────────────────┘                                      │           │
│            │                                                │           │
│            │                           2. run-job.yml       │           │
│            ▼                              triggers          │           │
│   ┌──────────────────┐                                      │           │
│   │ Telegram notifies│                                      ▼           │
│   │ user of job done │                         ┌──────────────────────┐ │
│   └──────────────────┘                         │    Docker Agent      │ │
│                                                │  ┌────────────────┐  │ │
│                                                │  │ 1. Clone       │  │ │
│                                                │  │ 2. Run Pi      │  │ │
│                                                │  │ 3. Commit      │  │ │
│                                                │  │ 4. Create PR   │  │ │
│                                                │  └────────────────┘  │ │
│                                                └──────────┬───────────┘ │
│                                                           │             │
│                                                           │ 3. PR opens │
│                                                           ▼             │
│                                                ┌──────────────────────┐ │
│                                                │       GitHub         │ │
│                                                │    (PR opened)       │ │
│                                                │                      │ │
│                                                │ 4. auto-merge.yml    │ │
│                                                │    (waits for merge  │ │
│                                                │     check, merges)   │ │
│                                                │          │           │ │
│                                                │          ▼           │ │
│                                                │ 5. update-event-     │ │
│                                                │    handler.yml       │ │
│                                                │    (notifies after   │ │
│                                                │     auto-merge done) │ │
│                                                └──────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
/
├── .github/workflows/
│   ├── auto-merge.yml       # Auto-merges job PRs (checks AUTO_MERGE + ALLOWED_PATHS)
│   ├── docker-build.yml     # Builds and pushes Docker image to GHCR
│   ├── run-job.yml          # Runs Docker agent when job/* branch created
│   └── update-event-handler.yml          # Notifies event handler when PR opened
├── .pi/
│   ├── extensions/             # Pi extensions (env-sanitizer for secret filtering)
│   └── skills/                 # Custom skills for the agent
├── docs/                       # Additional documentation
├── event_handler/              # Event Handler orchestration layer
│   ├── server.js               # Express HTTP server (webhooks, Telegram, GitHub)
│   ├── actions.js              # Shared action executor (agent, command, http)
│   ├── cron.js                 # Cron scheduler (loads CRONS.json)
│   ├── cron/                   # Working directory for command-type cron jobs
│   ├── triggers.js             # Webhook trigger middleware (loads TRIGGERS.json)
│   ├── triggers/               # Working directory for command-type trigger scripts
│   ├── claude/
│   │   ├── index.js            # NVIDIA API integration for chat (OpenAI-compatible)
│   │   ├── tools.js            # Tool definitions (create_job, get_job_status)
│   │   └── conversation.js     # Chat history management
│   └── tools/
│       ├── create-job.js       # Job creation via GitHub API
│       ├── github.js           # GitHub REST API helper + job status
│       └── telegram.js         # Telegram bot integration
├── operating_system/
│   ├── SOUL.md                 # Agent identity and personality
│   ├── CHATBOT.md              # Telegram chat system prompt
│   ├── JOB_SUMMARY.md          # Job completion summary prompt
│   ├── CRONS.json              # Scheduled job definitions
│   └── TRIGGERS.json           # Webhook trigger definitions
├── logs/                       # Per-job directories (job.md + session logs)
├── Dockerfile                  # Container definition
├── entrypoint.sh               # Container startup script
└── KEYS_SETUP.md               # Complete keys/secrets setup guide
```

## Key Files

| File | Purpose |
|------|---------|
| `operating_system/SOUL.md` | Agent personality and identity |
| `operating_system/CHATBOT.md` | System prompt for Telegram chat |
| `operating_system/JOB_SUMMARY.md` | Prompt for summarizing completed jobs |
| `logs/<JOB_ID>/job.md` | The specific task for the agent to execute |
| `Dockerfile` | Builds the agent container (Node.js 22, Playwright, Pi) |
| `entrypoint.sh` | Container startup script - clones repo, runs agent, commits results |
| `.pi/extensions/env-sanitizer/` | Filters secrets from LLM's bash subprocess environment |

## Event Handler Layer

The Event Handler is a Node.js Express server that provides orchestration capabilities:

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook` | POST | Generic webhook for job creation (requires API_KEY) |
| `/telegram/webhook` | POST | Telegram bot webhook for conversational interface |
| `/telegram/register` | POST | Register Telegram webhook URL |
| `/github/webhook` | POST | Receives notifications from GitHub Actions (update-event-handler.yml) |
| `/jobs/status` | GET | Check status of a running job |

### Components

- **server.js** - Express HTTP server handling all webhook routes
- **cron.js** - Loads CRONS.json and schedules jobs using node-cron
- **triggers.js** - Loads TRIGGERS.json and returns Express middleware for webhook triggers
- **claude/** - NVIDIA API integration for Telegram chat with tool use (OpenAI-compatible endpoint)
- **tools/** - Job creation, GitHub API, and Telegram utilities

### Action Types: `agent`, `command`, and `http`

Both cron jobs and webhook triggers use the same shared dispatch system (`event_handler/actions.js`). Every action has a `type` field — `"agent"` (default), `"command"`, or `"http"`.

#### Choosing Between `agent`, `command`, and `http`

| | `agent` | `command` | `http` |
|---|---------|-----------|--------|
| **Uses LLM** | Yes — spins up Pi in a Docker container | No — runs a shell command directly | No — makes an HTTP request |
| **Thinking** | Can reason, make decisions, write code | No thinking, just executes | No thinking, just sends a request |
| **Runtime** | Minutes to hours (full agent lifecycle) | Milliseconds to seconds | Milliseconds to seconds |
| **Cost** | LLM API calls + GitHub Actions minutes | Free (runs on event handler) | Free (runs on event handler) |

If the task needs to *think*, use `agent`. If it just needs to *do*, use `command`. If it needs to *call an external service*, use `http`.

#### Type: `agent` (default)

Creates a full Docker Agent job via `createJob()`. This pushes a `job/*` branch to GitHub, which triggers `run-job.yml` to spin up the Docker container with Pi. The `job` string is passed directly as-is to the LLM as its task prompt (written to `logs/<JOB_ID>/job.md` on the job branch).

**Best practice:** Keep the `job` field short. Put detailed task instructions in a dedicated markdown file in `operating_system/` and reference it by path:

```json
"job": "Read the file at operating_system/MY_TASK.md and complete the tasks described there."
```

This keeps config files clean and makes instructions easier to read and edit. Avoid writing long multi-line job descriptions inline.

#### Type: `command`

Runs a shell command directly on the event handler server. No Docker container, no GitHub branch, no LLM. Each system has its own working directory for scripts:
- **Crons**: `event_handler/cron/`
- **Triggers**: `event_handler/triggers/`

#### Type: `http`

Makes an HTTP request to an external URL. No Docker container, no LLM. Useful for forwarding webhooks, calling external APIs, or pinging health endpoints.

**Outgoing body logic:**
- `GET` requests skip the body entirely
- `POST` (default) sends `{ ...vars }` if no incoming data, or `{ ...vars, data: <incoming payload> }` when triggered by a webhook

**`http` action fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | yes | — | Target URL |
| `method` | no | `"POST"` | `"GET"` or `"POST"` |
| `headers` | no | `{}` | Outgoing request headers |
| `vars` | no | `{}` | Extra key/value pairs merged into outgoing body |

### Cron Jobs

Cron jobs are defined in `operating_system/CRONS.json` and loaded by `event_handler/cron.js` at startup using `node-cron`.

#### Fields

| Field | Description | Required |
|-------|-------------|----------|
| `name` | Display name for logging | Yes |
| `schedule` | Cron expression (e.g., `*/30 * * * *`) | Yes |
| `type` | `agent` (default), `command`, or `http` | No |
| `job` | Task description for agent type | For `agent` |
| `command` | Shell command for command type | For `command` |
| `url` | Target URL for http type | For `http` |
| `method` | HTTP method (`GET` or `POST`, default: `POST`) | No |
| `headers` | Outgoing request headers | No |
| `vars` | Extra key/value pairs merged into outgoing body | No |
| `enabled` | Set to `false` to disable without deleting | No |

### Webhook Triggers

Webhook triggers are defined in `operating_system/TRIGGERS.json` and loaded by `event_handler/triggers.js` as Express middleware. They fire actions when existing endpoints are hit. Triggers fire **after auth passes, before the route handler runs**, and are fire-and-forget (they don't block the request).

#### Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | — | Display name for logging |
| `watch_path` | yes | — | Existing endpoint path to watch (e.g., `/github/webhook`) |
| `actions` | yes | — | Array of actions (each uses `type`/`job`/`command` per action types above) |
| `actions[].type` | no | `"agent"` | `"agent"`, `"command"`, or `"http"` |
| `actions[].job` | for agent | — | Job description, supports `{{body}}` (full payload) and `{{body.field}}` templates |
| `actions[].command` | for command | — | Shell command, supports `{{body}}` and `{{body.field}}` templates |
| `actions[].url` | for http | — | Target URL |
| `actions[].method` | no | `"POST"` | HTTP method (`"GET"` or `"POST"`) |
| `actions[].headers` | no | `{}` | Outgoing request headers |
| `actions[].vars` | no | `{}` | Extra key/value pairs merged into outgoing body (incoming payload added as `data` field) |
| `enabled` | no | `true` | Set `false` to disable |

#### Template tokens

Both `job` and `command` strings support the same templates:
- `{{body}}` — full request body as JSON
- `{{body.field}}` — a specific field from the body
- `{{query}}` / `{{query.field}}` — query string params
- `{{headers}}` / `{{headers.field}}` — request headers

### Environment Variables (Event Handler)

| Variable | Description | Required |
|----------|-------------|----------|
| `API_KEY` | Authentication key for /webhook endpoint | Yes |
| `GH_TOKEN` | GitHub PAT for creating branches/files | Yes |
| `GH_OWNER` | GitHub repository owner | Yes |
| `GH_REPO` | GitHub repository name | Yes |
| `PORT` | Server port (default: 3000) | No |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather | For Telegram |
| `TELEGRAM_WEBHOOK_SECRET` | Secret for webhook validation | No |
| `GH_WEBHOOK_SECRET` | Secret for GitHub Actions webhook auth | For notifications |
| `NVIDIA_API_KEY` | NVIDIA NIM API key for chat (get at https://build.nvidia.com) | Yes (for chat) |
| `EVENT_HANDLER_MODEL` | NVIDIA model for chat (default: moonshotai/kimi-k2.5) | No |

## Docker Agent Layer

The Dockerfile creates a container with:
- **Node.js 22** (Bookworm slim)
- **Pi coding agent** (`@mariozechner/pi-coding-agent`)
- **Playwright + Chromium** (headless browser automation)
- **Git + curl** (for repository operations and PR creation via REST API)

### Runtime Flow (entrypoint.sh)

1. Extract Job ID from branch name (job/uuid → uuid) or generate UUID
2. Start headless Chrome (CDP on port 9222)
3. Decode `SECRETS` from base64, parse JSON, export each key as env var (filtered from LLM's bash)
4. Decode `LLM_SECRETS` from base64, parse JSON, export each key as env var (LLM can access these)
5. Configure Git (hardcoded theninerd committer, token-in-URL auth — no gh CLI)
6. Clone repository branch to `/job`
7. Run Pi with SOUL.md + job.md as prompt
8. Save session log to `logs/{JOB_ID}/`
9. Commit all changes with message `theninerd: job {JOB_ID}`
10. Push and create PR via GitHub REST API (`curl`) — auto-merge handled by `auto-merge.yml` workflow

### Environment Variables (Docker Agent)

| Variable | Description | Required |
|----------|-------------|----------|
| `REPO_URL` | Git repository URL to clone | Yes |
| `BRANCH` | Branch to clone and work on (e.g., job/uuid) | Yes |
| `SECRETS` | Base64-encoded JSON with protected credentials (GH_TOKEN, NVIDIA_API_KEY, etc.) - filtered from LLM | Yes |
| `LLM_SECRETS` | Base64-encoded JSON with credentials the LLM can access (browser logins, skill API keys) | No |

## GitHub Actions

GitHub Actions automate the job lifecycle. No manual webhook configuration needed.

### docker-build.yml

Triggers on push to `main`. Builds the Docker image and pushes it to GitHub Container Registry (GHCR). Only runs when `IMAGE_URL` is set to a GHCR URL (starts with `ghcr.io/`). Non-GHCR URLs skip this workflow entirely.

### run-job.yml

Triggers when a `job/*` branch is created. Runs the Docker agent container. If `IMAGE_URL` is set, pulls from that registry (logs into GHCR automatically for `ghcr.io/` URLs); otherwise falls back to `stephengpope/thepopebot:latest` from Docker Hub.

### update-event-handler.yml

Triggers after `auto-merge.yml` completes (via `workflow_run`), not in parallel. Checks out the PR branch, gathers all job data (job.md, commit message, changed files, session log), and sends a fat payload to the event handler including the `merge_result` (`success`/`failure`). The event handler then summarizes via NVIDIA API and sends a Telegram notification — no additional GitHub API calls needed.

### auto-merge.yml

Triggers when a PR is opened from a `job/*` branch. First waits for GitHub to compute mergeability (polls every 10s, up to 30 attempts). Then checks two repository variables before merging:

1. **`AUTO_MERGE`** — If set to `"false"`, skip merge entirely. Any other value (or unset) means auto-merge is enabled.
2. **`ALLOWED_PATHS`** — Comma-separated path prefixes (e.g., `/logs`). Only merges if all changed files fall within allowed prefixes. Defaults to `/logs` if unset.

If the PR is mergeable and both checks pass, merges the PR with `--squash`. If there's a merge conflict, the merge is skipped and the PR stays open for manual review. After this workflow completes, `update-event-handler.yml` fires to send the notification.

### GitHub Secrets Required

Only 3 secrets are needed. Everything else is auto-generated at runtime.

| Secret | Description | Required |
|--------|-------------|----------|
| `GH_PAT` | GitHub Classic PAT with `repo` + `workflow` scopes | Yes |
| `NVIDIA_API_KEY` | NVIDIA NIM API key from [build.nvidia.com](https://build.nvidia.com) | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | Yes |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID for notifications | After first run |
| `LLM_SECRETS` | Base64 JSON with agent-accessible credentials (optional) | No |

**Auto-generated** by workflows (derived deterministically from `GH_PAT`):
- `API_KEY`, `GH_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET` — sha256 hashes
- `SECRETS` JSON — built inline by `run-job.yml`
- `.env` file — built inline by `event-handler.yml`
- `GH_OWNER` / `GH_REPO` — extracted from `github.repository`

### GitHub Repository Variables

Configure these in **Settings → Secrets and variables → Actions → Variables**:

| Variable | Description | Default |
|----------|-------------|---------|
| `GH_WEBHOOK_URL` | Event handler URL (auto-set by `event-handler.yml`) | — |
| `AUTO_MERGE` | Set to `false` to disable auto-merge of job PRs | Enabled (any value except `false`) |
| `ALLOWED_PATHS` | Comma-separated path prefixes (e.g., `/logs`). Use `/` for all paths. | `/logs` |
| `IMAGE_URL` | Full Docker image path (e.g., `ghcr.io/myorg/mybot`). GHCR URLs trigger automatic builds via `docker-build.yml`. Non-GHCR URLs (e.g., `docker.io/user/mybot`) are pulled directly. | Not set (uses `stephengpope/thepopebot:latest`) |
| `MODEL` | NVIDIA model ID for the Pi agent (e.g., `moonshotai/kimi-k2.5`) | Not set (Pi default) |

## How Credentials Work

Workflows build credentials at runtime from flat GitHub Secrets:

- **`event-handler.yml`** generates the `.env` file from `GH_PAT`, `NVIDIA_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. Internal secrets (`API_KEY`, `GH_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET`) are derived as deterministic SHA-256 hashes of `GH_PAT`.
- **`run-job.yml`** builds the `SECRETS` JSON (`{"GH_TOKEN":"...","NVIDIA_API_KEY":"..."}`) and base64-encodes it inline.
- **`update-event-handler.yml`** derives `GH_WEBHOOK_SECRET` from `GH_PAT` using the same hash to authenticate with the event handler.

At runtime in the Docker container, `entrypoint.sh` decodes `SECRETS` and exports each key as a flat environment variable. The `env-sanitizer` extension filters these from the LLM's bash subprocess, so the agent can't `echo $NVIDIA_API_KEY`.

For credentials the LLM needs access to (browser logins, skill API keys), use `LLM_SECRETS` instead - these are NOT filtered.

## Customization Points

To create your own agent:

1. **GitHub Secrets** - Set `GH_PAT`, `NVIDIA_API_KEY`, `TELEGRAM_BOT_TOKEN`
2. **operating_system/SOUL.md** - Customize personality and identity
3. **operating_system/CHATBOT.md** - Configure Telegram chat behavior
4. **operating_system/CRONS.json** - Define scheduled jobs
5. **logs/<JOB_ID>/job.md** - Task description (created automatically per job)
6. **.pi/skills/** - Add custom skills for the agent

## The Operating System

These files in `operating_system/` define the agent's character and behavior:

- **SOUL.md** - Personality, identity, and values (who the agent is)
- **CHATBOT.md** - System prompt for Telegram chat
- **JOB_SUMMARY.md** - Prompt for summarizing completed jobs
- **CRONS.json** - Scheduled job definitions
- **TRIGGERS.json** - Webhook trigger definitions

## Session Logs

Each job gets its own directory at `logs/{JOB_ID}/` containing both the job description (`job.md`) and session logs (`.jsonl`). This directory can be used to resume sessions for follow-up tasks via the `--session-dir` flag.

## Markdown File Includes

Markdown files in `operating_system/` support a `{{filepath}}` include syntax, powered by `event_handler/utils/render-md.js`.

- **Syntax**: `{{ filepath }}` — double curly braces around a file path
- **Path resolution**: Paths resolve relative to the repository root
- **Recursive**: Included files can themselves contain includes
- **Circular protection**: If a circular include is detected, it is skipped and a warning is logged
- **Missing files**: If a referenced file doesn't exist, the pattern is left as-is

Currently used by the Event Handler to load CHATBOT.md (which includes CLAUDE.md) as the system prompt.
