#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# migrate-to-remote.sh
#
# Migrates a local Paperclip instance (PGlite) to a remote server running
# Docker Compose (Postgres). Preserves companies, agents, issues, secrets,
# storage, and the encryption master key.
#
# Usage:
#   ./scripts/migrate-to-remote.sh <ssh-target> [options]
#
# Examples:
#   ./scripts/migrate-to-remote.sh hetzner
#   ./scripts/migrate-to-remote.sh root@178.104.42.163
#   ./scripts/migrate-to-remote.sh hetzner --public-url https://my.domain.com
#   ./scripts/migrate-to-remote.sh hetzner --skip-cleanup
#   ./scripts/migrate-to-remote.sh hetzner --backup /path/to/specific-backup.sql
#
# Prerequisites:
#   - SSH access to the remote server
#   - Docker + Docker Compose installed on the remote server
#   - Paperclip repo cloned at /opt/paperclip on the remote (or set --remote-dir)
#   - Local Paperclip instance with data at ~/.paperclip/instances/default/
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_INSTANCE="${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}"
REMOTE_DIR="/opt/paperclip"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${BLUE}[migrate]${NC} $*"; }
ok()    { echo -e "${GREEN}[migrate]${NC} $*"; }
warn()  { echo -e "${YELLOW}[migrate]${NC} $*"; }
err()   { echo -e "${RED}[migrate]${NC} $*" >&2; }
die()   { err "$*"; exit 1; }

remote() { ssh "$SSH_TARGET" "$@"; }
remote_compose() { remote "cd $REMOTE_DIR && docker compose $*"; }
remote_psql() { remote "cd $REMOTE_DIR && docker compose exec -T db psql -U paperclip -d paperclip $*"; }

# ── Parse arguments ──────────────────────────────────────────────────────────

SSH_TARGET=""
PUBLIC_URL=""
SKIP_CLEANUP=false
BACKUP_PATH="latest"
BETTER_AUTH_SECRET=""
DEPLOYMENT_EXPOSURE="private"

usage() {
  echo "Usage: $0 <ssh-target> [options]"
  echo ""
  echo "Options:"
  echo "  --public-url <url>       Public URL for the instance (default: http://<host>:3100)"
  echo "  --skip-cleanup           Don't wipe existing remote data"
  echo "  --backup <path|latest>   Backup file to use (default: latest)"
  echo "  --auth-secret <secret>   Better Auth secret (default: auto-generate)"
  echo "  --exposure <private|public>  Deployment exposure (default: private)"
  echo "  --remote-dir <path>      Remote repo directory (default: /opt/paperclip)"
  echo "  -h, --help               Show this help"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url)    PUBLIC_URL="$2"; shift 2 ;;
    --skip-cleanup)  SKIP_CLEANUP=true; shift ;;
    --backup)        BACKUP_PATH="$2"; shift 2 ;;
    --auth-secret)   BETTER_AUTH_SECRET="$2"; shift 2 ;;
    --exposure)      DEPLOYMENT_EXPOSURE="$2"; shift 2 ;;
    --remote-dir)    REMOTE_DIR="$2"; shift 2 ;;
    -h|--help)       usage ;;
    -*)              die "Unknown option: $1" ;;
    *)
      if [[ -z "$SSH_TARGET" ]]; then
        SSH_TARGET="$1"; shift
      else
        die "Unexpected argument: $1"
      fi
      ;;
  esac
done

[[ -n "$SSH_TARGET" ]] || usage

# ── Validate local instance ─────────────────────────────────────────────────

log "Checking local Paperclip instance at $LOCAL_INSTANCE"

[[ -d "$LOCAL_INSTANCE" ]] || die "Local instance not found at $LOCAL_INSTANCE"
[[ -f "$LOCAL_INSTANCE/secrets/master.key" ]] || die "No master.key found — cannot decrypt agent secrets"

