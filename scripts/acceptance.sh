#!/usr/bin/env bash
set -euo pipefail
unset TRACEMINI_HOME

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
PORT_NUM=${TRACEMINI_ACCEPTANCE_PORT:-43117}
BASE="http://127.0.0.1:$PORT_NUM"
SERVER_PID=''
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f "$TMP/server.log" ]; then
    printf '%s\n' '--- TraceMini acceptance server log ---' >&2
    node -e "process.stderr.write(require('fs').readFileSync(process.argv[1],'utf8'))" "$TMP/server.log"
  fi
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  return "$status"
}
trap cleanup EXIT
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[process.argv[1]]))" "$1"; }
api() { curl -fsS -H 'content-type: application/json' "$@"; }

NODE_ENV=test DATABASE_URL='pg-mem://isolated' PORT="$PORT_NUM" node "$ROOT/apps/server/dist/index.js" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break; sleep .1; done

A=$(api -X POST "$BASE/api/auth/register" -d '{"name":"Ada","email":"ada@example.test","password":"password123"}')
B=$(api -X POST "$BASE/api/auth/register" -d '{"name":"Bob","email":"bob@example.test","password":"password123"}')
AT=$(printf '%s' "$A" | json token)
BT=$(printf '%s' "$B" | json token)
BID=$(printf '%s' "$B" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).user.id))")
W=$(api -X POST "$BASE/api/workspaces" -H "authorization: Bearer $AT" -d '{"name":"Acceptance"}')
WID=$(printf '%s' "$W" | json id)
CODE=$(printf '%s' "$W" | json inviteCode)
api -X POST "$BASE/api/workspaces/join" -H "authorization: Bearer $BT" -d "{\"inviteCode\":\"$CODE\"}" >/dev/null
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/workspaces/$WID/invite/regenerate" -H "authorization: Bearer $BT")" = 403
api -X PATCH "$BASE/api/workspaces/$WID/members/$BID" -H "authorization: Bearer $AT" -d '{"role":"Manager"}' >/dev/null
api -X POST "$BASE/api/workspaces/$WID/invite/regenerate" -H "authorization: Bearer $BT" >/dev/null

mkdir -p "$TMP/home-a" "$TMP/home-b" "$TMP/repos/a-root" "$TMP/repos/b-root"
git init --bare "$TMP/remote.git" >/dev/null
git clone "$TMP/remote.git" "$TMP/repos/a-root/clone-a" >/dev/null 2>&1
git clone "$TMP/remote.git" "$TMP/repos/b-root/clone-b" >/dev/null 2>&1
for CLONE in "$TMP/repos/a-root/clone-a" "$TMP/repos/b-root/clone-b"; do
  git -C "$CLONE" config user.name "$(basename "$CLONE")"
  git -C "$CLONE" config user.email "$(basename "$CLONE")@example.test"
done

