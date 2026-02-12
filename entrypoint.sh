#!/bin/bash
set -e

# Extract job ID from branch name (job/uuid -> uuid), fallback to random UUID
if [[ "$BRANCH" == job/* ]]; then
    JOB_ID="${BRANCH#job/}"
else
    JOB_ID=$(cat /proc/sys/kernel/random/uuid)
fi
echo "Job ID: ${JOB_ID}"

# Start Chrome (using Puppeteer's chromium from pi-skills browser-tools)
CHROME_BIN=$(find /root/.cache/puppeteer -name "chrome" -type f | head -1)
$CHROME_BIN --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 2>/dev/null &
CHROME_PID=$!
sleep 2

# Export SECRETS (base64 JSON) as flat env vars (GH_TOKEN, NVIDIA_API_KEY, etc.)
# These are filtered from LLM's bash subprocess by env-sanitizer extension
if [ -n "$SECRETS" ]; then
    SECRETS_JSON=$(echo "$SECRETS" | base64 -d)
    eval $(echo "$SECRETS_JSON" | jq -r 'to_entries | .[] | "export \(.key)=\"\(.value)\""')
    export SECRETS="$SECRETS_JSON"  # Keep decoded for extension to parse
else
    echo "WARNING: SECRETS env var is empty!"
fi

# Debug: check if GH_TOKEN is set
if [ -z "$GH_TOKEN" ]; then
    echo "ERROR: GH_TOKEN is empty after decoding SECRETS"
    exit 1
else
    echo "GH_TOKEN is set (length: ${#GH_TOKEN})"
fi

# Export LLM_SECRETS (base64 JSON) as flat env vars
# These are NOT filtered - LLM can access these (browser logins, skill API keys, etc.)
if [ -n "$LLM_SECRETS" ]; then
    LLM_SECRETS_JSON=$(echo "$LLM_SECRETS" | base64 -d)
    eval $(echo "$LLM_SECRETS_JSON" | jq -r 'to_entries | .[] | "export \(.key)=\"\(.value)\""')
fi

# ============================================================
# Git authentication setup (token-in-URL, no gh CLI needed)
# ============================================================
git config --global user.name "theninerd"
git config --global user.email "theninerd@users.noreply.github.com"
export GIT_TERMINAL_PROMPT=0

# Build authenticated URL
AUTH_URL=$(echo "$REPO_URL" | sed "s|https://github.com/|https://x-access-token:${GH_TOKEN}@github.com/|")

# Clone
if [ -n "$REPO_URL" ]; then
    echo "Cloning: $REPO_URL branch: $BRANCH"
    git clone --single-branch --branch "$BRANCH" --depth 1 "$AUTH_URL" /job
else
    echo "No REPO_URL provided"
fi

cd /job

# Create temp directory for agent use (gitignored via tmp/)
mkdir -p /job/tmp

# Setup logs
LOG_DIR="/job/logs/${JOB_ID}"
mkdir -p "${LOG_DIR}"

# 1. Build system prompt from operating_system MD files
SYSTEM_FILES=("SOUL.md" "AGENT.md")
> /job/.pi/SYSTEM.md
for i in "${!SYSTEM_FILES[@]}"; do
    cat "/job/operating_system/${SYSTEM_FILES[$i]}" >> /job/.pi/SYSTEM.md
    if [ "$i" -lt $((${#SYSTEM_FILES[@]} - 1)) ]; then
        echo -e "\n\n" >> /job/.pi/SYSTEM.md
    fi
done

PROMPT="

# Your Job

$(cat /job/logs/${JOB_ID}/job.md)"

# Configure NVIDIA API via Pi's OpenRouter provider (NVIDIA is OpenAI-compatible)
MODEL_FLAGS=""
if [ -n "$MODEL" ]; then
    export OPENROUTER_API_KEY="$NVIDIA_API_KEY"
    export OPENROUTER_BASE_URL="https://integrate.api.nvidia.com/v1"
    MODEL_FLAGS="--provider openrouter --model $MODEL"
elif [ -n "$NVIDIA_API_KEY" ]; then
    export OPENROUTER_API_KEY="$NVIDIA_API_KEY"
    export OPENROUTER_BASE_URL="https://integrate.api.nvidia.com/v1"
    MODEL_FLAGS="--provider openrouter --model moonshotai/kimi-k2.5"
fi

pi $MODEL_FLAGS -p "$PROMPT" --session-dir "${LOG_DIR}"

# 2. Commit changes + logs
git add -A
git add -f "${LOG_DIR}"
git commit -m "theninerd: job ${JOB_ID}" || true

# Ensure remote URL has token embedded for push
AUTH_PUSH_URL=$(git remote get-url origin 2>/dev/null)
if ! echo "$AUTH_PUSH_URL" | grep -q "x-access-token"; then
    git remote set-url origin "$AUTH_URL"
fi
git push origin

# 3. Create PR via GitHub REST API (auto-merge handled by GitHub Actions workflow)
# Parse owner/repo from REPO_URL (e.g., https://github.com/owner/repo or https://github.com/owner/repo.git)
REPO_SLUG=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|\.git$||')
curl -sf -X POST "https://api.github.com/repos/${REPO_SLUG}/pulls" \
    -H "Authorization: token ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"title\":\"theninerd: job ${JOB_ID}\",\"body\":\"Automated job\",\"head\":\"job/${JOB_ID}\",\"base\":\"main\"}" || true

# Cleanup
kill $CHROME_PID 2>/dev/null || true
echo "Done. Job ID: ${JOB_ID}"