BACKUP_DIR="$LOCAL_INSTANCE/data/backups"

if [[ "$BACKUP_PATH" == "latest" ]]; then
  [[ -d "$BACKUP_DIR" ]] || die "No backup directory at $BACKUP_DIR"
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/paperclip-*.sql 2>/dev/null | head -1)
  [[ -n "$BACKUP_FILE" ]] || die "No backup files found in $BACKUP_DIR"
else
  BACKUP_FILE="$BACKUP_PATH"
fi

[[ -f "$BACKUP_FILE" ]] || die "Backup file not found: $BACKUP_FILE"
ok "Using backup: $(basename "$BACKUP_FILE")"

# ── Read local env ───────────────────────────────────────────────────────────

LOCAL_JWT_SECRET=""
if [[ -f "$LOCAL_INSTANCE/.env" ]]; then
  LOCAL_JWT_SECRET=$(grep -o 'PAPERCLIP_AGENT_JWT_SECRET=.*' "$LOCAL_INSTANCE/.env" | cut -d= -f2 || true)
fi
[[ -n "$LOCAL_JWT_SECRET" ]] || warn "No PAPERCLIP_AGENT_JWT_SECRET in local .env — agents may need new API keys"

if [[ -z "$BETTER_AUTH_SECRET" ]]; then
  BETTER_AUTH_SECRET=$(openssl rand -hex 32)
  log "Generated new BETTER_AUTH_SECRET"
fi

# ── Validate remote ─────────────────────────────────────────────────────────

log "Checking remote server ($SSH_TARGET)"
remote "docker --version > /dev/null 2>&1 && docker compose version > /dev/null 2>&1" \
  || die "Docker or Docker Compose not available on remote"
remote "test -f $REMOTE_DIR/docker-compose.yml" \
  || die "No docker-compose.yml at $REMOTE_DIR on remote. Clone the repo first."
ok "Remote server ready"

# ── Derive public URL if not set ─────────────────────────────────────────────

if [[ -z "$PUBLIC_URL" ]]; then
  REMOTE_HOST=$(remote "hostname -I 2>/dev/null | awk '{print \$1}'" | tr -d '[:space:]' || true)
  if [[ -z "$REMOTE_HOST" ]]; then
    REMOTE_HOST=$(echo "$SSH_TARGET" | sed 's/.*@//')
  fi
  PUBLIC_URL="http://${REMOTE_HOST}:3100"
  log "Auto-detected public URL: $PUBLIC_URL"
fi

# ── Step 1: Write remote .env early (docker compose needs it) ────────────────

log "Writing remote .env..."

JWT_LINE=""
if [[ -n "$LOCAL_JWT_SECRET" ]]; then
  JWT_LINE="PAPERCLIP_AGENT_JWT_SECRET=$LOCAL_JWT_SECRET"
fi

remote "cat > $REMOTE_DIR/.env" << EOF
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
PAPERCLIP_PUBLIC_URL=$PUBLIC_URL
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=$DEPLOYMENT_EXPOSURE
$JWT_LINE
EOF

remote "rm -f $REMOTE_DIR/docker-compose.override.yml"

# ── Step 2: Detect extra migrations ──────────────────────────────────────────

MIGRATIONS_DIR="$REPO_ROOT/packages/db/src/migrations"

log "Checking for migrations newer than the Docker image..."

# Build the image if needed (quiet), then list migrations inside it
remote_compose "build --quiet server" > /dev/null 2>&1 || true

CONTAINER_MIGRATIONS=$(remote_compose "run --rm --no-deps server sh -c 'ls /app/packages/db/src/migrations/*.sql 2>/dev/null'" 2>/dev/null \
  | xargs -I{} basename {} | grep '\.sql$' | sort || true)

LOCAL_MIGRATIONS=$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | xargs -I{} basename {} | sort)

