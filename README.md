# agent-ops

Live agent-ops dashboard: a Moto-styled dark UI that shows whatever agents are running right now, across all sessions. When a workflow's agents all finish, it moves from the LIVE view into ARCHIVE tabs automatically. Clicking any agent opens a detail panel with what it was asked to do (`task_brief`) and what it did (`result_summary`).

Static site, no build step. The app polls `agent-ops/events.jsonl` from GitHub raw every 5 seconds and re-renders incrementally.

## Feeding the dashboard

GitHub is the event bus. Append one JSON line per event, then commit and push:

```bash
cd agent-ops
./log-event.sh '{"v":1,"type":"workflow_started","workflow_id":"my-run","title":"My run","kind":"chat-build","started_at":1720000000000,"source":"main-chat"}'
./log-event.sh '{"v":1,"type":"agent_spawned","workflow_id":"my-run","agent_id":"a1","name":"Researcher","kind":"research","task_brief":"What you asked it to do.","spawned_at":1720000001000}'
./log-event.sh '{"v":1,"type":"agent_done","workflow_id":"my-run","agent_id":"a1","status":"completed","ended_at":1720000060000,"duration_s":59,"result_summary":"What it actually did."}'
./log-event.sh '{"v":1,"type":"workflow_done","workflow_id":"my-run","ended_at":1720000061000,"summary":"One-line outcome."}'
```

`agent_done.status` is `completed` | `failed` | `interrupted`. The helper validates the JSON, appends, commits, and pushes.

The original 45-agent arena is seeded as the first archived workflow (`Arena 2026-10-12 - research topic showdown`); `seed.py` regenerates it from `swarm.json`.

## Files

- `index.html` / `style.css` / `app.js` — the app (Moto theme: monochrome + acid lime `#C9F73A`)
- `agent-ops/events.jsonl` — the append-only event log the site polls
- `agent-ops/log-event.sh` — one-command event emitter (append + commit + push)
- `agent-ops/seed.py` — regenerates the arena seed events
- `swarm.json` — original arena state, kept for reference

## Deploying

The Vercel project is **not** git-linked, so pushes do not auto-deploy. Redeploy directly with the Vercel connector CLI (`create_deployment`, no `teamId`), inlining file contents; see the project notes for the exact invocation. The single CLI argument has a ~128KB kernel limit: deploy `index.html`, `style.css`, `app.js` (comments stripped), `agent-ops/events.jsonl` (without the bulky `report_md`), and `agent-ops/log-event.sh`. The app polls the full `events.jsonl` from GitHub raw at runtime, so the trimmed deploy copy loses nothing.
