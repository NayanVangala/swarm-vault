// js/store.js
// Data layer for the swarm-vault dashboard.
// Normalizes agent-ops events.jsonl into a store of workflows and agents.
// Framework-free ES module, node-testable. Pure logic only: no DOM, no fetch.
// Polling and rendering live in app.js and the other modules.

// Two event schemas exist in the wild:
//   schema A: { "type": "agent_spawned", ... }
//   schema B: { "event": "agent_spawned", ... }
// Both are normalized here via obj.type || obj.event.

const AGENT_DONE_STATUS = {
  completed: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
};

function eventType(obj) {
  return obj.type || obj.event || null;
}

function startTs(obj) {
  if (obj.started_at != null) return obj.started_at;
  if (obj.ts != null) return obj.ts;
  return null;
}

function endTs(obj) {
  if (obj.ended_at != null) return obj.ended_at;
  if (obj.ts != null) return obj.ts;
  return null;
}

// "onrecord-build" -> "Onrecord Build"
export function prettyTitle(id) {
  if (id == null) return '';
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function createStore() {
  return { workflows: new Map(), order: [], linesSeen: 0 };
}

function pushChanged(delta, id) {
  if (!delta.newWorkflows.includes(id) && !delta.changedWorkflows.includes(id)) {
    delta.changedWorkflows.push(id);
  }
}

// Fetch an existing workflow or create a bare one so agent events
// arriving out of order still have a home.
function getOrCreateWorkflow(store, delta, wfId) {
  let wf = store.workflows.get(wfId);
  if (!wf) {
    wf = {
      id: wfId,
      title: prettyTitle(wfId),
      kind: null,
      status: 'running',
      startedAt: null,
      endedAt: null,
      durationS: null,
      agents: new Map(),
    };
    store.workflows.set(wfId, wf);
    store.order.push(wfId);
    delta.newWorkflows.push(wfId);
  }
  return wf;
}

function handleWorkflowStarted(store, delta, obj) {
  const id = obj.workflow_id;
  if (!id) return;
  let wf = store.workflows.get(id);
  if (!wf) {
    wf = {
      id,
      title: obj.title || obj.name || prettyTitle(id),
      kind: obj.kind || null,
      status: 'running',
      startedAt: startTs(obj),
      endedAt: null,
      durationS: null,
      agents: new Map(),
    };
    store.workflows.set(id, wf);
    store.order.push(id);
    delta.newWorkflows.push(id);
  } else {
    wf.status = 'running';
    if (obj.title || obj.name) wf.title = obj.title || obj.name;
    if (obj.kind) wf.kind = obj.kind;
    const t = startTs(obj);
    if (t != null) wf.startedAt = t;
    pushChanged(delta, id);
  }
}

function handleWorkflowDone(store, delta, obj) {
  const id = obj.workflow_id;
  if (!id) return;
  const wf = getOrCreateWorkflow(store, delta, id);
  wf.status = 'done';
  const t = endTs(obj);
  if (t != null) wf.endedAt = t;
  if (obj.duration_s != null) wf.durationS = obj.duration_s;
  pushChanged(delta, id);
}

function handleAgentSpawned(store, delta, obj) {
  const wfId = obj.workflow_id;
  const id = obj.agent_id;
  if (!wfId || !id) return;
  const wf = getOrCreateWorkflow(store, delta, wfId);
  let agent = wf.agents.get(id);
  if (!agent) {
    agent = {
      id,
      name: obj.name || null,
      kind: obj.kind || null,
      status: 'running',
      taskBrief: obj.task_brief || obj.taskBrief || null,
      resultSummary: null,
      startedAt: startTs(obj),
      endedAt: null,
      durationS: null,
    };
    wf.agents.set(id, agent);
    delta.newAgents.push({ wfId, agentId: id });
  } else {
    if (obj.name) agent.name = obj.name;
    if (obj.kind) agent.kind = obj.kind;
    const brief = obj.task_brief || obj.taskBrief;
    if (brief) agent.taskBrief = brief;
    const t = startTs(obj);
    if (t != null) agent.startedAt = t;
  }
  pushChanged(delta, wfId);
}

function handleAgentDone(store, delta, obj) {
  const wfId = obj.workflow_id;
  const id = obj.agent_id;
  if (!wfId || !id) return;
  const wf = getOrCreateWorkflow(store, delta, wfId);
  let agent = wf.agents.get(id);
  if (!agent) {
    agent = {
      id,
      name: obj.name || null,
      kind: obj.kind || null,
      status: 'running',
      taskBrief: obj.task_brief || obj.taskBrief || null,
      resultSummary: null,
      startedAt: null,
      endedAt: null,
      durationS: null,
    };
    wf.agents.set(id, agent);
    delta.newAgents.push({ wfId, agentId: id });
  }
  agent.status = AGENT_DONE_STATUS[obj.status] || 'done';
  const summary = obj.result_summary || obj.resultSummary;
  if (summary) agent.resultSummary = summary;
  const t = endTs(obj);
  if (t != null) agent.endedAt = t;
  if (obj.duration_s != null) agent.durationS = obj.duration_s;
  pushChanged(delta, wfId);
}

// Aggregate agent counts for one workflow.
// Interrupted agents roll into "failed" since they never completed.
export function workflowStats(wf) {
  const stats = { total: 0, running: 0, done: 0, failed: 0 };
  if (!wf || !wf.agents) return stats;
  for (const agent of wf.agents.values()) {
    stats.total += 1;
    if (agent.status === 'running') stats.running += 1;
    else if (agent.status === 'done') stats.done += 1;
    else if (agent.status === 'failed' || agent.status === 'interrupted') stats.failed += 1;
  }
  return stats;
}

// Apply NEW lines only (tracked by index via store.linesSeen).
// textLines is an array of raw JSONL strings.
// Returns { newWorkflows, changedWorkflows, newAgents } for animation hooks.
export function applyEvents(store, textLines) {
  const delta = { newWorkflows: [], changedWorkflows: [], newAgents: [] };
  for (let i = store.linesSeen; i < textLines.length; i++) {
    const line = textLines[i];
    if (!line || !line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    switch (eventType(obj)) {
      case 'workflow_started':
        handleWorkflowStarted(store, delta, obj);
        break;
      case 'workflow_done':
        handleWorkflowDone(store, delta, obj);
        break;
      case 'agent_spawned':
        handleAgentSpawned(store, delta, obj);
        break;
      case 'agent_done':
        handleAgentDone(store, delta, obj);
        break;
      default:
        // Unknown or informational events (e.g. "note") are consumed silently.
        break;
    }
  }
  store.linesSeen = textLines.length;
  return delta;
}