EXTRA_MIGRATIONS=""
if [[ -n "$CONTAINER_MIGRATIONS" ]]; then
  EXTRA_MIGRATIONS=$(comm -23 <(echo "$LOCAL_MIGRATIONS") <(echo "$CONTAINER_MIGRATIONS") || true)
else
  warn "Could not detect container migrations — will apply all local migrations as extras"
  EXTRA_MIGRATIONS="$LOCAL_MIGRATIONS"
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/paperclip-migrate.XXXXXX")
trap "rm -rf '$WORK_DIR'" EXIT

EXTRA_COUNT=0
if [[ -n "$EXTRA_MIGRATIONS" ]]; then
  EXTRA_COUNT=$(echo "$EXTRA_MIGRATIONS" | wc -l | tr -d ' ')
  log "Found $EXTRA_COUNT extra migrations to apply"

  > "$WORK_DIR/extra-migrations.sql"
  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    sed 's/^--> statement-breakpoint$//' "$MIGRATIONS_DIR/$migration" >> "$WORK_DIR/extra-migrations.sql"
    echo "" >> "$WORK_DIR/extra-migrations.sql"
  done <<< "$EXTRA_MIGRATIONS"
else
  log "No extra migrations needed"
fi

# ── Step 3: Extract data-only SQL from backup ────────────────────────────────

log "Extracting data from backup..."

python3 - "$BACKUP_FILE" "$WORK_DIR/data-only.sql" << 'PYEOF'
import re, sys

backup_path = sys.argv[1]
output_path = sys.argv[2]

with open(backup_path) as f:
    content = f.read()

# Split by the breakpoint markers (includes the UUID on the same line)
blocks = content.split('-- paperclip statement breakpoint')

out = []
out.append('SET session_replication_role = replica;')
out.append('SET client_min_messages = warning;')

for block in blocks:
    stripped = block.strip()
    lines = stripped.split('\n')
    # Remove UUID-only lines (breakpoint IDs) and SQL comment lines
    sql_lines = [l for l in lines
                 if not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-', l.strip())
                 and not l.strip().startswith('--')]
    sql = '\n'.join(sql_lines).strip()
    if not sql:
        continue
    upper = sql.upper().lstrip()
    if upper.startswith('INSERT INTO') or upper.startswith('SELECT SETVAL'):
        out.append(sql)

out.append('SET session_replication_role = default;')

with open(output_path, 'w') as f:
    f.write('\n'.join(out) + '\n')

insert_count = len([s for s in out if s.upper().lstrip().startswith('INSERT')])
setval_count = len([s for s in out if s.upper().lstrip().startswith('SELECT')])
print(f"  {insert_count} INSERT statements, {setval_count} SETVAL statements")
PYEOF

# ── Step 4: Bundle and transfer ──────────────────────────────────────────────

log "Bundling data for transfer..."

cp "$LOCAL_INSTANCE/secrets/master.key" "$WORK_DIR/master.key"

# Instance .env (optional)
if [[ -f "$LOCAL_INSTANCE/.env" ]]; then
  cp "$LOCAL_INSTANCE/.env" "$WORK_DIR/instance.env"
fi

# Storage files (optional)
if [[ -d "$LOCAL_INSTANCE/data/storage" ]]; then
  cp -r "$LOCAL_INSTANCE/data/storage" "$WORK_DIR/storage"
fi

# Build file list for tar (only include files that exist)
TAR_FILES="data-only.sql master.key"
[[ -f "$WORK_DIR/instance.env" ]] && TAR_FILES="$TAR_FILES instance.env"
[[ -f "$WORK_DIR/extra-migrations.sql" ]] && TAR_FILES="$TAR_FILES extra-migrations.sql"
[[ -d "$WORK_DIR/storage" ]] && TAR_FILES="$TAR_FILES storage"

