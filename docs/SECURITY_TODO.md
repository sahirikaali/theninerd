# Security Hardening Plan — Express Server (Internet-Facing on 443)

## Context

The Event Handler Express server (`event_handler/server.js`) is being deployed to the public internet on port 443. It handles webhook ingress (Telegram, GitHub, generic), job creation via GitHub API, and Claude API calls — all expensive or sensitive operations. This audit identified critical gaps that must be closed before exposure.

---

## 1. Rate Limiting (CRITICAL)

**Problem:** Zero rate limiting on any endpoint. An attacker can spam job creation (GitHub API + Docker runs), Telegram message processing (Claude API calls), or brute-force the API key.

**File:** `event_handler/server.js`

**Changes:**
- Install `express-rate-limit`
- Add a global limiter (e.g., 100 req/min per IP)
- Add stricter per-endpoint limiters:
  - `/webhook` — 10 req/min (creates expensive Docker jobs)
  - `/telegram/webhook` — 30 req/min (triggers Claude API calls)
  - `/github/webhook` — 20 req/min
  - `/jobs/status` — 30 req/min

```js
const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use(globalLimiter);

const jobLimiter = rateLimit({ windowMs: 60_000, max: 10 });
app.post('/webhook', jobLimiter, async (req, res) => { ... });
```

---

## 2. Constant-Time API Key Comparison (CRITICAL)

**Problem:** `req.headers['x-api-key'] !== API_KEY` is vulnerable to timing attacks.

**File:** `event_handler/server.js:36`

**Change:** Replace string `!==` with `crypto.timingSafeEqual`:

```js
const crypto = require('crypto');

function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
```

Apply the same fix to Telegram secret check (line 95) and GitHub webhook secret check (line 242).

---

## 3. Enforce Webhook Secrets (CRITICAL)

**Problem:** Both `TELEGRAM_WEBHOOK_SECRET` and `GH_WEBHOOK_SECRET` are optional. If unset, anyone can POST to these endpoints and trigger expensive API calls.

**File:** `event_handler/server.js:93, 240`

