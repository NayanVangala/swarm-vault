# swarm-vault

Obsidian-style live visualization of the 45-agent research-topic arena swarm.

Static site, no build step. Open `index.html` (or serve the folder) — the app polls `swarm.json` every 5 seconds and renders agent statuses in an Obsidian-like vault UI: file tree, tabs, agent notes, and a force-directed graph view.

- `index.html` / `style.css` / `app.js` — the app
- `swarm.json` — live arena state (agents, edges, scores, report)