# Write config.json locally (avoids fragile remote heredoc quoting)
cat > "$WORK_DIR/config.json" << CFGEOF
{
  "\$meta": { "version": 1, "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)", "source": "onboard" },
  "database": {
    "mode": "postgres",
    "connectionString": "postgres://paperclip:paperclip@db:5432/paperclip",
    "backup": { "enabled": true, "intervalMinutes": 60, "retentionDays": 30, "dir": "/paperclip/instances/default/data/backups" }
  },
  "logging": { "mode": "file", "logDir": "/paperclip/instances/default/logs" },
  "server": {
    "deploymentMode": "authenticated",
    "exposure": "$DEPLOYMENT_EXPOSURE",
    "host": "0.0.0.0",
    "port": 3100,
    "allowedHostnames": [],
    "serveUi": true
  },
  "auth": { "baseUrlMode": "explicit", "publicBaseUrl": "$PUBLIC_URL", "disableSignUp": false },
  "storage": {
    "provider": "local_disk",
    "localDisk": { "baseDir": "/paperclip/instances/default/data/storage" },
    "s3": { "bucket": "paperclip", "region": "us-east-1", "prefix": "", "forcePathStyle": false }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": { "keyFilePath": "/paperclip/instances/default/secrets/master.key" }
  }
}
CFGEOF
TAR_FILES="$TAR_FILES config.json"

# shellcheck disable=SC2086
tar czf "$WORK_DIR/bundle.tar.gz" -C "$WORK_DIR" $TAR_FILES

BUNDLE_SIZE=$(du -h "$WORK_DIR/bundle.tar.gz" | cut -f1)
log "Bundle size: $BUNDLE_SIZE"

log "Transferring to remote..."
scp -q "$WORK_DIR/bundle.tar.gz" "$SSH_TARGET:/tmp/paperclip-bundle.tar.gz"
remote "rm -rf /tmp/paperclip-migrate && mkdir -p /tmp/paperclip-migrate && tar xzf /tmp/paperclip-bundle.tar.gz -C /tmp/paperclip-migrate"
ok "Transfer complete"

# ── Step 5: Stop and clean existing remote instance ──────────────────────────

if [[ "$SKIP_CLEANUP" == false ]]; then
  log "Stopping and cleaning existing remote instance..."
  remote_compose "down -v" > /dev/null 2>&1 || true
  ok "Old instance removed"
else
  log "Skipping cleanup (--skip-cleanup), stopping containers..."
  remote_compose "down" > /dev/null 2>&1 || true
fi

# ── Step 6: Start Postgres and bootstrap schema via Drizzle ──────────────────

log "Starting Postgres..."
remote_compose "up -d db" > /dev/null 2>&1

log "Waiting for Postgres to be ready..."
for _ in $(seq 1 30); do
  if remote_compose "exec -T db pg_isready -U paperclip" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
remote_compose "exec -T db pg_isready -U paperclip" > /dev/null 2>&1 \
  || die "Postgres failed to start within 30s"
ok "Postgres ready"

log "Bootstrapping schema via Drizzle..."
remote_compose "up -d server" > /dev/null 2>&1

# Wait for server to finish migration (either success or failure, we just need schema)
for _ in $(seq 1 30); do
  LOGS=$(remote_compose "logs server 2>&1" || true)
  if echo "$LOGS" | grep -q "Server listening\|already applied\|failed to start"; then
    break
  fi
  sleep 1
done

# Verify tables were created
TABLE_COUNT=$(remote_psql "-t -c \"SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';\"" | tr -d ' ')
if [[ "$TABLE_COUNT" -lt 10 ]]; then
  die "Schema bootstrap failed (only $TABLE_COUNT tables). Check: ssh $SSH_TARGET 'cd $REMOTE_DIR && docker compose logs server'"
fi
ok "Schema bootstrapped ($TABLE_COUNT tables)"

remote_compose "stop server" > /dev/null 2>&1

# ── Step 7: Apply extra migrations ───────────────────────────────────────────

