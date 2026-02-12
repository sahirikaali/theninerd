# Architecture

theninerd uses a two-layer architecture:

1. **Event Handler** - Node.js server for webhooks, Telegram chat, and cron scheduling
2. **Docker Agent** - Pi coding agent container for autonomous task execution

```
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  ┌─────────────────┐         ┌─────────────────┐                     │
│  │  Event Handler  │ ──1──►  │     GitHub      │                     │
│  │  (creates job)  │         │ (job/* branch)  │                     │
│  └────────▲────────┘         └────────┬────────┘                     │
│           │                           │                              │
│           │                           2 (triggers run-job.yml)       │
│           │                           │                              │
│           │                           ▼                              │
│           │                  ┌─────────────────┐                     │
│           │                  │  Docker Agent   │                     │
│           │                  │  (runs Pi, PRs) │                     │
│           │                  └────────┬────────┘                     │
│           │                           │                              │
│           │                           3 (creates PR via REST API)    │
│           │                           │                              │
│           │                           ▼                              │
│           │                  ┌─────────────────┐                     │
│           │                  │     GitHub      │                     │
│           │                  │   (PR opened)   │                     │
│           │                  └────────┬────────┘                     │
│           │                           │                              │
│           │                           4a (auto-merge.yml)            │
│           │                           4b (update-event-handler.yml)  │
│           │                           │                              │
│           5 (Telegram notification)   │                              │
│           └───────────────────────────┘                              │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
/
├── .github/workflows/
│   ├── auto-merge.yml       # Auto-merges job PRs (checks AUTO_MERGE + ALLOWED_PATHS)
│   ├── docker-build.yml     # Builds and pushes Docker image to GHCR
│   ├── event-handler.yml    # Runs event handler continuously via Cloudflare Tunnel
│   ├── run-job.yml          # Runs Docker agent on job/* branch creation
│   └── update-event-handler.yml  # Notifies event handler on PR opened
├── .pi/
│   ├── extensions/          # Pi extensions (env-sanitizer for secret filtering)
│   └── skills/              # Custom skills for the agent
├── docs/                    # Additional documentation
├── event_handler/           # Event Handler orchestration layer
│   ├── server.js            # Express HTTP server
│   ├── actions.js           # Shared action executor (agent, command, http)
│   ├── cron.js              # Cron scheduler
│   ├── cron/                # Working directory for command-type cron jobs
│   ├── triggers.js          # Webhook trigger middleware
│   ├── triggers/            # Working directory for command-type trigger scripts
│   ├── .env                 # Environment config
│   ├── claude/              # NVIDIA API integration (OpenAI-compatible)
│   └── tools/               # Job creation, GitHub, Telegram utilities
├── operating_system/
│   ├── SOUL.md              # Agent identity and personality
│   ├── CHATBOT.md           # Telegram chat system prompt
│   ├── JOB_SUMMARY.md       # Job summary prompt
│   ├── CRONS.json           # Scheduled jobs
│   └── TRIGGERS.json        # Webhook trigger definitions
├── logs/                    # Per-job directories (job.md + session logs)
├── Dockerfile               # Container definition
├── entrypoint.sh            # Startup script
└── KEYS_SETUP.md            # Complete keys/secrets setup guide
```

---

## Event Handler

The Event Handler is a Node.js Express server that provides orchestration capabilities.

### API Endpoints

| Endpoint | Method | API_KEY | Purpose |
|----------|--------|---------|---------|
| `/ping` | GET | Y | Health check, returns `{"message": "Pong!"}` |
| `/webhook` | POST | Y | Generic webhook for job creation |
| `/telegram/webhook` | POST | N | Telegram bot webhook (uses its own secret) |
| `/telegram/register` | POST | Y | Register Telegram webhook URL |
| `/github/webhook` | POST | N | Receives notifications from GitHub Actions (uses its own secret) |
| `/jobs/status` | GET | Y | Check status of a running job |

**Examples:**

Create a job via webhook:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"job": "Update the README with installation instructions"}'
```

Check job status:

```bash
curl "http://localhost:3000/jobs/status?job_id=abc123" \
  -H "x-api-key: YOUR_API_KEY"
```

### Components

- **server.js** - Express HTTP server handling all webhook routes
- **cron.js** - Loads CRONS.json and schedules jobs using node-cron
- **triggers.js** - Loads TRIGGERS.json and returns Express middleware for webhook triggers
- **claude/** - NVIDIA API integration for Telegram chat with tool use
- **tools/** - Job creation, GitHub API, and Telegram utilities

---

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `docker-build.yml` | Push to `main` | Builds Docker image, pushes to GHCR |
| `event-handler.yml` | Manual or push to `main` | Runs event handler continuously with Cloudflare Tunnel |
| `run-job.yml` | `job/*` branch created | Runs Docker agent container |
| `auto-merge.yml` | PR opened from `job/*` branch | Checks `AUTO_MERGE` + `ALLOWED_PATHS`, merges if allowed |
| `update-event-handler.yml` | After `auto-merge.yml` completes | Gathers job data and sends to event handler for Telegram notification |

**Flow:**

1. Event handler creates a `job/uuid` branch via GitHub API
2. GitHub Actions detects branch creation -> runs `run-job.yml`
3. Docker agent executes task, commits results, creates PR (via GitHub REST API)
4. `auto-merge.yml` runs -> checks merge policy -> squash merges (or leaves open)
5. `update-event-handler.yml` runs -> gathers job data -> sends to event handler -> Telegram notification

---

## Docker Agent

The container executes tasks autonomously using the Pi coding agent.

**Container includes:**
- Node.js 22
- Pi coding agent
- Playwright + Chromium (headless browser, CDP port 9222)
- Git + curl (for repository operations and PR creation via REST API)

**Environment Variables (auto-set by `run-job.yml` — not user-managed):**

| Variable | Description | Required |
|----------|-------------|----------|
| `REPO_URL` | Your repository URL | Yes |
| `BRANCH` | Branch to work on (e.g., job/uuid) | Yes |
| `SECRETS` | Base64-encoded JSON with protected credentials (auto-built from `GH_PAT` + `NVIDIA_API_KEY`) | Yes |
| `LLM_SECRETS` | Base64-encoded JSON with LLM-accessible credentials (from `LLM_SECRETS` secret, if set) | No |

**Runtime Flow:**

1. Extract Job ID from branch name
2. Start Chrome in headless mode
3. Decode and export secrets (filtered from LLM's bash)
4. Decode and export LLM secrets (accessible to LLM)
5. Configure Git (hardcoded theninerd committer, token-in-URL auth)
6. Clone repository branch
7. Run Pi with SOUL.md + job.md
8. Commit all changes
9. Push and create PR via GitHub REST API (auto-merge handled by `auto-merge.yml` workflow)

---

## Session Logs

Each job gets its own directory at `logs/{JOB_ID}/` containing both the job description (`job.md`) and session logs (`.jsonl`). These can be used to resume sessions or review agent actions.
