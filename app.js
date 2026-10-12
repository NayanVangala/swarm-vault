'use strict';

/* ================= constants ================= */
const EVENTS_URL = 'https://raw.githubusercontent.com/NayanVangala/swarm-vault/main/agent-ops/events.jsonl';
const POLL_MS = 5000;
const PHASES = ['Propose', 'Cross-examine', 'Judge', 'Finals', 'Synthesize'];
const KIND_COLORS = {
  proposer: '#edeae0',
  attacker: '#ff4b2e',
  auditor: '#38bdf8',
  judge: '#ffb224',
  champion: '#2fe6a7',
  synthesizer: '#ff4d8d',
};
const FALLBACK_KINDS = ['#c084fc', '#f472b6', '#4ade80', '#facc15', '#67e8f9', '#fb923c'];
const KIND_ROLES = {
  proposer: 'Proposer',
  attacker: 'Cross-examiner, attack',
  auditor: 'Cross-examiner, feasibility audit',
  judge: 'Judge',
  champion: 'Champion',
  synthesizer: 'Synthesizer',
};
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
const CHEVRON = '<svg class="twisty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/* ================= pure event store (node-testable) ================= */
function createStore() {
  return { workflows: new Map(), order: [], linesSeen: 0, eventsSeen: 0 };
}
function kindColor(kind) {
  if (KIND_COLORS[kind]) return KIND_COLORS[kind];
  let h = 0;
  const s = String(kind || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return FALLBACK_KINDS[Math.abs(h) % FALLBACK_KINDS.length];
}
function kindRole(kind) {
  return KIND_ROLES[kind] || String(kind || 'agent').replace(/[-_]/g, ' ');
}
function getWorkflow(store, id, create) {
  let wf = store.workflows.get(id);
  if (!wf && create) {
    wf = {
      id, title: id, kind: 'workflow', startedAt: null, endedAt: null,
      summary: '', reportMd: '', winner: '', edges: [], status: 'live',
      agents: new Map(), _started: false,
    };
    store.workflows.set(id, wf);
    store.order.push(id);
  }
  return wf || null;
}
/* Applies one event. Defensive: ignores unknown versions/types, dedupes
   spawns, tolerates out-of-order agent_done. Returns workflow id or null. */
function applyEvent(store, e) {
  if (!e || typeof e !== 'object' || e.v !== 1 || typeof e.type !== 'string') return null;
  if (typeof e.workflow_id !== 'string' || !e.workflow_id) return null;
  const wf = getWorkflow(store, e.workflow_id, true);
  switch (e.type) {
    case 'workflow_started': {
      if (wf._started) return wf.id; /* duplicate: keep first */
      wf._started = true;
      wf.title = e.title || wf.id;
      wf.kind = e.kind || 'workflow';
      wf.startedAt = e.started_at || Date.now();
      if (Array.isArray(e.edges)) wf.edges = e.edges;
      wf.status = 'live';
      return wf.id;
    }
    case 'agent_spawned': {
      if (typeof e.agent_id !== 'string' || !e.agent_id) return null;
      let a = wf.agents.get(e.agent_id);
      if (a && a._placeholder) {
        /* done arrived before spawn: backfill identity, keep the outcome */
        a.name = e.name || a.name;
        a.kind = e.kind || a.kind;
        a.taskBrief = e.task_brief || a.taskBrief;
        a.phase = e.phase || a.phase;
        if (e.spawned_at) a.spawnedAt = e.spawned_at;
        a._placeholder = false;
        return wf.id;
      }
      if (a) return wf.id; /* duplicate spawn: keep first */
      wf.agents.set(e.agent_id, {
        id: e.agent_id,
        name: e.name || e.agent_id,
        kind: e.kind || 'agent',
        taskBrief: e.task_brief || '',
        phase: e.phase || '',
        spawnedAt: e.spawned_at || Date.now(),
        status: 'running',
        endedAt: null,
        durationS: null,
        resultSummary: '',
        score: null,
      });
      return wf.id;
    }
    case 'agent_done': {
      if (typeof e.agent_id !== 'string' || !e.agent_id) return null;
      let a = wf.agents.get(e.agent_id);
      if (!a) { /* out-of-order: done before spawn; placeholder keeps the record */
        a = {
          id: e.agent_id, name: e.agent_id, kind: 'agent', taskBrief: '',
          phase: '', spawnedAt: e.ended_at || Date.now(), status: 'completed',
          endedAt: null, durationS: null, resultSummary: '', score: null,
          _placeholder: true,
        };
        wf.agents.set(e.agent_id, a);
      }
      a.status = (e.status === 'failed' || e.status === 'interrupted') ? e.status : 'completed';
      a.endedAt = e.ended_at || a.endedAt;
      a.durationS = (typeof e.duration_s === 'number') ? e.duration_s : a.durationS;
      a.resultSummary = e.result_summary || a.resultSummary;
      if (e.score != null) a.score = e.score;
      return wf.id;
    }
    case 'workflow_done': {
      wf.status = 'done';
      wf.endedAt = e.ended_at || wf.endedAt;
      wf.summary = e.summary || wf.summary;
      if (typeof e.report_md === 'string') wf.reportMd = e.report_md;
      if (typeof e.winner === 'string') wf.winner = e.winner;
      return wf.id;
    }
    default:
      return null; /* unknown future type: ignore */
  }
}
function liveWorkflows(store) {
  return store.order.map(id => store.workflows.get(id)).filter(w => w && w.status !== 'done');
}
function archivedWorkflows(store) {
  return store.order.map(id => store.workflows.get(id)).filter(w => w && w.status === 'done').reverse();
}
function sortedAgents(wf) {
  return Array.from(wf.agents.values()).sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));
}
function countRunning(wf) {
  let n = 0;
  wf.agents.forEach(a => { if (a.status === 'running') n++; });
  return n;
}
function countDone(wf) {
  let n = 0;
  wf.agents.forEach(a => { if (a.status !== 'running') n++; });
  return n;
}

