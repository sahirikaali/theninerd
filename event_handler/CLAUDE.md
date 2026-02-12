# Event Handler Development Guidelines

## Reading Markdown Files

Always use `render_md` when reading `.md` files from `operating_system/`. Never use raw `fs.readFileSync` for markdown — `render_md` resolves `{{filepath}}` includes that markdown files may contain.

```js
const { render_md } = require('./utils/render-md');
const content = render_md(path.join(__dirname, '..', 'operating_system', 'SOME_FILE.md'));
```

This applies to any markdown file loaded as a prompt or system message (CHATBOT.md, JOB_SUMMARY.md, etc.).

## LLM Provider

theninerd uses **NVIDIA API** (build.nvidia.com) exclusively via OpenAI-compatible endpoints. The chat integration in `claude/index.js` calls `https://integrate.api.nvidia.com/v1/chat/completions` directly. Do not add multi-provider routing or fallback logic.

## Secrets

The event handler's `.env` file is auto-generated at runtime by `event-handler.yml` from 3 flat GitHub Secrets (`GH_PAT`, `NVIDIA_API_KEY`, `TELEGRAM_BOT_TOKEN`). Internal secrets like `API_KEY`, `GH_WEBHOOK_SECRET`, and `TELEGRAM_WEBHOOK_SECRET` are derived deterministically as SHA-256 hashes of `GH_PAT`. Do not add new secrets to `.env.example` that require manual user setup — if a new secret is needed, derive it from `GH_PAT` or add it as a GitHub Secret and wire it through `event-handler.yml`.
