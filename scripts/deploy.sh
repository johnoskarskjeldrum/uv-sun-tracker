#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deploy sol-tracker til Raspberry Pi.
#
#   1. Pusher lokale endringer til GitHub (hvis noe er ucommittet/upushet).
#   2. SSH-er inn paa Pi-en: git pull, pip install ved behov, restart tjeneste.
#
# Konfigureres via scripts/deploy.env (kopier fra deploy.env.example).
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Fant ikke $ENV_FILE"
  echo "   Kopier malen og fyll inn dine verdier:"
  echo "     cp scripts/deploy.env.example scripts/deploy.env"
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${PI_HOST:?Sett PI_HOST i deploy.env (f.eks. pi@raspberrypi.local)}"
: "${PI_DIR:?Sett PI_DIR i deploy.env (f.eks. ~/uv-sun-tracker)}"
: "${SERVICE:=sol-tracker}"
BRANCH="${BRANCH:-main}"

cd "$REPO_DIR"

# --- 1. Push lokale endringer -------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  MSG="${1:-Deploy: $(git log -1 --format=%h 2>/dev/null || echo update)}"
  echo "📦 Ucommittede endringer funnet — committer: \"$MSG\""
  git add -A
  git commit -q -m "$MSG"
fi

if [[ -n "$(git log "@{u}.." 2>/dev/null || echo unpushed)" ]]; then
  echo "⬆️  Pusher til origin/$BRANCH ..."
  git push -q origin "$BRANCH"
fi

# --- 2. Oppdater Pi-en via SSH ------------------------------------------------
echo "🚀 Deployer til $PI_HOST:$PI_DIR ..."
ssh "$PI_HOST" bash -s -- "$PI_DIR" "$SERVICE" "$BRANCH" <<'REMOTE'
set -euo pipefail
PI_DIR="$1"; SERVICE="$2"; BRANCH="$3"
cd "${PI_DIR/#\~/$HOME}"

echo "   → git pull"
BEFORE=$(git rev-parse HEAD)
git pull --ff-only origin "$BRANCH"
AFTER=$(git rev-parse HEAD)

# Installer avhengigheter paa nytt bare hvis requirements.txt endret seg.
if [[ "$BEFORE" != "$AFTER" ]] && git diff --name-only "$BEFORE" "$AFTER" | grep -q '^requirements.txt$'; then
  echo "   → requirements.txt endret — installerer avhengigheter"
  ./.venv/bin/pip install -q -r requirements.txt
fi

echo "   → restart $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 1
systemctl is-active --quiet "$SERVICE" && echo "   ✅ $SERVICE kjører" || {
  echo "   ❌ $SERVICE startet ikke — siste logg:"; sudo journalctl -u "$SERVICE" -n 20 --no-pager; exit 1;
}
REMOTE

echo "✅ Deploy fullført."