if [[ "$EXTRA_COUNT" -gt 0 ]]; then
  log "Applying $EXTRA_COUNT extra migrations..."
  # Pipe from local file through ssh stdin to remote psql
  remote_compose "exec -T db psql -U paperclip -d paperclip -v ON_ERROR_STOP=1" \
    < "$WORK_DIR/extra-migrations.sql" > /dev/null 2>&1 \
    || die "Failed to apply extra migrations. Check SQL at $WORK_DIR/extra-migrations.sql"
  ok "Extra migrations applied"
fi

# ── Step 8: Import data ─────────────────────────────────────────────────────

log "Importing data (this may take a moment)..."

# No transaction wrapper — use ON_ERROR_STOP=0 to tolerate individual row failures
# (e.g., FK ordering within the dump). session_replication_role=replica disables FK checks.
IMPORT_OUTPUT=$(remote_compose "exec -T db psql -U paperclip -d paperclip -v ON_ERROR_STOP=0" \
  < "$WORK_DIR/data-only.sql" 2>&1)

IMPORT_INSERTS=$(echo "$IMPORT_OUTPUT" | grep -c "INSERT" || true)
IMPORT_ERRORS=$(echo "$IMPORT_OUTPUT" | grep -c "ERROR" || true)

if [[ "$IMPORT_ERRORS" -gt 0 ]]; then
  warn "Imported $IMPORT_INSERTS rows with $IMPORT_ERRORS errors (likely FK ordering issues)"
  warn "Retrying failed rows..."

  # Second pass catches rows that failed due to FK ordering
  RETRY_OUTPUT=$(remote_compose "exec -T db psql -U paperclip -d paperclip -v ON_ERROR_STOP=0" \
    < "$WORK_DIR/data-only.sql" 2>&1)

  RETRY_NEW=$(echo "$RETRY_OUTPUT" | grep -c "INSERT" || true)
  RETRY_DUPES=$(echo "$RETRY_OUTPUT" | grep -c "duplicate key\|ERROR" || true)

  if [[ "$RETRY_NEW" -gt "$RETRY_DUPES" ]]; then
    ok "Retry recovered $(( RETRY_NEW - RETRY_DUPES )) additional rows"
  else
    ok "Retry complete — all recoverable rows imported"
  fi
else
  ok "Data imported successfully ($IMPORT_INSERTS rows)"
fi

# ── Step 9: Copy secrets, storage, and config into volume ────────────────────

log "Copying secrets, storage, and config into Docker volume..."
remote "chmod -R a+r /tmp/paperclip-migrate/"
remote_compose "run --rm -v /tmp/paperclip-migrate:/migrate server sh -c '
  mkdir -p /paperclip/instances/default/secrets \
           /paperclip/instances/default/data \
           /paperclip/instances/default/data/backups \
           /paperclip/instances/default/logs
  cp /migrate/master.key /paperclip/instances/default/secrets/master.key
  cp /migrate/config.json /paperclip/instances/default/config.json
  test -d /migrate/storage && cp -r /migrate/storage /paperclip/instances/default/data/storage
  test -f /migrate/instance.env && cp /migrate/instance.env /paperclip/instances/default/.env
  echo done
'" > /dev/null 2>&1
ok "Secrets, storage, and config copied"

# ── Step 10: Start the server ────────────────────────────────────────────────

log "Starting Paperclip server..."
remote_compose "up -d" > /dev/null 2>&1

# Wait for the server to report listening
SERVER_OK=false
for _ in $(seq 1 20); do
  sleep 1
  if remote_compose "logs server --tail 5 2>&1" | grep -q "Server listening"; then
    SERVER_OK=true
    break
  fi
done

if [[ "$SERVER_OK" == true ]]; then
  ok "Server is running"
else
  warn "Server may not have started cleanly. Check:"
  warn "  ssh $SSH_TARGET 'cd $REMOTE_DIR && docker compose logs server --tail 30'"
fi