CLI=(node "$ROOT/packages/cli/dist/index.js")
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nif [ "${1:-}" = -p ]; then printf "22\\n"; else exec "%s" "$@"; fi\n' "$(command -v node)" >"$TMP/bin/node"
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$ROOT/packages/cli/dist/index.js" >"$TMP/bin/tracemini"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$HOME/systemctl.log"\n' >"$TMP/bin/systemctl"
chmod +x "$TMP/bin/node" "$TMP/bin/tracemini" "$TMP/bin/systemctl"
INSTALL_A=$(api -X POST "$BASE/api/agents/installations" -H "authorization: Bearer $AT" -d "{\"workspaceId\":$WID}")
INSTALL_B=$(api -X POST "$BASE/api/agents/installations" -H "authorization: Bearer $BT" -d "{\"workspaceId\":$WID}")
INSTALL_COMMAND_A=$(printf '%s' "$INSTALL_A" | json installCommand)
ITOKEN_A=$(printf '%s' "$INSTALL_A" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(decodeURIComponent(JSON.parse(s).installCommand.match(/\\/linux\\/([^']+)/)[1])))")
ITOKEN_B=$(printf '%s' "$INSTALL_B" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(decodeURIComponent(JSON.parse(s).installCommand.match(/\\/linux\\/([^']+)/)[1])))")
HOME="$TMP/home-a" PATH="$TMP/bin:$PATH" sh -c "$INSTALL_COMMAND_A" >/dev/null
test -x "$TMP/home-a/.local/bin/tracemini"
test -f "$TMP/home-a/.config/systemd/user/tracemini.service"
test -f "$TMP/home-a/.tracemini/config.json"
INSTALLED_WID=$(node -e "console.log(require(process.argv[1]).workspaceId || '')" "$TMP/home-a/.tracemini/config.json")
if [ "$INSTALLED_WID" != "$WID" ]; then echo "installed workspace mismatch: expected $WID, got ${INSTALLED_WID:-missing}" >&2; exit 1; fi
HOME="$TMP/home-a" PATH="$TMP/bin:$PATH" "$TMP/home-a/.local/bin/tracemini" status >/dev/null
AGENT_B=$(api -X POST "$BASE/api/agents/install/exchange" -d "{\"installToken\":\"$ITOKEN_B\",\"machineName\":\"bob-box\"}")
node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({serverUrl:process.argv[2],agentToken:JSON.parse(process.argv[3]).agentToken,agentId:JSON.parse(process.argv[3]).agentId,workspaceId:Number(process.argv[4]),watchedPaths:[],clones:[],reporter:'codex',pollMs:2000}))" "$TMP/home-b/config.json" "$BASE" "$AGENT_B" "$WID"
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/install/exchange" -H 'content-type: application/json' -d "{\"installToken\":\"$ITOKEN_A\",\"machineName\":\"replay\"}")" = 409
TRACEMINI_HOME="$TMP/home-a/.tracemini" "${CLI[@]}" watch "$TMP/repos/a-root" >/dev/null
TRACEMINI_HOME="$TMP/home-b" "${CLI[@]}" watch "$TMP/repos/b-root" >/dev/null

printf 'acceptance\n' >"$TMP/repos/a-root/clone-a/work.txt"
git -C "$TMP/repos/a-root/clone-a" add work.txt
TRACEMINI_HOME="$TMP/home-a/.tracemini" PATH="$TMP/bin:$PATH" git -C "$TMP/repos/a-root/clone-a" commit -m 'Acceptance commit' >/dev/null
TRACEMINI_HOME="$TMP/home-a/.tracemini" PATH="$TMP/bin:$PATH" git -C "$TMP/repos/a-root/clone-a" push origin HEAD:refs/heads/main >/dev/null
TRACEMINI_HOME="$TMP/home-a/.tracemini" TRACEMINI_PUSH_CONFIRM_DELAY_MS=0 "${CLI[@]}" once >/dev/null

git clone "$TMP/remote.git" "$TMP/repos/a-root/discovered-later" >/dev/null 2>&1
git -C "$TMP/repos/a-root/discovered-later" config user.name discovered
git -C "$TMP/repos/a-root/discovered-later" config user.email discovered@example.test
REFRESH=$(api -X POST "$BASE/api/workspaces/$WID/refresh" -H "authorization: Bearer $AT")
RID=$(printf '%s' "$REFRESH" | json id)
TRACEMINI_HOME="$TMP/home-a/.tracemini" "${CLI[@]}" once >/dev/null
TRACEMINI_HOME="$TMP/home-b" "${CLI[@]}" once >/dev/null
REFRESHES=$(api "$BASE/api/workspaces/$WID/refresh" -H "authorization: Bearer $AT")
REPOSITORIES=$(api "$BASE/api/workspaces/$WID/repositories?includeArchived=true" -H "authorization: Bearer $AT")
[[ "$REFRESHES" == *'"status":"completed"'* ]]
[[ "$REFRESHES" != *'"status":"queued"'* ]]
[[ "$REPOSITORIES" == *'"clone_count":3'* ]]

ACTIVITY=$(api "$BASE/api/workspaces/$WID/activity" -H "authorization: Bearer $AT")
[[ "$ACTIVITY" == *'Acceptance commit'* ]]
[[ "$ACTIVITY" == *'"confirmation":"confirmed"'* ]]
STATS=$(api "$BASE/api/workspaces/$WID/stats" -H "authorization: Bearer $AT")
[[ "$STATS" == *'"commits":1'* ]]
REPO_ID=$(api "$BASE/api/workspaces/$WID/repositories" -H "authorization: Bearer $AT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
REPO_ACTIVITY=$(api "$BASE/api/repositories/$REPO_ID/activity?workspaceId=$WID" -H "authorization: Bearer $AT")
USER_ACTIVITY=$(api "$BASE/api/users/$(printf '%s' "$A" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).user.id))")/activity?workspaceId=$WID" -H "authorization: Bearer $AT")
[[ "$REPO_ACTIVITY" == *'Acceptance commit'* ]]
[[ "$USER_ACTIVITY" == *'Acceptance commit'* ]]

TODAY=$(date -u +%F)
JOB=$(api -X POST "$BASE/api/reports/jobs" -H "authorization: Bearer $AT" -d "{\"workspaceId\":\"$WID\",\"startDate\":\"$TODAY\",\"endDate\":\"$TODAY\",\"reporter\":\"codex\"}")
JID=$(printf '%s' "$JOB" | json id)
AGENT=$(node -e "console.log(require(process.argv[1]).agentToken)" "$TMP/home-a/.tracemini/config.json")
api -X POST "$BASE/api/agents/jobs/$JID/claim" -H "authorization: Bearer $AGENT" >/dev/null
CONTEXT=$(api "$BASE/api/agents/jobs/$JID/context" -H "authorization: Bearer $AGENT")
[[ "$CONTEXT" == *'Acceptance commit'* ]]
api -X POST "$BASE/api/agents/jobs/$JID/complete" -H "authorization: Bearer $AGENT" -d '{"markdown":"# Acceptance report\n\n| Check | Result |\n|---|---|\n| Git context | ✅ |\n\n- [x] Verified"}' >/dev/null
REPORT_ID=$(api "$BASE/api/workspaces/$WID/reports" -H "authorization: Bearer $BT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
REPORT=$(api "$BASE/api/reports/$REPORT_ID" -H "authorization: Bearer $BT")
[[ "$REPORT" == *'Acceptance report'* ]]

echo "TraceMini acceptance passed: install exchange, Manager authorization, refresh discovery $RID, real hooks/push confirmation, stats, and Markdown report retrieval."
