'use strict';

/**
 * Swarm detail view.
 *
 * Renders a full-screen overlay into <div id="swarm-mount"> showing the whole
 * swarm: header (back button, workflow title, status pill, started/ended
 * times, agent stat chips), a filter input, and a responsive grid of agent
 * cards. Exported entry points:
 *
 *   openSwarm(workflow, { onBack, onAgentUpdate })  mount and animate in
 *   closeSwarm()                                    animate out and unmount
 *   updateSwarm(workflow)                           live refresh while open
 *
 * workflow shape (from js/store.js):
 *   { id, title, status, startedAt, endedAt, agents: Map }
 * Each agent in the Map is an object that may carry:
 *   { id, name, kind, status, task_brief, result_summary,
 *     startedAt, endedAt, durationS }
 * Field names are normalized defensively (snake_case and camelCase both work).
 */

const MOUNT_ID = 'swarm-mount';
const ENTER_MS = 320;
const STAGGER_CAP = 20;
const STAGGER_MS = 45;

/* deterministic kind colors, unknown kinds hash into this palette */
const KIND_PALETTE = ['#c084fc', '#f472b6', '#4ade80', '#facc15', '#67e8f9', '#fb923c', '#38bdf8', '#ff4b2e'];

let state = null;

/* ================= small helpers ================= */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function kindColor(kind) {
  let h = 0;
  const s = String(kind || 'agent');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return KIND_PALETTE[Math.abs(h) % KIND_PALETTE.length];
}

function kindLabel(kind) {
  return String(kind || 'agent').replace(/[-_]/g, ' ').trim() || 'agent';
}

/* normalize an agent's status to running | done | failed | interrupted */
function agentStatus(a) {
  const raw = String(a.status || '').toLowerCase();
  if (raw === 'done' || raw === 'completed' || raw === 'success') return 'done';
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'interrupted' || raw === 'killed' || raw === 'cancelled' || raw === 'canceled') return 'interrupted';
  if (raw === 'running' || raw === 'spawned' || raw === 'started' || raw === 'active') return 'running';
  if (a.endedAt != null || a.ended_at != null) return 'done';
  return 'running';
}

const SORT_RANK = { running: 0, failed: 1, interrupted: 2, done: 3 };

function agentFields(a) {
  const startedAt = a.startedAt != null ? a.startedAt : (a.started_at != null ? a.started_at : null);
  const endedAt = a.endedAt != null ? a.endedAt : (a.ended_at != null ? a.ended_at : null);
  const brief = a.task_brief != null ? a.task_brief : (a.taskBrief != null ? a.taskBrief : '');
  const summary = a.result_summary != null ? a.result_summary : (a.resultSummary != null ? a.resultSummary : '');
  return { startedAt, endedAt, brief, summary };
}

function agentDurationS(a) {
  if (a.durationS != null && Number(a.durationS) >= 0) return Number(a.durationS);
  if (a.duration_s != null && Number(a.duration_s) >= 0) return Number(a.duration_s);
  const { startedAt, endedAt } = agentFields(a);
  if (startedAt != null && endedAt != null) return Math.max(0, (endedAt - startedAt) / 1000);
  return null;
}