**Changes:**
- If `TELEGRAM_WEBHOOK_SECRET` is not set, reject all `/telegram/webhook` requests (log a startup warning)
- If `GH_WEBHOOK_SECRET` is not set, reject all `/github/webhook` requests (log a startup warning)
- Use `safeCompare` for both (from fix #2)

---

## 4. Request Body Size Limit (HIGH)

**Problem:** `express.json()` defaults to 100kb, which is fine for most endpoints, but should be explicitly set and tightened.

**File:** `event_handler/server.js:21`

**Change:**
```js
app.use(express.json({ limit: '50kb' }));
```

---

## 5. Job Description Validation (HIGH)

**Problem:** No length or type validation on the `job` field from `/webhook`. Could create huge files via GitHub API.

**File:** `event_handler/server.js:60-61`

**Changes:**
- Validate `job` is a string
- Enforce max length (e.g., 10,000 chars)

```js
if (!job || typeof job !== 'string') return res.status(400).json({ error: 'Missing or invalid job field' });
if (job.length > 10000) return res.status(400).json({ error: 'Job description too long' });
```

---

## 6. Fix Shell Injection in entrypoint.sh (CRITICAL)

**Problem:** `eval $(echo "$SECRETS_JSON" | jq -r 'to_entries | .[] | "export \(.key)=\"\(.value)\""')` is vulnerable to command injection if any secret value contains `$(...)`, backticks, or other shell metacharacters.

**File:** `entrypoint.sh:22, 40`

**Change:** Use `jq` to produce `key=value` pairs and `export` them without `eval`:

```bash
if [ -n "$SECRETS" ]; then
    SECRETS_JSON=$(printf '%s' "$SECRETS" | base64 -d)
    while IFS='=' read -r key value; do
        export "$key"="$value"
    done < <(printf '%s' "$SECRETS_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"')
    export SECRETS="$SECRETS_JSON"
fi
```

Apply the same pattern to the `LLM_SECRETS` block (line 38-41).

---

## 7. Fix Command Injection in Cron (HIGH)

**Problem:** `execAsync(command, { cwd: CRON_DIR })` uses `child_process.exec()` which spawns a shell. While CRONS.json is developer-controlled today, this is a defense-in-depth issue.

**File:** `event_handler/cron.js:41`

**Change:** Use `execFile` with explicit shell and validate that CRONS.json is not writable by agents (already enforced by `ALLOWED_PATHS=/logs` in auto-merge). Add a command length limit:

```js
const { execFile } = require('child_process');
// ...
if (command.length > 1000) throw new Error('Command too long');
const { stdout, stderr } = await new Promise((resolve, reject) => {
  execFile('/bin/sh', ['-c', command], { cwd: CRON_DIR, timeout: 30000 },
    (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr }));
});
```

Note: `execFile` with `/bin/sh -c` still runs in a shell, but adding the `timeout` prevents runaway commands. The real protection is that CRONS.json lives in `operating_system/` which is not in `ALLOWED_PATHS`, so agents cannot modify it.

---

## 8. Fix Path Prefix Matching in auto-merge.yml (HIGH)

**Problem:** `[[ "$file" == "$compare"* ]]` matches `logs` as a prefix, which means a file named `logs_malicious.js` would pass. Need a trailing `/` in the comparison.

**File:** `.github/workflows/auto-merge.yml:98-99`

**Change:**
```bash
compare="${prefix#/}"
# Ensure prefix comparison includes directory boundary
if [[ "$file" == "$compare"/* ]] || [[ "$file" == "$compare" ]]; then
```

---

## 9. Sanitize Error Messages (MEDIUM)

**Problem:** `github.js:22` throws `GitHub API error: ${res.status} ${error}` which includes raw API response text. This could leak internal details to callers.

**Files:** `event_handler/tools/github.js:22`

**Change:** Log the full error, throw a generic one:
```js
if (!res.ok) {
  const error = await res.text();
  console.error(`GitHub API error: ${res.status} ${endpoint}`, error);
  throw new Error(`GitHub API error: ${res.status}`);
}
```

The Express error handler at `server.js:290` already catches unhandled errors and returns generic messages, so this is defense-in-depth.

---

## 10. Add Request Logging (MEDIUM)

**Problem:** No audit trail of who called what endpoint, when. Impossible to detect attacks or investigate incidents.

**File:** `event_handler/server.js` (new middleware)

**Change:** Add minimal structured request logging:
```js
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
    }));
  });
  next();
});
```

---

## 11. Restrict render_md to Repo Root (MEDIUM)

**Problem:** `render_md` resolves `{{ filepath }}` relative to `REPO_ROOT` using `path.resolve()`, but doesn't verify the result stays within the repo. A `{{ ../../../etc/shadow.md }}` include would resolve outside.

**File:** `event_handler/utils/render-md.js:31`

**Change:** Add a bounds check:
```js
const includeResolved = path.resolve(REPO_ROOT, includePath.trim());
if (!includeResolved.startsWith(REPO_ROOT)) {
  console.log(`[render_md] Path traversal blocked: ${includePath}`);
  return match;
}
```

---

## 12. Docker: Add Non-Root User (MEDIUM)

**Problem:** Container runs everything as root, including Chrome and the Pi agent.

**File:** `Dockerfile`

**Change:** Add a non-root user after installing system dependencies:
```dockerfile
RUN useradd -m -u 1000 agent
# ... (keep installs as root) ...
USER agent
```

Note: This requires adjusting Chrome cache paths and the `/job` workdir ownership. Needs testing.

---

## 13. Pin pi-skills to Specific Commit (LOW)

**Problem:** `git clone https://github.com/badlogic/pi-skills.git` without a pinned commit means any upstream push changes what's in the Docker image.

**File:** `Dockerfile:40`

**Change:**
```dockerfile
RUN git clone https://github.com/badlogic/pi-skills.git /pi-skills && \
    cd /pi-skills && git checkout <COMMIT_SHA>
```

---

## Files to Modify (Summary)

| File | Changes |
|------|---------|
| `event_handler/server.js` | Rate limiting, timing-safe compare, enforce secrets, body size limit, job validation, request logging |
| `event_handler/package.json` | Add `express-rate-limit` dependency |
| `event_handler/cron.js` | Add command timeout and length limit |
| `event_handler/tools/github.js` | Sanitize error messages |
| `event_handler/utils/render-md.js` | Path traversal guard |
| `entrypoint.sh` | Replace `eval` with safe env export loop |
| `.github/workflows/auto-merge.yml` | Fix path prefix matching with trailing `/` |
| `Dockerfile` | Add non-root user, pin pi-skills commit |

---

## Verification

1. **Start server locally:** `cd event_handler && npm install && npm run dev`
2. **Test rate limiting:** Send rapid requests to `/webhook` and verify 429 responses after limit
3. **Test auth:** Send requests without API key, with wrong key — verify 401
4. **Test webhook secrets:** Send to `/telegram/webhook` and `/github/webhook` without secrets — verify rejection
5. **Test job validation:** POST oversized `job` field — verify 400
6. **Test entrypoint:** Run `entrypoint.sh` with secrets containing `$(echo pwned)` — verify no command execution
7. **Test auto-merge paths:** Create a PR with a file named `logs_evil.js` — verify it's blocked
8. **Test render_md:** Add `{{ ../../etc/passwd.md }}` to a test file — verify it's blocked
