#!/usr/bin/env bash
# agent-ops/log-event.sh - append one JSON event line, commit, push.
# Usage: ./log-event.sh '<json>'
# Run from anywhere inside the swarm-vault repo.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 '<json event>'" >&2
  exit 1
fi

LINE="$1"
python3 -c "import json,sys; json.loads(sys.argv[1])" "$LINE" || {
  echo "log-event: invalid JSON, not appending" >&2
  exit 1
}

cd "$(dirname "$0")"
printf '%s\n' "$LINE" >> events.jsonl
git add events.jsonl
ETYPE=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('type','event'))" "$LINE")
git commit -qm "agent-ops: ${ETYPE}"
git push -q
echo "logged ${ETYPE} ($(wc -l < events.jsonl) events total) + pushed"