# ── Step 11: Verify data ────────────────────────────────────────────────────

log "Verifying migration..."

REMOTE_COMPANIES=$(remote_psql "-t -c \"SELECT count(*) FROM companies;\"" | tr -d ' ')
REMOTE_AGENTS=$(remote_psql "-t -c \"SELECT count(*) FROM agents;\"" | tr -d ' ')
REMOTE_ISSUES=$(remote_psql "-t -c \"SELECT count(*) FROM issues;\"" | tr -d ' ')

# Count expected rows from backup (handles multi-line INSERTs correctly)
read -r EXPECTED_COMPANIES EXPECTED_AGENTS EXPECTED_ISSUES <<< "$(python3 - "$BACKUP_FILE" << 'COUNTEOF'
import re, sys
with open(sys.argv[1]) as f:
    content = f.read()
counts = {"companies": 0, "agents": 0, "issues": 0}
for block in content.split("-- paperclip statement breakpoint"):
    lines = [l for l in block.strip().split("\n")
             if not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-", l.strip())
             and not l.strip().startswith("--")]
    sql = "\n".join(lines).strip()
    for table in counts:
        if sql.startswith(f'INSERT INTO "public"."{table}"'):
            counts[table] += 1
            break
print(f'{counts["companies"]} {counts["agents"]} {counts["issues"]}')
COUNTEOF
)"

VERIFY_OK=true
for pair in "companies:$REMOTE_COMPANIES:$EXPECTED_COMPANIES" \
            "agents:$REMOTE_AGENTS:$EXPECTED_AGENTS" \
            "issues:$REMOTE_ISSUES:$EXPECTED_ISSUES"; do
  TABLE=$(echo "$pair" | cut -d: -f1)
  ACTUAL=$(echo "$pair" | cut -d: -f2)
  EXPECTED=$(echo "$pair" | cut -d: -f3)
  if [[ "$ACTUAL" == "$EXPECTED" ]]; then
    ok "  $TABLE: $ACTUAL/$EXPECTED"
  else
    warn "  $TABLE: $ACTUAL/$EXPECTED (mismatch)"
    VERIFY_OK=false
  fi
done

if [[ "$VERIFY_OK" == false ]]; then
  warn "Some row counts don't match. This may be due to multi-line INSERT statements"
  warn "in the backup (grep undercounts them). Check the UI to confirm data looks correct."
fi

# ── Step 12: Bootstrap CEO invite ────────────────────────────────────────────

log "Creating admin invite..."
INVITE_OUTPUT=$(remote_compose "exec server npx paperclipai auth bootstrap-ceo --force" 2>&1 || true)
INVITE_URL=$(echo "$INVITE_OUTPUT" | grep -o 'http[^ ]*invite[^ ]*' || true)

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Migration complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Server:     ${BLUE}$PUBLIC_URL${NC}"
echo -e "  Mode:       authenticated ($DEPLOYMENT_EXPOSURE)"
echo -e "  Data:       $REMOTE_COMPANIES companies, $REMOTE_AGENTS agents, $REMOTE_ISSUES issues"
echo ""
if [[ -n "$INVITE_URL" ]]; then
  echo -e "  ${YELLOW}Admin invite:${NC}"
  echo -e "  ${BLUE}$INVITE_URL${NC}"
  echo ""
  echo "  Open this URL to create your admin account."
else
  echo -e "  ${YELLOW}No invite URL generated.${NC} Run manually:"
  echo "  ssh $SSH_TARGET 'cd $REMOTE_DIR && docker compose exec server npx paperclipai auth bootstrap-ceo'"
fi
echo ""
echo "  After signing up, transfer company ownership from 'local-board'"
echo "  to your new user via the database if needed."
echo ""

# ── Cleanup remote temp files ────────────────────────────────────────────────
remote "rm -rf /tmp/paperclip-migrate /tmp/paperclip-bundle.tar.gz" 2>/dev/null || true