/* ================= shared helpers ================= */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtClock(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtDur(s) {
  if (s == null || isNaN(s)) return '--';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function statusPill(status) {
  const cls = status === 'completed' ? 'green' : status === 'failed' ? 'red'
    : status === 'running' ? '' : 'gray';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

/* ---- minimal markdown ---- */
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdToHtml(md) {
  const lines = String(md).split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      let buf = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf += lines[i] + '\n'; i++; }
      i++;
      html += `<pre><code>${esc(buf.replace(/\n$/, ''))}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*---+\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      let items = '';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items += `<li>${mdInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++;
      }
      html += `<ul>${items}</ul>`; continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      let items = '';
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items += `<li>${mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`; i++;
      }
      html += `<ol>${items}</ol>`; continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    let para = line; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
           !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^```/.test(lines[i])) {
      para += ' ' + lines[i]; i++;
    }
    html += `<p>${mdInline(para)}</p>`;
  }
  return html;
}

/* ==================================================================
   DOM application (browser only)
   ================================================================== */
if (typeof document !== 'undefined' && typeof window !== 'undefined') initApp();

function initApp() {
  const $ = (sel) => document.querySelector(sel);

  /* ---------- app state ---------- */
  const store = createStore();
  let view = 'live';                 /* 'live' | 'archive' */
  let activeArchiveWf = null;        /* workflow id selected in archive */
  let selected = null;               /* {workflowId, agentId} */
  let tabs = [];                     /* [{type:'agent'|'report', workflowId, id}] */
  let activeKey = null;              /* null => workflow view; else open tab */
  let treeFilter = '';
  const collapsedWf = new Set();
  let lastPollAt = 0;
  let pollOk = true;
  let booted = false;

  const graphs = new Map();          /* 'live:'+id | 'arch:'+id -> graph */
  let focusedGraph = null;
  const renderedLive = new Set();    /* workflow ids with a live section in DOM */
  let renderedArchWf = null;

  function selectedAgent() {
    if (!selected) return null;
    const wf = store.workflows.get(selected.workflowId);
    return wf ? wf.agents.get(selected.agentId) || null : null;
  }
  function contextWorkflow() {
    if (selected) {
      const wf = store.workflows.get(selected.workflowId);
      if (wf) return wf;
    }
    if (view === 'archive' && activeArchiveWf) {
      return store.workflows.get(activeArchiveWf) || null;
    }
    const live = liveWorkflows(store);
    return live[0] || null;
  }

  /* ================= graph factory ================= */
  function makeGraph(canvas, wfId) {
    const ctx = canvas.getContext('2d');
    const nodes = new Map();
    let edges = [];
    let cam = { x: 0, y: 0, k: 1 };
    let W = 0, H = 0, dpr = 1;
    let hoverId = null, selectedNodeId = null, dragNode = null, dragMoved = false;
    let panning = false, lastPtr = null;
    let fitted = false;

    function hashCode(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    }
    function seedPos(id, phase, idx, total) {
      const pi = PHASES.indexOf(phase);
      if (pi >= 0) {
        return {
          x: (pi - 2) * 300 + ((hashCode(id) % 90) - 45),
          y: (idx - (total - 1) / 2) * 92 + ((hashCode(id + 'y') % 50) - 25),
        };
      }
      const ang = (idx / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
      const r = 200 + (hashCode(id) % 120);
      return { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    }
    function sync(agents, edgePairs) {
      edges = edgePairs.slice();
      const deg = new Map();
      edges.forEach(([f, t]) => { deg.set(f, (deg.get(f) || 0) + 1); deg.set(t, (deg.get(t) || 0) + 1); });
      const byPhase = {};
      agents.forEach(a => { const p = a.phase || ''; (byPhase[p] = byPhase[p] || []).push(a); });
      agents.forEach(a => {
        const sibs = byPhase[a.phase || ''];
        const idx = sibs.indexOf(a);
        let n = nodes.get(a.id);
        if (!n) {
          const p = seedPos(a.id, a.phase, Math.max(0, idx), sibs.length);
          n = { id: a.id, x: p.x, y: p.y, vx: 0, vy: 0 };
          nodes.set(a.id, n);
        }
        n.agent = a;
        n.r = Math.min(17, 5.5 + (deg.get(a.id) || 0) * 1.05);
      });
      for (const id of Array.from(nodes.keys())) {
        if (!agents.some(a => a.id === id)) nodes.delete(id);
      }
      buildLegend();
      if (!fitted && agents.length) { fitted = true; fitView(); }
    }
    function buildLegend() {
      const seen = new Map();
      nodes.forEach(n => { if (n.agent && !seen.has(n.agent.kind)) seen.set(n.agent.kind, kindColor(n.agent.kind)); });
      const el = canvas.parentElement ? canvas.parentElement.querySelector('.wf-legend') : null;
      if (el) el.innerHTML = Array.from(seen.entries())
        .map(([k, c]) => `<div class="legend-row"><span class="legend-dot" style="background:${c}"></span>${esc(kindRole(k))}</div>`).join('');
    }
    function resize() {
      const wrap = canvas.parentElement;
      if (!wrap || wrap.clientWidth === 0) return;
      dpr = window.devicePixelRatio || 1;
      W = wrap.clientWidth; H = wrap.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    }
    function fitView() {
      resize();
      if (!W) return;
      cam = { x: W / 2, y: H / 2, k: Math.min(1, Math.min(W / 1600, H / 1150) * 1.6) };
      if (!(cam.k > 0)) cam.k = 0.6;
    }
    function resetLayout() {
      nodes.forEach(n => {
        const sibs = Array.from(nodes.values()).filter(m => (m.agent.phase || '') === (n.agent.phase || ''));
        const idx = sibs.findIndex(m => m.id === n.id);
        const p = seedPos(n.id, n.agent.phase, Math.max(0, idx), sibs.length);
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
      });
      fitView();
    }
    function zoomBy(f) { cam.k = Math.max(0.08, Math.min(3.2, cam.k * f)); }
    function toWorld(px, py) { return { x: (px - cam.x) / cam.k, y: (py - cam.y) / cam.k }; }
    function pick(px, py) {
      const w = toWorld(px, py);
      let best = null, bestD = 1e9;
      nodes.forEach(n => {
        const d = Math.hypot(n.x - w.x, n.y - w.y);
        if (d < n.r + 6 / cam.k && d < bestD) { best = n; bestD = d; }
      });
      return best;
    }
    function step() {
      const arr = Array.from(nodes.values());
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (i - j) || 1; dy = 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const f = Math.min(2600 / d2, 2.2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      for (const [f, t] of edges) {
        const a = nodes.get(f), b = nodes.get(t);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const rest = 118;
        const fmag = (d - rest) * 0.012;
        const fx = (dx / d) * fmag, fy = (dy / d) * fmag;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const n of arr) {
        n.vx += -n.x * 0.0016;
        n.vy += -n.y * 0.0016;
        if (dragNode && dragNode.id === n.id) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= 0.86; n.vy *= 0.86;
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > 9) { n.vx = n.vx / sp * 9; n.vy = n.vy / sp * 9; }
        n.x += n.vx; n.y += n.vy;
      }
    }
    function drawCheck(x, y, r) {
      ctx.save();
      ctx.strokeStyle = 'rgba(10,10,9,0.85)';
      ctx.lineWidth = Math.max(1.6, r * 0.22);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x - r * 0.42, y + r * 0.02);
      ctx.lineTo(x - r * 0.08, y + r * 0.36);
      ctx.lineTo(x + r * 0.48, y - r * 0.3);
      ctx.stroke();
      ctx.restore();
    }
    function draw(now) {
      if (!W) resize();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#070706';
      ctx.fillRect(0, 0, W, H);
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.k, cam.k);
      ctx.lineWidth = 1 / cam.k;
      for (const [f, t] of edges) {
        const a = nodes.get(f), b = nodes.get(t);
        if (!a || !b) continue;
        const settled = a.agent.status !== 'running' && b.agent.status !== 'running';
        ctx.strokeStyle = settled ? 'rgba(201,247,58,0.30)' : 'rgba(150,148,138,0.28)';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      nodes.forEach(n => {
        const a = n.agent;
        const color = kindColor(a.kind);
        const isHover = hoverId === n.id, isSel = selectedNodeId === n.id;
        const done = a.status !== 'running';
        ctx.save();
        if (done) ctx.globalAlpha = 0.62;
        if (a.status === 'running') {
          const pulse = 0.5 + 0.5 * Math.sin(now / 340);
          ctx.shadowColor = color;
          ctx.shadowBlur = 14 + pulse * 16;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 3.5 + pulse * 3, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.35 + pulse * 0.4;
          ctx.lineWidth = 1.6 / cam.k + 0.6;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        if (a.status === 'failed') {
          ctx.fillStyle = '#ff4b2e';
          ctx.shadowColor = '#ff4b2e'; ctx.shadowBlur = isHover ? 12 : 0;
          ctx.fill();
        } else if (a.status === 'interrupted') {
          ctx.fillStyle = 'rgba(10,10,9,0.9)';
          ctx.fill();
          ctx.strokeStyle = '#a09d92';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = isHover || isSel ? 14 : (a.status === 'running' ? 8 : 0);
          ctx.fill();
        }
        if (done && a.status === 'completed') drawCheck(n.x, n.y, n.r);
        if (isSel) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 4.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.3;
          ctx.shadowBlur = 0;
          ctx.stroke();
        }
        ctx.restore();
        if (cam.k >= 0.72 || isHover || isSel) {
          const label = a.name || a.id;
          const short = label.length > 34 ? label.slice(0, 33) + '…' : label;
          ctx.font = `${isHover || isSel ? 700 : 500} ${11.5 / Math.sqrt(cam.k)}px Archivo, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = isHover || isSel ? '#f0f0f0' : 'rgba(200,200,200,0.82)';
          ctx.shadowColor = 'rgba(0,0,0,0.9)';
          ctx.shadowBlur = 4;
          ctx.fillText(short, n.x, n.y + n.r + 15 / Math.sqrt(cam.k));
          ctx.shadowBlur = 0;
        }
      });
    }
    function isVisible() {
      return !!canvas.offsetParent && canvas.clientWidth > 0;
    }
    function ptrPos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    canvas.addEventListener('pointerdown', (e) => {
      focusedGraph = g;
      const p = ptrPos(e);
      lastPtr = p;
      dragMoved = false;
      const n = pick(p.x, p.y);
      if (n) { dragNode = n; }
      else { panning = true; canvas.classList.add('dragging'); }
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = ptrPos(e);
      if (dragNode) {
        const w = toWorld(p.x, p.y);
        dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
        dragMoved = true;
      } else if (panning && lastPtr) {
        cam.x += p.x - lastPtr.x;
        cam.y += p.y - lastPtr.y;
        dragMoved = true;
      } else {
        const n = pick(p.x, p.y);
        hoverId = n ? n.id : null;
        canvas.classList.toggle('node-hover', !!n);
      }
      lastPtr = p;
    });
    canvas.addEventListener('pointerup', () => {
      const wasNode = dragNode;
      const moved = dragMoved;
      dragNode = null; panning = false;
      canvas.classList.remove('dragging');
      if (wasNode && !moved) selectAgent(wfId, wasNode.id, false);
    });
    canvas.addEventListener('dblclick', (e) => {
      const p = ptrPos(e);
      const n = pick(p.x, p.y);
      if (n) { selectAgent(wfId, n.id, false); openAgentNote(wfId, n.id); }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = ptrPos(e);
      const before = toWorld(p.x, p.y);
      zoomBy(e.deltaY < 0 ? 1.09 : 0.92);
      const after = toWorld(p.x, p.y);
      cam.x += (after.x - before.x) * cam.k;
      cam.y += (after.y - before.y) * cam.k;
    }, { passive: false });
    window.addEventListener('resize', resize);

    const g = {
      sync, resize, fitView, resetLayout, zoomBy, isVisible,
      setSelected(id) { selectedNodeId = id; },
      tick(now) { step(); draw(now); },
    };
    return g;
  }
  function ensureGraph(key, wfId, canvas) {
    let g = graphs.get(key);
    if (!g) {
      g = makeGraph(canvas, wfId);
      graphs.set(key, g);
      if (!focusedGraph) focusedGraph = g;
    }
    return g;
  }
  (function loop(now) {
    graphs.forEach(g => { if (g.isVisible()) g.tick(now); });
    requestAnimationFrame(loop);
  })(0);

  /* ---------- graph data per workflow ---------- */
  function workflowEdges(wf) {
    if (wf.edges && wf.edges.length) {
      return wf.edges.filter(([f, t]) => wf.agents.has(f) && wf.agents.has(t));
    }
    /* live workflows: chain by spawn order so the swarm visibly grows */
    const agents = sortedAgents(wf);
    const pairs = [];
    for (let i = 1; i < agents.length; i++) pairs.push([agents[i - 1].id, agents[i].id]);
    return pairs;
  }
  function syncWorkflowGraph(wf, key) {
    const g = graphs.get(key);
    if (!g) return;
    g.sync(sortedAgents(wf), workflowEdges(wf));
    const sel = (selected && selected.workflowId === wf.id) ? selected.agentId : null;
    g.setSelected(sel);
  }

  /* ================= tree ================= */
  function renderTree() {
    const tree = $('#file-tree');
    let html = '';
    const q = treeFilter.trim().toLowerCase();
    const agentRow = (wf, a) =>
      `<div class="tree-file ${selected && selected.agentId === a.id && selected.workflowId === wf.id ? 'selected' : ''}" data-wf="${esc(wf.id)}" data-agent="${esc(a.id)}">
        ${FILE_ICON}
        <span class="tree-file-label">${esc(a.name)}</span>
        <span class="status-dot dot-${esc(a.status)}"></span></div>`;
    const wfBlock = (wf, live) => {
      const agents = sortedAgents(wf).filter(a =>
        !q || a.name.toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q) || kindRole(a.kind).toLowerCase().includes(q));
      if (q && agents.length === 0) return '';
      const collapsed = collapsedWf.has(wf.id) && !q;
      const running = countRunning(wf);
      return `<div class="tree-folder ${collapsed ? 'collapsed' : ''}">
        <div class="tree-folder-header" data-toggle-wf="${esc(wf.id)}">${CHEVRON}
          ${live ? '<span class="live-dot sm"></span>' : ''}
          <span class="folder-name">${esc(wf.title)}</span>
          <span class="folder-count">${live && running ? running + ' live' : agents.length}</span></div>
        <div class="tree-children">${agents.map(a => agentRow(wf, a)).join('')}</div>
      </div>`;
    };
    const live = liveWorkflows(store), arch = archivedWorkflows(store);
    if (live.length) {
      html += '<div class="tree-section-label">Live</div>' + live.map(w => wfBlock(w, true)).join('');
    }
    if (arch.length) {
      html += '<div class="tree-section-label">Archive</div>' + arch.map(w => wfBlock(w, false)).join('');
    }
    if (!html) html = '<div class="standings-empty">No workflows yet.</div>';
    tree.innerHTML = html;
    tree.querySelectorAll('[data-toggle-wf]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-toggle-wf');
        if (collapsedWf.has(id)) collapsedWf.delete(id); else collapsedWf.add(id);
        renderTree();
      });
    });
    tree.querySelectorAll('[data-agent]').forEach(el => {
      el.addEventListener('click', () => selectAgent(el.getAttribute('data-wf'), el.getAttribute('data-agent'), true));
      el.addEventListener('dblclick', () => openAgentNote(el.getAttribute('data-wf'), el.getAttribute('data-agent')));
    });
  }

  /* ================= live view ================= */
  function wfHeaderHtml(wf, live) {
    const running = countRunning(wf), done = countDone(wf), total = wf.agents.size;
    const wrapping = live && running === 0 && total > 0;
    return `${live ? '<span class="live-dot"></span>' : '<span class="archived-dot"></span>'}
      <h2 class="wf-title">${esc(wf.title)}</h2>
      <span class="chip">${esc(wf.kind)}</span>
      <span class="wf-counts"><b>${running}</b> running · <b>${done}</b> done</span>
      ${wrapping ? '<span class="chip wrapping">wrapping up</span>' : ''}
      ${!live && wf.endedAt ? `<span class="wf-ended">${esc(fmtTime(wf.endedAt))}</span>` : ''}`;
  }
  function renderLiveView() {
    const list = $('#live-list');
    const live = liveWorkflows(store);
    const liveIds = new Set(live.map(w => w.id));
    /* remove sections for workflows that left live */
    for (const id of Array.from(renderedLive)) {
      if (!liveIds.has(id)) {
        const sec = list.querySelector(`[data-wf-section="${CSS.escape(id)}"]`);
        if (sec) sec.remove();
        graphs.delete('live:' + id);
        renderedLive.delete(id);
      }
    }
    if (!live.length) {
      list.innerHTML = `<div class="empty-state">
        <div class="empty-kicker">Agent ops</div>
        <div class="empty-title">NO AGENTS<br>RUNNING</div>
        <p class="empty-sub">Spawn a subagent in any chat and it shows up here, live.<br>Finished workflows move to the archive automatically.</p>
      </div>`;
      return;
    }
    if (list.querySelector('.empty-state')) list.innerHTML = '';
    for (const wf of live) {
      let sec = list.querySelector(`[data-wf-section="${CSS.escape(wf.id)}"]`);
      if (!sec) {
        sec = document.createElement('section');
        sec.className = 'wf-section';
        sec.setAttribute('data-wf-section', wf.id);
        sec.innerHTML = `<header class="wf-header"></header>
          <div class="wf-canvas-wrap"><canvas class="wf-canvas"></canvas>
            <div class="wf-legend"></div>
            <div class="wf-hint">Drag to pan · Scroll to zoom · Click a node to inspect · Double-click to open its note</div>
          </div>`;
        list.appendChild(sec);
        const canvas = sec.querySelector('canvas');
        ensureGraph('live:' + wf.id, wf.id, canvas);
        renderedLive.add(wf.id);
      }
      sec.querySelector('.wf-header').innerHTML = wfHeaderHtml(wf, true);
      syncWorkflowGraph(wf, 'live:' + wf.id);
    }
  }

  /* ================= archive view ================= */
  function renderArchiveView() {
    const arch = archivedWorkflows(store);
    const tabsEl = $('#archive-tabs');
    const body = $('#archive-body');
    if (activeArchiveWf && !store.workflows.get(activeArchiveWf)) activeArchiveWf = null;
    if (!activeArchiveWf && arch.length) activeArchiveWf = arch[0].id;
    tabsEl.innerHTML = arch.map(w =>
      `<button class="archive-tab ${w.id === activeArchiveWf ? 'active' : ''}" data-arch="${esc(w.id)}">
        ${esc(wfShortTitle(w))}<span class="archive-count">${w.agents.size}</span>
      </button>`).join('') || '<div class="standings-empty">No archived workflows yet.</div>';
    tabsEl.querySelectorAll('[data-arch]').forEach(el => {
      el.addEventListener('click', () => {
        activeArchiveWf = el.getAttribute('data-arch');
        renderedArchWf = null; /* force rebuild for the newly selected workflow */
        renderArchiveView();
      });
    });
    const wf = activeArchiveWf ? store.workflows.get(activeArchiveWf) : null;
    if (!wf) { body.innerHTML = ''; renderedArchWf = null; return; }
    if (renderedArchWf !== wf.id) {
      renderedArchWf = wf.id;
      const running = countRunning(wf), done = countDone(wf);
      body.innerHTML = `<div class="archive-summary">
          <div class="archive-kicker">Archived workflow · ${esc(wf.kind)}</div>
          <h2 class="wf-title">${esc(wf.title)}</h2>
          <div class="archive-meta">
            <span class="chip">done</span>
            <span>${esc(fmtTime(wf.startedAt))} → ${esc(fmtTime(wf.endedAt))}</span>
            <span><b>${done}</b> agents finished${running ? ` · <b>${running}</b> still running` : ''}</span>
            ${wf.reportMd ? `<button class="report-open" data-report="${esc(wf.id)}">Open full report</button>` : ''}
          </div>
          ${wf.winner ? `<div class="winner-banner">Winner<br><b>${esc(wf.winner)}</b></div>` : ''}
          ${wf.summary ? `<p class="archive-summary-text">${esc(wf.summary)}</p>` : ''}
        </div>
        <section class="wf-section">
          <header class="wf-header">${wfHeaderHtml(wf, false)}</header>
          <div class="wf-canvas-wrap tall"><canvas class="wf-canvas"></canvas>
            <div class="wf-legend"></div>
            <div class="wf-hint">Drag to pan · Scroll to zoom · Click a node to inspect · Double-click to open its note</div>
          </div>
        </section>`;
      const canvas = body.querySelector('canvas');
      ensureGraph('arch:' + wf.id, wf.id, canvas);
      body.querySelectorAll('[data-report]').forEach(el => {
        el.addEventListener('click', () => openReport(el.getAttribute('data-report')));
      });
    } else {
      const header = body.querySelector('.wf-header');
      if (header) header.innerHTML = wfHeaderHtml(wf, false);
    }
    syncWorkflowGraph(wf, 'arch:' + wf.id);
  }
  function wfShortTitle(wf) {
    const t = wf.title || wf.id;
    return t.length > 30 ? t.slice(0, 29) + '…' : t;
  }

  /* ================= selection + tabs ================= */
  function selectAgent(wfId, agentId, fromTree) {
    const wf = store.workflows.get(wfId);
    if (!wf || !wf.agents.get(agentId)) return;
    selected = { workflowId: wfId, agentId };
    if (wf.status === 'done') { view = 'archive'; activeArchiveWf = wfId; }
    else { view = 'live'; }
    activeKey = null;
    renderAll();
  }
  function tabKey(t) {
    return t.type === 'report' ? 'report:' + t.workflowId : 'agent:' + t.workflowId + ':' + t.id;
  }
  function openAgentNote(wfId, agentId) {
    const wf = store.workflows.get(wfId);
    if (!wf || !wf.agents.get(agentId)) return;
    selected = { workflowId: wfId, agentId };
    if (!tabs.some(t => t.type === 'agent' && t.workflowId === wfId && t.id === agentId)) {
      tabs.push({ type: 'agent', workflowId: wfId, id: agentId });
    }
    activeKey = 'agent:' + wfId + ':' + agentId;
    renderAll();
  }
  function openReport(wfId) {
    const wf = store.workflows.get(wfId);
    if (!wf || !wf.reportMd) return;
    if (!tabs.some(t => t.type === 'report' && t.workflowId === wfId)) {
      tabs.push({ type: 'report', workflowId: wfId });
    }
    activeKey = 'report:' + wfId;
    renderAll();
  }
  function renderTabs() {
    const wrap = $('#tabs');
    wrap.innerHTML = tabs.map(t => {
      const key = tabKey(t);
      const wf = store.workflows.get(t.workflowId);
      const a = t.type === 'agent' && wf ? wf.agents.get(t.id) : null;
      const label = t.type === 'report'
        ? 'Report · ' + wfShortTitle(wf || { title: t.workflowId })
        : (a ? a.name : t.id);
      return `<div class="tab ${key === activeKey ? 'active' : ''}" data-tab="${esc(key)}">
        ${a ? `<span class="status-dot dot-${esc(a.status)}"></span>` : ''}
        <span class="tab-label">${esc(label)}</span>
        <span class="tab-close" data-close="${esc(key)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></span>
      </div>`;
    }).join('');
    wrap.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) return;
        activeKey = el.getAttribute('data-tab');
        const t = tabs.find(x => tabKey(x) === activeKey);
        if (t && t.type === 'agent') selected = { workflowId: t.workflowId, agentId: t.id };
        renderAll();
      });
    });
    wrap.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = el.getAttribute('data-close');
        const idx = tabs.findIndex(t => tabKey(t) === key);
        if (idx >= 0) tabs.splice(idx, 1);
        if (activeKey === key) activeKey = null;
        renderAll();
      });
    });
    document.querySelectorAll('#view-switch button').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-view') === view && activeKey === null);
    });
    $('#graph-controls').classList.toggle('visible', true);
    updatePanes();
  }
  function updatePanes() {
    const showNote = activeKey !== null;
    $('#live-view').hidden = showNote || view !== 'live';
    $('#archive-view').hidden = showNote || view !== 'archive';
    $('#note-pane').hidden = !showNote;
    if (!showNote) {
      graphs.forEach(g => g.resize());
      const g = focusedGraph && focusedGraph.isVisible() ? focusedGraph
        : Array.from(graphs.values()).find(x => x.isVisible());
      if (g) focusedGraph = g;
    }
  }
  function renderNote() {
    const t = tabs.find(x => tabKey(x) === activeKey);
    const pane = $('#note-content');
    if (!t) { pane.innerHTML = ''; return; }
    const wf = store.workflows.get(t.workflowId);
    if (!wf) { pane.innerHTML = '<h1>Not found</h1>'; return; }
    if (t.type === 'report') {
      pane.innerHTML = `<h1>${esc(wf.title)}</h1><div class="note-subtitle">Final report · archived ${esc(fmtTime(wf.endedAt))}</div>` + mdToHtml(wf.reportMd);
    } else {
      const a = wf.agents.get(t.id);
      if (!a) { pane.innerHTML = '<h1>Not found</h1>'; return; }
      pane.innerHTML = agentNoteHtml(wf, a);
    }
    $('#note-pane').scrollTop = 0;
  }
  function agentNoteHtml(wf, a) {
    return `
      <div class="note-kicker">Agent · ${esc(wf.title)}</div>
      <h1>${esc(a.name)}</h1>
      <div class="note-subtitle">${esc(kindRole(a.kind))} · ${esc(a.status)}</div>
      <div class="properties">
        <div class="prop-row"><span class="prop-key">kind</span><span class="prop-val"><span class="kind-badge" style="--kc:${kindColor(a.kind)}">${esc(kindRole(a.kind))}</span></span></div>
        <div class="prop-row"><span class="prop-key">status</span><span class="prop-val">${statusPill(a.status)}</span></div>
        <div class="prop-row"><span class="prop-key">spawned</span><span class="prop-val">${esc(fmtTime(a.spawnedAt))}</span></div>
        <div class="prop-row"><span class="prop-key">ended</span><span class="prop-val">${a.endedAt ? esc(fmtTime(a.endedAt)) : 'still running'}</span></div>
        <div class="prop-row"><span class="prop-key">duration</span><span class="prop-val">${a.durationS != null ? esc(fmtDur(a.durationS)) : (a.status === 'running' ? '<span class="dur-live" data-spawn="' + a.spawnedAt + '">' + fmtClock(Date.now() - a.spawnedAt) + '</span>' : '--')}</span></div>
        ${a.score != null ? `<div class="prop-row"><span class="prop-key">score</span><span class="prop-val">${Number(a.score).toFixed(1)} / 10</span></div>` : ''}
        <div class="prop-row"><span class="prop-key">id</span><span class="prop-val" style="font-family:var(--font-mono);font-size:12px">${esc(a.id)}</span></div>
      </div>
      <h2>What it was asked to do</h2>
      <p>${a.taskBrief ? esc(a.taskBrief) : '<span class="output-empty">No brief recorded.</span>'}</p>
      <h2>What it did</h2>
      <p>${a.status === 'running'
        ? '<span class="output-empty">Still running. The result lands here when it finishes.</span>'
        : (a.resultSummary ? esc(a.resultSummary) : '<span class="output-empty">No result recorded.</span>')}</p>`;
  }

  /* ================= right sidebar ================= */
  function renderDetail() {
    const box = $('#agent-detail');
    const wf = selected ? store.workflows.get(selected.workflowId) : null;
    const a = wf ? wf.agents.get(selected.agentId) : null;
    if (!a) {
      box.innerHTML = '<div class="detail-empty">Select an agent in the graph or file tree to inspect it.</div>';
      return;
    }
    box.innerHTML = `
      <div class="agent-note-card">
        <div class="detail-kicker">Agent · ${esc(wfShortTitle(wf))}</div>
        <div class="detail-title">${esc(a.name)}</div>
        <div class="detail-badges">
          <span class="kind-badge" style="--kc:${kindColor(a.kind)}">${esc(kindRole(a.kind))}</span>
          ${statusPill(a.status)}
        </div>
        <div class="detail-block">
          <div class="detail-sub">What it was asked to do</div>
          <p>${a.taskBrief ? esc(a.taskBrief) : '<span class="output-empty">No brief recorded.</span>'}</p>
        </div>
        <div class="detail-block">
          <div class="detail-sub">What it did</div>
          <p>${a.status === 'running'
            ? '<span class="output-empty">Still running. The result lands here when it finishes.</span>'
            : (a.resultSummary ? esc(a.resultSummary) : '<span class="output-empty">No result recorded.</span>')}</p>
        </div>
        <div class="detail-row"><span class="dk">workflow</span><span class="dv">${esc(wfShortTitle(wf))}</span></div>
        <div class="detail-row"><span class="dk">spawned</span><span class="dv">${esc(fmtTime(a.spawnedAt))}</span></div>
        <div class="detail-row"><span class="dk">ended</span><span class="dv">${a.endedAt ? esc(fmtTime(a.endedAt)) : '—'}</span></div>
        <div class="detail-row"><span class="dk">duration</span><span class="dv">${a.durationS != null ? esc(fmtDur(a.durationS)) : (a.status === 'running' ? '<span class="dur-live" data-spawn="' + a.spawnedAt + '">' + fmtClock(Date.now() - a.spawnedAt) + '</span>' : '—')}</span></div>
        ${a.score != null ? `<div class="detail-row"><span class="dk">score</span><span class="dv">${Number(a.score).toFixed(1)} / 10</span></div>` : ''}
        <div class="detail-row"><span class="dk">id</span><span class="dv" style="font-family:var(--font-mono);font-size:11px">${esc(a.id)}</span></div>
      </div>`;
  }
  function renderRunStats() {
    const box = $('#run-stats');
    const live = liveWorkflows(store), arch = archivedWorkflows(store);
    let running = 0, done = 0, total = 0;
    store.workflows.forEach(wf => {
      running += countRunning(wf); done += countDone(wf); total += wf.agents.size;
    });
    box.innerHTML = `
      <div class="progress-track"><div class="progress-fill" style="width:${total ? (done / total) * 100 : 0}%"></div></div>
      <div class="stat-row"><span class="sk">Live workflows</span><span class="sv">${live.length}</span></div>
      <div class="stat-row"><span class="sk">Agents running</span><span class="sv">${running}</span></div>
      <div class="stat-row"><span class="sk">Agents finished</span><span class="sv">${done} / ${total}</span></div>
      <div class="stat-row"><span class="sk">Archived</span><span class="sv">${arch.length}</span></div>
      <div class="stat-row"><span class="sk">Events</span><span class="sv">${store.eventsSeen}</span></div>
      <div class="stat-row"><span class="sk">Feed</span><span class="sv">${pollOk ? 'live' : 'offline'}</span></div>`;
  }
  function renderWorkflowInfo() {
    const box = $('#workflow-info');
    const wf = contextWorkflow();
    if (!wf) { box.innerHTML = '<div class="detail-empty">Nothing selected.</div>'; return; }
    box.innerHTML = `
      <div class="detail-title" style="font-size:15px">${esc(wfShortTitle(wf))}</div>
      <div class="detail-row"><span class="dk">kind</span><span class="dv">${esc(wf.kind)}</span></div>
      <div class="detail-row"><span class="dk">state</span><span class="dv">${wf.status === 'done' ? 'archived' : 'live'}</span></div>
      <div class="detail-row"><span class="dk">agents</span><span class="dv">${countRunning(wf)} running · ${countDone(wf)} done</span></div>
      <div class="detail-row"><span class="dk">started</span><span class="dv">${esc(fmtTime(wf.startedAt))}</span></div>
      ${wf.summary ? `<p class="wf-info-summary">${esc(wf.summary.slice(0, 220))}${wf.summary.length > 220 ? '…' : ''}</p>` : ''}`;
  }
  function renderStatus() {
    let running = 0;
    const live = liveWorkflows(store);
    live.forEach(wf => { running += countRunning(wf); });
    let text;
    if (!pollOk) text = 'Offline — retrying…';
    else if (running > 0) text = `LIVE · ${running} agent${running === 1 ? '' : 's'} running`;
    else if (live.length) text = 'Live · wrapping up';
    else text = 'No agents running · archive ready';
    $('#status-text').textContent = text;
    $('#status-sync-icon').classList.toggle('live', pollOk && running > 0);
    $('#status-sync-icon').classList.toggle('offline', !pollOk);
    let notes = 0;
    store.workflows.forEach(wf => { notes += wf.agents.size; });
    $('#status-notes').textContent = notes + ' notes';
    const ago = lastPollAt ? Math.max(0, Math.round((Date.now() - lastPollAt) / 1000)) : null;
    $('#status-poll').textContent = pollOk
      ? `${store.eventsSeen} events · polled ${ago === 0 ? 'just now' : ago + 's ago'}`
      : 'feed unreachable';
  }

  /* ================= quick switcher ================= */
  const switcher = { items: [], activeIdx: 0 };
  function fuzzyScore(needle, hay) {
    needle = needle.toLowerCase(); hay = hay.toLowerCase();
    let ni = 0, score = 0, last = -1;
    for (let hi = 0; hi < hay.length && ni < needle.length; hi++) {
      if (hay[hi] === needle[ni]) { score += last === hi - 1 ? 3 : 1; last = hi; ni++; }
    }
    return ni === needle.length ? score : -1;
  }
  function openSwitcher() {
    $('#switcher-overlay').hidden = false;
    const input = $('#switcher-input');
    input.value = '';
    updateSwitcher('');
    setTimeout(() => input.focus(), 0);
  }
  function closeSwitcher() { $('#switcher-overlay').hidden = true; }
  function updateSwitcher(q) {
    const pool = [];
    store.workflows.forEach(wf => {
      wf.agents.forEach(a => pool.push({ wf, a, text: `${a.name} ${a.id} ${kindRole(a.kind)} ${wf.title}` }));
    });
    let scored = pool.map(p => ({ ...p, s: q ? fuzzyScore(q, p.text) : 1 })).filter(p => p.s >= 0);
    scored.sort((x, y) => y.s - x.s);
    switcher.items = scored.slice(0, 12);
    switcher.activeIdx = 0;
    const list = $('#switcher-list');
    list.innerHTML = switcher.items.length
      ? switcher.items.map((p, i) => `<div class="switcher-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
          <span class="status-dot dot-${esc(p.a.status)}"></span>
          <span>${esc(p.a.name)}</span>
          <span class="sw-phase">${esc(wfShortTitle(p.wf))}</span></div>`).join('')
      : '<div class="switcher-empty">No matching agents</div>';
    list.querySelectorAll('.switcher-item').forEach(el => {
      el.addEventListener('click', () => {
        const p = switcher.items[Number(el.getAttribute('data-idx'))];
        if (p) { closeSwitcher(); selectAgent(p.wf.id, p.a.id, false); openAgentNote(p.wf.id, p.a.id); }
      });
      el.addEventListener('mousemove', () => {
        switcher.activeIdx = Number(el.getAttribute('data-idx'));
        paintSwitcherActive();
      });
    });
  }
  function paintSwitcherActive() {
    document.querySelectorAll('.switcher-item').forEach((el, i) => {
      el.classList.toggle('active', i === switcher.activeIdx);
    });
  }
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'o')) {
      e.preventDefault();
      $('#switcher-overlay').hidden ? openSwitcher() : closeSwitcher();
      return;
    }
    if ($('#switcher-overlay').hidden) return;
    if (e.key === 'Escape') closeSwitcher();
    else if (e.key === 'ArrowDown') { e.preventDefault(); switcher.activeIdx = Math.min(switcher.items.length - 1, switcher.activeIdx + 1); paintSwitcherActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); switcher.activeIdx = Math.max(0, switcher.activeIdx - 1); paintSwitcherActive(); }
    else if (e.key === 'Enter') {
      const p = switcher.items[switcher.activeIdx];
      if (p) { closeSwitcher(); selectAgent(p.wf.id, p.a.id, false); openAgentNote(p.wf.id, p.a.id); }
    }
  });
  $('#switcher-input').addEventListener('input', (e) => updateSwitcher(e.target.value));
  $('#switcher-overlay').addEventListener('click', (e) => { if (e.target.id === 'switcher-overlay') closeSwitcher(); });

  /* ================= render all ================= */
  function renderAll() {
    if (selected) {
      const wf = store.workflows.get(selected.workflowId);
      if (!wf || !wf.agents.get(selected.agentId)) selected = null;
    }
    const arch = archivedWorkflows(store);
    if (arch.length && (!activeArchiveWf || !store.workflows.get(activeArchiveWf) || store.workflows.get(activeArchiveWf).status !== 'done')) {
      activeArchiveWf = arch[0].id;
      renderedArchWf = null;
    }
    if (!arch.length) { activeArchiveWf = null; renderedArchWf = null; }
    renderTree();
    renderLiveView();
    renderArchiveView();
    renderDetail();
    renderRunStats();
    renderWorkflowInfo();
    renderStatus();
    renderTabs();
    if (activeKey) renderNote();
  }

  /* ================= event polling ================= */
  async function poll() {
    try {
      const res = await fetch(EVENTS_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < store.linesSeen) {
        /* file was rewritten (history reset): rebuild from scratch */
        const fresh = createStore();
        store.workflows = fresh.workflows;
        store.order = fresh.order;
        store.linesSeen = 0;
        store.eventsSeen = 0;
        renderedLive.clear();
        renderedArchWf = null;
      }
      for (let i = store.linesSeen; i < lines.length; i++) {
        try {
          const e = JSON.parse(lines[i]);
          if (applyEvent(store, e)) store.eventsSeen++;
        } catch (err) { /* skip malformed line, keep polling */ }
      }
      store.linesSeen = lines.length;
      pollOk = true;
      lastPollAt = Date.now();
      renderAll();
      if (!booted) { booted = true; }
    } catch (err) {
      pollOk = false; /* keep the last good state; show subtle offline indicator */
      renderStatus();
      renderRunStats();
    }
  }

  /* ================= ui wiring ================= */
  document.querySelectorAll('#view-switch button').forEach(b => {
    b.addEventListener('click', () => {
      view = b.getAttribute('data-view');
      activeKey = null;
      renderAll();
    });
  });
  $('#ribbon-search').addEventListener('click', openSwitcher);
  $('#ribbon-graph').addEventListener('click', () => { view = 'live'; activeKey = null; renderAll(); });
  $('#new-tab-btn').addEventListener('click', openSwitcher);
  $('#toggle-right').addEventListener('click', () => $('#right-sidebar').classList.toggle('hidden'));
  $('#tree-filter').addEventListener('input', (e) => { treeFilter = e.target.value; renderTree(); });
  $('#zoom-in').addEventListener('click', () => { if (focusedGraph) focusedGraph.zoomBy(1.25); });
  $('#zoom-out').addEventListener('click', () => { if (focusedGraph) focusedGraph.zoomBy(0.8); });
  $('#zoom-reset').addEventListener('click', () => { if (focusedGraph) focusedGraph.resetLayout(); });

  /* ================= ticker ================= */
  setInterval(() => {
    if (lastPollAt) {
      const ago = Math.max(0, Math.round((Date.now() - lastPollAt) / 1000));
      const el = $('#status-poll');
      if (el && pollOk) el.textContent = `${store.eventsSeen} events · polled ${ago === 0 ? 'just now' : ago + 's ago'}`;
    }
    document.querySelectorAll('.dur-live').forEach(el => {
      const spawn = Number(el.getAttribute('data-spawn'));
      if (spawn) el.textContent = fmtClock(Date.now() - spawn);
    });
  }, 1000);

  /* ================= boot ================= */
  renderTabs();
  poll();
  setInterval(poll, POLL_MS);

  /* debug/testing hook */
  window.agentOps = { store, poll, renderAll, liveWorkflows, archivedWorkflows };
}