function fmtDuration(s) {
  if (s == null || !isFinite(s)) return '';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(ts) {
  if (ts == null) return '';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ================= sorting ================= */

function sortedAgents(workflow) {
  const agents = [];
  const map = workflow && workflow.agents instanceof Map ? workflow.agents : new Map();
  for (const [id, a] of map) {
    const agent = a && typeof a === 'object' ? a : {};
    agents.push({ id, agent });
  }
  agents.sort((x, y) => {
    const rx = SORT_RANK[agentStatus(x.agent)] ?? 3;
    const ry = SORT_RANK[agentStatus(y.agent)] ?? 3;
    if (rx !== ry) return rx - ry;
    const { startedAt: sx } = agentFields(x.agent);
    const { startedAt: sy } = agentFields(y.agent);
    return (sy || 0) - (sx || 0);
  });
  return agents;
}

/* ================= card DOM ================= */

function cardHTML(id, agent, index, stagger) {
  const st = agentStatus(agent);
  const { brief, summary } = agentFields(agent);
  const name = agent.name != null && String(agent.name) !== '' ? agent.name : id;
  const dur = fmtDuration(agentDurationS(agent));
  const kind = kindLabel(agent.kind);
  const delay = stagger ? Math.min(index, STAGGER_CAP - 1) * STAGGER_MS : 0;
  return (
    `<article class="agent-card st-${st} agent-enter" data-agent-id="${esc(id)}"` +
    (stagger ? ` style="animation-delay: ${delay}ms"` : '') + '>' +
    '<div class="agent-top">' +
    `<h3 class="agent-name">${esc(name)}</h3>` +
    `<span class="agent-kind"><span class="kind-dot" style="background: ${esc(kindColor(agent.kind))}"></span>${esc(kind)}</span>` +
    `<span class="agent-status st-${st}">${esc(st)}</span>` +
    '</div>' +
    (brief ? `<p class="agent-brief">${esc(brief)}</p>` : '') +
    (summary
      ? `<div class="agent-result"><div class="agent-result-label">result</div><p>${esc(summary)}</p></div>`
      : `<div class="agent-result agent-result-muted"><div class="agent-result-label">result</div><p>still running</p></div>`) +
    (dur ? `<div class="agent-duration">${esc(dur)}</div>` : '') +
    '</article>'
  );
}

function refreshCard(el, agent) {
  const st = agentStatus(agent);
  const { brief, summary } = agentFields(agent);
  const dur = fmtDuration(agentDurationS(agent));
  el.className = `agent-card st-${st}`;
  const statusEl = el.querySelector('.agent-status');
  if (statusEl) {
    statusEl.className = `agent-status st-${st}`;
    statusEl.textContent = st;
  }
  const briefEl = el.querySelector('.agent-brief');
  if (briefEl) {
    briefEl.textContent = brief;
    briefEl.style.display = brief ? '' : 'none';
  }
  const resultEl = el.querySelector('.agent-result');
  if (resultEl) {
    const label = resultEl.querySelector('.agent-result-label');
    const p = resultEl.querySelector('p');
    resultEl.classList.toggle('agent-result-muted', !summary);
    if (label) label.textContent = 'result';
    if (p) p.textContent = summary || 'still running';
  }
  const durEl = el.querySelector('.agent-duration');
  if (durEl) {
    durEl.textContent = dur;
    durEl.style.display = dur ? '' : 'none';
  }
}

/* ================= header ================= */

function headerChipsHTML(counts) {
  return (
    `<span class="swarm-chip">total ${counts.total}</span>` +
    `<span class="swarm-chip swarm-chip-running">running ${counts.running}</span>` +
    `<span class="swarm-chip swarm-chip-done">done ${counts.done}</span>` +
    (counts.failed ? `<span class="swarm-chip swarm-chip-failed">failed ${counts.failed}</span>` : '') +
    (counts.interrupted ? `<span class="swarm-chip swarm-chip-interrupted">interrupted ${counts.interrupted}</span>` : '')
  );
}

function headerTimesHTML(workflow) {
  return (
    `<span class="swarm-time">started ${esc(fmtTime(workflow.startedAt) || 'unknown')}</span>` +
    (workflow.endedAt
      ? `<span class="swarm-time">ended ${esc(fmtTime(workflow.endedAt))}</span>`
      : '<span class="swarm-time">still live</span>')
  );
}

function workflowStatusClass(status) {
  const s = String(status || 'running').toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'success') return 'done';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'interrupted' || s === 'cancelled' || s === 'canceled') return 'interrupted';
  return 'running';
}

