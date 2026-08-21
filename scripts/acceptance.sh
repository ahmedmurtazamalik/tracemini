#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
PORT_NUM=${TRACEMINI_ACCEPTANCE_PORT:-43117}
BASE="http://127.0.0.1:$PORT_NUM"
SERVER_PID=''
cleanup(){ if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi; rm -rf "$TMP"; }
trap cleanup EXIT
json(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[process.argv[1]]))" "$1"; }
api(){ curl -fsS -H 'content-type: application/json' "$@"; }
TRACEMINI_DB="$TMP/acceptance.db" PORT="$PORT_NUM" node "$ROOT/apps/server/dist/index.js" >"$TMP/server.log" 2>&1 & SERVER_PID=$!
for _ in $(seq 1 50); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break; sleep .1; done
A=$(api -X POST "$BASE/api/auth/register" -d '{"name":"Ada","email":"ada@example.test","password":"password123"}')
B=$(api -X POST "$BASE/api/auth/register" -d '{"name":"Bob","email":"bob@example.test","password":"password123"}')
AT=$(printf '%s' "$A"|json token); BT=$(printf '%s' "$B"|json token)
W=$(api -X POST "$BASE/api/workspaces" -H "authorization: Bearer $AT" -d '{"name":"Acceptance"}')
WID=$(printf '%s' "$W"|json id); CODE=$(printf '%s' "$W"|json inviteCode)
mkdir -p "$TMP/home-a" "$TMP/home-b" "$TMP/repos"; git init --bare "$TMP/remote.git" >/dev/null; git clone "$TMP/remote.git" "$TMP/repos/clone-a" >/dev/null 2>&1; git clone "$TMP/remote.git" "$TMP/repos/clone-b" >/dev/null 2>&1
for C in clone-a clone-b; do git -C "$TMP/repos/$C" config user.name "$C"; git -C "$TMP/repos/$C" config user.email "$C@example.test"; git -C "$TMP/repos/$C" remote set-url origin 'git@example.test:team/project.git'; done
CLI=(node "$ROOT/packages/cli/dist/index.js")
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$ROOT/packages/cli/dist/index.js" >"$TMP/bin/tracemini"
chmod +x "$TMP/bin/tracemini"
TRACEMINI_HOME="$TMP/home-a" "${CLI[@]}" login --server "$BASE" --token "$AT" --machine ada-box >/dev/null
TRACEMINI_HOME="$TMP/home-a" "${CLI[@]}" use-workspace "$WID" >/dev/null
TRACEMINI_HOME="$TMP/home-a" "${CLI[@]}" watch "$TMP/repos/clone-a" >/dev/null
TRACEMINI_HOME="$TMP/home-b" "${CLI[@]}" login --server "$BASE" --token "$BT" --machine bob-box >/dev/null
TRACEMINI_HOME="$TMP/home-b" "${CLI[@]}" join "$CODE" >/dev/null
TRACEMINI_HOME="$TMP/home-b" "${CLI[@]}" watch "$TMP/repos/clone-b" >/dev/null
printf 'acceptance\n' >"$TMP/repos/clone-a/work.txt"; git -C "$TMP/repos/clone-a" add work.txt
TRACEMINI_HOME="$TMP/home-a" PATH="$TMP/bin:$PATH" git -C "$TMP/repos/clone-a" commit -m 'Acceptance commit' >/dev/null
ACT=$(api "$BASE/api/workspaces/$WID/activity" -H "authorization: Bearer $AT"); test "$(printf '%s' "$ACT"|node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(x=>x.type==='commit').length))")" = 1
REPOS=$(api "$BASE/api/workspaces/$WID/repositories" -H "authorization: Bearer $AT"); test "$(printf '%s' "$REPOS"|node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].clone_count))")" = 2
TODAY=$(date -u +%F); JOB=$(api -X POST "$BASE/api/reports/jobs" -H "authorization: Bearer $AT" -d "{\"workspaceId\":\"$WID\",\"startDate\":\"$TODAY\",\"endDate\":\"$TODAY\",\"reporter\":\"codex\"}"); JID=$(printf '%s' "$JOB"|json id); AGENT=$(node -e "console.log(require(process.argv[1]).agentToken)" "$TMP/home-a/config.json")
api -X POST "$BASE/api/agents/jobs/$JID/claim" -H "authorization: Bearer $AGENT" >/dev/null
CTX=$(api "$BASE/api/agents/jobs/$JID/context" -H "authorization: Bearer $AGENT"); printf '%s' "$CTX"|grep -q 'Acceptance commit'
api -X POST "$BASE/api/agents/jobs/$JID/complete" -H "authorization: Bearer $AGENT" -d '{"markdown":"# Acceptance report\nVerified local Git context."}' >/dev/null
api "$BASE/api/reports/jobs/$JID" -H "authorization: Bearer $AT"|grep -q 'completed'
api "$BASE/api/workspaces/$WID/reports" -H "authorization: Bearer $BT"|grep -q 'Acceptance report'
echo 'TraceMini acceptance passed: two users, grouped clones, Git activity, and report job flow.'
