#!/usr/bin/env bash
# Automatic update of Anbar on the server, pulled from GitHub (docs/deploy.md, section 7.2).
# Runs from cron every few minutes; does nothing unless origin/main has new commits. Then:
#   1. takes a database backup inside the running app (no backup → no update),
#   2. moves the checkout to the new commit and rebuilds/restarts the app,
#   3. waits until Docker reports it healthy; otherwise goes back to the previous commit.
# Migrations only add to the database, so the previous version still starts on it.
#
#   tools/auto-deploy.sh            one check (what cron runs)
#   tools/auto-deploy.sh --install  adds the cron line (every 5 minutes, log in ~/anbar-deploy.log)
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$(pwd)"
BRANCH="${DEPLOY_BRANCH:-main}"
log() { echo "$(date '+%F %T') $*"; }

if [ "${1:-}" = "--install" ]; then
  line="*/5 * * * * cd $DIR && tools/auto-deploy.sh >> \$HOME/anbar-deploy.log 2>&1"
  (crontab -l 2>/dev/null | grep -v 'tools/auto-deploy.sh' || true; echo "$line") | crontab -
  log "installed: $line"
  exit 0
fi

# One run at a time (a build can take longer than the cron interval)
exec 9>"/tmp/anbar-deploy.lock"
flock -n 9 || exit 0

git fetch -q origin "$BRANCH"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
[ "$OLD" = "$NEW" ] && exit 0
[ -f .deploy-failed ] && [ "$(cat .deploy-failed)" = "$NEW" ] && exit 0

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "files were changed by hand on the server; not updating (see: git status)"
  exit 1
fi
if ! git merge-base --is-ancestor "$OLD" "$NEW"; then
  log "origin/$BRANCH is not ahead of this checkout; not updating"
  exit 1
fi

log "update $(git log -1 --format='%h %s' "$OLD") -> $(git log -1 --format='%h %s' "$NEW")"

if [ -n "$(docker compose ps -q --status running anbar 2>/dev/null)" ]; then
  docker compose exec -T anbar node server/backup-now.js || { log "backup failed; not updating"; exit 1; }
else
  log "app is not running; no backup possible, updating anyway"
fi

healthy() {
  local id status
  for _ in $(seq 1 60); do
    id="$(docker compose ps -q anbar)"
    status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "unhealthy" ] && return 1
    sleep 5
  done
  return 1
}

git merge -q --ff-only "origin/$BRANCH"
if docker compose up -d --build anbar && healthy; then
  log "ok: $(git log -1 --oneline)"
  exit 0
fi

log "the new version did not become healthy; going back to $(git log -1 --format='%h' "$OLD")"
docker compose logs --tail=60 anbar || true
git reset -q --hard "$OLD"
if docker compose up -d --build anbar && healthy; then
  log "rolled back; the server runs $(git log -1 --oneline). It will try $NEW again only after a newer commit."
else
  log "ROLLBACK FAILED: restore the last backup (docs/deploy.md, section 6)"
fi
# Remember the bad commit so cron does not rebuild it every 5 minutes
echo "$NEW" > .deploy-failed
exit 1
