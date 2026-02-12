# Customization

## The Operating System

The `operating_system/` directory is the agent's brain -- it defines who the agent is and how it behaves.

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent identity, personality traits, and values |
| `CHATBOT.md` | System prompt for Telegram chat |
| `JOB_SUMMARY.md` | Prompt for summarizing completed jobs |
| `CRONS.json` | Scheduled job definitions |
| `TRIGGERS.json` | Webhook trigger definitions |

Each job automatically gets its own `logs/<JOB_ID>/job.md` file created by the event handler. Jobs are created via Telegram chat, webhooks, or cron schedules.

---

## Using Your Bot

There are currently two ways to trigger jobs -- Telegram and webhooks.

### Telegram Chat

Message your bot directly to chat or create jobs. The bot uses the NVIDIA API to understand your requests and can:

- **Chat** - Have a conversation, ask questions, get information
- **Create jobs** - Say "create a job to..." and the bot will spawn an autonomous agent

**Security:** During setup, you verify your chat ID. Once configured, the bot only responds to messages from your authorized chat and ignores everyone else.

### Webhooks

Create jobs programmatically via HTTP:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"job": "Update the README with installation instructions"}'
```

### Scheduled Jobs

Define recurring jobs in `operating_system/CRONS.json`:

```json
[
  {
    "name": "daily-check",
    "schedule": "0 9 * * *",
    "job": "Check for dependency updates",
    "enabled": true
  }
]
```

Set `"enabled": true` to activate a scheduled job.

---

## Skills

Add custom skills for the agent in `.pi/skills/`. Skills extend the agent's capabilities with specialized tools and behaviors.

---

## Security

| What the AI tries | What happens |
|-------------------|--------------|
| `echo $NVIDIA_API_KEY` | Empty |
| `echo $GH_TOKEN` | Empty |
| `cat /proc/self/environ` | Secrets missing |
| NVIDIA API calls | Work normally |
| Git push (via token-in-URL) | Works normally |

### How Secret Protection Works

1. `run-job.yml` builds a `SECRETS` JSON from `GH_PAT` + `NVIDIA_API_KEY` and base64-encodes it
2. The entrypoint decodes the JSON and exports each key as an env var
3. Pi starts -- NVIDIA API key is mapped via `OPENROUTER_API_KEY`/`OPENROUTER_BASE_URL` env vars
4. The `env-sanitizer` extension filters ALL secret keys from bash subprocess env
5. The LLM can't `echo $ANYTHING` -- subprocess env is filtered
6. Other extensions still have full `process.env` access

**What's Protected:**

Any key in the `SECRETS` JSON is automatically filtered from the LLM's bash environment. The `SECRETS` variable itself is also filtered.

```bash
# The SECRETS JSON contains:
{"GH_TOKEN": "...", "NVIDIA_API_KEY": "..."}

# So these return empty in the LLM's bash:
echo $GH_TOKEN           # empty
echo $NVIDIA_API_KEY     # empty
```

### LLM-Accessible Secrets

Sometimes you want the LLM to have access to certain credentials -- browser logins, skill API keys, or service passwords. Use `LLM_SECRETS` for these. Set it as a GitHub Secret (base64-encoded JSON).

```bash
# Accessible to LLM (not filtered)
LLM_SECRETS=$(echo -n '{"BROWSER_PASSWORD":"mypass123"}' | base64)
```

| Credential Type | Put In | Why |
|-----------------|--------|-----|
| `GH_TOKEN` | `SECRETS` | Agent shouldn't push to arbitrary repos |
| `NVIDIA_API_KEY` | `SECRETS` | Agent shouldn't leak billing keys |
| Browser login password | `LLM_SECRETS` | Skills may need to authenticate |
| Third-party API key for a skill | `LLM_SECRETS` | Skills need these to function |

### Implementation

The `env-sanitizer` extension in `.pi/extensions/` dynamically filters secrets:

```typescript
const bashTool = createBashTool(process.cwd(), {
  spawnHook: ({ command, cwd, env }) => {
    const filteredEnv = { ...env };
    if (process.env.SECRETS) {
      try {
        for (const key of Object.keys(JSON.parse(process.env.SECRETS))) {
          delete filteredEnv[key];
        }
      } catch {}
    }
    delete filteredEnv.SECRETS;
    return { command, cwd, env: filteredEnv };
  },
});
```

No special Docker flags required. Works on any host.

### Custom Extensions

The env-sanitizer protects against the **AI agent** accessing secrets through bash. Extension code itself can access `process.env` directly -- this is by design.

**Best practices:**
- Don't create tools that echo environment variables to the agent
- Review extension code before adding to your agent