function countAgents(agents) {
  const counts = { total: agents.length, running: 0, done: 0, failed: 0, interrupted: 0 };
  for (const { agent } of agents) {
    const st = agentStatus(agent);
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

function headerHTML(workflow, agents) {
  const counts = countAgents(agents);
  const wStatus = String(workflow.status || 'running').toLowerCase();
  return (
    '<div class="swarm-header">' +
    '<button class="swarm-back" type="button" aria-label="Back to swarms">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>' +
    '<span>back</span></button>' +
    '<div class="swarm-title-row">' +
    `<h2 class="swarm-title">${esc(workflow.title || workflow.id || 'swarm')}</h2>` +
    `<span class="agent-status swarm-status st-${workflowStatusClass(wStatus)}">${esc(wStatus)}</span>` +
    '</div>' +
    '<div class="swarm-meta">' +
    headerTimesHTML(workflow) +
    headerChipsHTML(counts) +
    '</div>' +
    '<input class="swarm-filter" type="search" placeholder="filter agents by name, kind, or text" aria-label="Filter agents">' +
    '</div>'
  );
}

function refreshHeader(workflow, agents) {
  if (!state) return;
  const { overlay } = state;
  const counts = countAgents(agents);
  const meta = overlay.querySelector('.swarm-meta');
  if (meta) meta.innerHTML = headerTimesHTML(workflow) + headerChipsHTML(counts);
  const pill = overlay.querySelector('.swarm-status');
  if (pill) {
    const wStatus = String(workflow.status || 'running').toLowerCase();
    pill.className = `agent-status swarm-status st-${workflowStatusClass(wStatus)}`;
    pill.textContent = wStatus;
  }
  const title = overlay.querySelector('.swarm-title');
  if (title) title.textContent = workflow.title || workflow.id || 'swarm';
}

/* ================= filter ================= */

function applyFilter(grid, query) {
  const q = String(query || '').trim().toLowerCase();
  for (const card of grid.querySelectorAll('.agent-card')) {
    if (!q) {
      card.style.display = '';
      continue;
    }
    const hay = card.textContent.toLowerCase();
    card.style.display = hay.includes(q) ? '' : 'none';
  }
}

/* ================= public API ================= */

export function openSwarm(workflow, opts = {}) {
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) throw new Error(`swarm.js: #${MOUNT_ID} not found in the document`);

  closeSwarm(true);

  const agents = sortedAgents(workflow);
  const overlay = document.createElement('div');
  overlay.className = 'swarm-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Swarm detail');
  overlay.innerHTML = headerHTML(workflow, agents) + '<div class="agent-grid"></div>';

  const grid = overlay.querySelector('.agent-grid');
  const frag = document.createDocumentFragment();
  agents.forEach(({ id, agent }, i) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = cardHTML(id, agent, i, true);
    frag.appendChild(tmp.firstElementChild);
  });
  grid.appendChild(frag);

  mount.appendChild(overlay);

  const filterInput = overlay.querySelector('.swarm-filter');
  const onInput = () => {
    state.filterQuery = filterInput.value;
    applyFilter(grid, filterInput.value);
  };
  filterInput.addEventListener('input', onInput);

  const doBack = () => {
    const onBack = state && state.opts.onBack;
    closeSwarm();
    if (typeof onBack === 'function') onBack();
  };
  overlay.querySelector('.swarm-back').addEventListener('click', doBack);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      doBack();
    }
  };
  document.addEventListener('keydown', onKey);

  document.body.classList.add('swarm-open');

  state = {
    workflow,
    opts,
    overlay,
    grid,
    filterInput,
    onKey,
    onInput,
    filterQuery: '',
    cardById: new Map(),
  };
  for (const card of grid.querySelectorAll('.agent-card')) {
    state.cardById.set(card.getAttribute('data-agent-id'), card);
  }
  agents.forEach(({ id, agent }) => {
    const card = state.cardById.get(String(id));
    if (card) card.__status = agentStatus(agent);
  });

  requestAnimationFrame(() => {
    if (state && state.overlay === overlay) overlay.classList.add('swarm-visible');
  });

  return overlay;
}

export function closeSwarm(immediate = false) {
  if (!state) return;
  const { overlay, onKey, filterInput, onInput } = state;
  state = null;
  document.removeEventListener('keydown', onKey);
  if (filterInput) filterInput.removeEventListener('input', onInput);
  document.body.classList.remove('swarm-open');
  if (immediate || !overlay.isConnected) {
    overlay.remove();
    return;
  }
  overlay.classList.add('swarm-exit');
  overlay.classList.remove('swarm-visible');
  setTimeout(() => overlay.remove(), ENTER_MS);
}

export function updateSwarm(workflow) {
  if (!state) return;
  state.workflow = workflow;
  const { grid, cardById, opts } = state;
  const agents = sortedAgents(workflow);
  const seen = new Set();

  refreshHeader(workflow, agents);

  for (const { id, agent } of agents) {
    seen.add(String(id));
    const existing = cardById.get(String(id));
    if (existing) {
      const before = existing.__status || agentStatus({});
      const after = agentStatus(agent);
      existing.__status = after;
      refreshCard(existing, agent);
      if (before !== after && typeof opts.onAgentUpdate === 'function') {
        opts.onAgentUpdate({ id, type: 'status', prevStatus: before, status: after }, workflow);
      }
      grid.appendChild(existing);
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHTML(id, agent, 0, false);
      const card = tmp.firstElementChild;
      card.__agent = agent;
      cardById.set(String(id), card);
      grid.appendChild(card);
      if (typeof opts.onAgentUpdate === 'function') {
        opts.onAgentUpdate({ id, type: 'added', status: agentStatus(agent) }, workflow);
      }
    }
  }

  for (const [id, card] of cardById) {
    if (!seen.has(id)) {
      cardById.delete(id);
      card.remove();
    }
  }

  applyFilter(grid, state.filterQuery);
}
