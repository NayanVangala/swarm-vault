'use strict';

/* ================= constants ================= */
const PHASES = ['Propose', 'Cross-examine', 'Judge', 'Finals', 'Synthesize'];
const KIND_COLORS = {
  proposer: '#edeae0',
  attacker: '#ff4b2e',
  auditor: '#38bdf8',
  judge: '#ffb224',
  champion: '#2fe6a7',
  synthesizer: '#ff4d8d',
};
const KIND_ROLES = {
  proposer: 'Proposer',
  attacker: 'Cross-examiner · attack',
  auditor: 'Cross-examiner · feasibility audit',
  judge: 'Judge',
  champion: 'Champion',
  synthesizer: 'Synthesizer',
};
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
const CHEVRON = '<svg class="twisty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/* ================= state ================= */
let DATA = null;
let selectedId = null;
let tabs = [{ type: 'graph' }];
let activeKey = 'graph';
const collapsedPhases = new Set();
let treeFilter = '';

const $ = (sel) => document.querySelector(sel);

/* ================= helpers ================= */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function agentById(id) { return DATA ? DATA.agents.find(a => a.id === id) : null; }
function fmtElapsed(ms) {
  if (ms == null || isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
function statusPill(status) {
  const cls = status === 'completed' ? 'green' : status === 'failed' ? 'red' : status === 'running' ? '' : 'gray';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}
function currentPhase() {
  if (!DATA) return null;
  const running = DATA.agents.find(a => a.status === 'running');
  if (running) return running.phase;
  const firstPending = DATA.agents.find(a => a.status === 'pending');
  if (firstPending) return firstPending.phase;
  return null;
}

/* ================= data ================= */
async function loadData() {
  try {
    const res = await fetch('swarm.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fresh = await res.json();
    const first = !DATA;
    DATA = fresh;
    onData(first);
  } catch (e) {
    $('#status-text').textContent = 'Could not load swarm.json — retrying…';
  }
}
function onData(first) {
  renderTree();
  renderStandings();
  renderStatus();
  renderRunStats();
  if (selectedId) renderDetail(selectedId);
  Graph.syncData();
  renderTabs();
  const active = tabs.find(t => tabKey(t) === activeKey);
  if (active && active.type === 'agent') renderNote(active.id);
  if (active && active.type === 'report') renderReport();
  if (first) Graph.fitView();
}

/* ================= file tree ================= */
function renderTree() {
  const tree = $('#file-tree');
  if (!DATA) { tree.innerHTML = ''; return; }
  let html = '';
  if (DATA.reportMd) {
    html += `<div class="tree-file ${activeKey === 'report' ? 'selected' : ''}" data-open-report="1">
      ${FILE_ICON}<span class="tree-file-label">Arena report.md</span>
      <span class="status-dot dot-completed"></span></div>`;
  }
  const q = treeFilter.trim().toLowerCase();
  for (const phase of PHASES) {
    const agents = DATA.agents.filter(a => a.phase === phase)
      .filter(a => !q || a.label.toLowerCase().includes(q) || (a.title || '').toLowerCase().includes(q));
    if (q && agents.length === 0) continue;
    const collapsed = collapsedPhases.has(phase) && !q;
    html += `<div class="tree-folder ${collapsed ? 'collapsed' : ''}">
      <div class="tree-folder-header" data-toggle-phase="${esc(phase)}">${CHEVRON}
        <span class="folder-name">${esc(phase)}</span>
        <span class="folder-count">${agents.length}</span></div>
      <div class="tree-children">`;
    for (const a of agents) {
      html += `<div class="tree-file ${selectedId === a.id ? 'selected' : ''}" data-agent="${esc(a.id)}">
        ${FILE_ICON}
        <span class="tree-file-label">${esc(a.label)}</span>
        ${a.title ? `<span class="tree-file-title">${esc(a.title)}</span>` : ''}
        <span class="status-dot dot-${esc(a.status)}"></span></div>`;
    }
    html += `</div></div>`;
  }
  tree.innerHTML = html || '<div class="standings-empty">No files match.</div>';
  tree.querySelectorAll('[data-toggle-phase]').forEach(el => {
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-toggle-phase');
      if (collapsedPhases.has(p)) collapsedPhases.delete(p); else collapsedPhases.add(p);
      renderTree();
    });
  });
  tree.querySelectorAll('[data-agent]').forEach(el => {
    el.addEventListener('click', () => openAgent(el.getAttribute('data-agent'), true));
  });
  tree.querySelectorAll('[data-open-report]').forEach(el => {
    el.addEventListener('click', () => openReport());
  });
}

/* ================= standings ================= */
function renderStandings() {
  const box = $('#standings-list');
  if (!DATA) return;
  let html = '';
  if (DATA.winner) {
    const w = agentById(DATA.winner);
    const name = w ? (w.title || w.label) : String(DATA.winner);
    html += `<div class="winner-banner">🏆 <b>Winner</b><br>${esc(name)}</div>`;
  }
  const scored = DATA.agents.filter(a => a.score != null)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 && !DATA.winner) {
    box.innerHTML = '<div class="standings-empty">Judging has not started</div>';
    return;
  }
  html += scored.map((a, i) =>
    `<div class="standing-row" data-agent="${esc(a.id)}">
       <span class="standing-rank">${i + 1}</span>
       <span class="standing-name">${esc(a.title || a.label)}</span>
       <span class="standing-score">${Number(a.score).toFixed(1)}</span>
     </div>`).join('');
  box.innerHTML = html;
  box.querySelectorAll('[data-agent]').forEach(el => {
    el.addEventListener('click', () => openAgent(el.getAttribute('data-agent'), true));
  });
}

/* ================= status bar + run stats ================= */
function renderStatus() {
  if (!DATA) return;
  const done = DATA.agents.filter(a => a.status === 'completed').length;
  const failed = DATA.agents.filter(a => a.status === 'failed').length;
  const phase = currentPhase();
  let text;
  if (DATA.status === 'completed' || done === DATA.agents.length) {
    text = 'Run complete';
  } else if (DATA.status === 'stopped') {
    text = 'Run stopped';
  } else {
    text = 'LIVE · ' + (phase ? phase + ' phase' : 'Arena running');
  }
  if (failed) text += ` · ${failed} failed`;
  $('#status-text').textContent = text;
  $('#status-sync-icon').classList.toggle('live', DATA.status === 'running');
  $('#status-notes').textContent = DATA.agents.length + (DATA.reportMd ? 1 : 0) + ' notes';
}
function renderRunStats() {
  const box = $('#run-stats');
  if (!DATA) { box.innerHTML = ''; return; }
  const total = DATA.agents.length;
  const done = DATA.agents.filter(a => a.status === 'completed').length;
  const running = DATA.agents.filter(a => a.status === 'running').length;
  const failed = DATA.agents.filter(a => a.status === 'failed').length;
  const phase = currentPhase() || '—';
  let tokens = null;
  if (typeof DATA.totalTokens === 'number') tokens = DATA.totalTokens;
  else if (DATA.tokens && typeof DATA.tokens.total === 'number') tokens = DATA.tokens.total;
  else if (typeof DATA.inputTokens === 'number' || typeof DATA.outputTokens === 'number') {
    tokens = (DATA.inputTokens || 0) + (DATA.outputTokens || 0);
  }
  box.innerHTML = `
    <div class="progress-track"><div class="progress-fill" style="width:${total ? (done / total) * 100 : 0}%"></div></div>
    <div class="stat-row"><span class="sk">Completed</span><span class="sv">${done} / ${total}</span></div>
    <div class="stat-row"><span class="sk">Running</span><span class="sv">${running}</span></div>
    <div class="stat-row"><span class="sk">Failed</span><span class="sv">${failed}</span></div>
    <div class="stat-row"><span class="sk">Phase</span><span class="sv">${esc(phase)}</span></div>
    <div class="stat-row"><span class="sk">Elapsed</span><span class="sv" id="stats-elapsed">${fmtClock(Date.now() - DATA.startedAt)}</span></div>
    ${tokens != null ? `<div class="stat-row"><span class="sk">Total tokens</span><span class="sv">${tokens.toLocaleString()}</span></div>` : ''}
    <div class="stat-row"><span class="sk">Run</span><span class="sv" style="font-size:10.5px">${esc(String(DATA.runId || '').replace('workflow-run-', ''))}</span></div>`;
}
setInterval(() => {
  if (!DATA) return;
  const el = $('#status-elapsed');
  if (el) el.textContent = fmtClock(Date.now() - DATA.startedAt) + ' elapsed';
  const se = $('#stats-elapsed');
  if (se) se.textContent = fmtClock(Date.now() - DATA.startedAt);
}, 1000);

/* ================= tabs ================= */
function tabKey(t) {
  return t.type === 'graph' ? 'graph' : t.type === 'report' ? 'report' : 'agent:' + t.id;
}
function tabLabel(t) {
  if (t.type === 'graph') return 'Graph view';
  if (t.type === 'report') return 'Arena report';
  const a = agentById(t.id);
  return a ? (a.title || a.label) : t.id;
}
function renderTabs() {
  const wrap = $('#tabs');
  wrap.innerHTML = tabs.map(t => {
    const key = tabKey(t);
    const a = t.type === 'agent' ? agentById(t.id) : null;
    return `<div class="tab ${key === activeKey ? 'active' : ''}" data-tab="${esc(key)}">
      ${a ? `<span class="status-dot dot-${esc(a.status)}"></span>` : ''}
      <span class="tab-label">${esc(tabLabel(t))}</span>
      ${t.type !== 'graph' ? `<span class="tab-close" data-close="${esc(key)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></span>` : ''}
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-tab]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return;
      activateTab(el.getAttribute('data-tab'));
    });
  });
  wrap.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(el.getAttribute('data-close'));
    });
  });
  $('#graph-controls').classList.toggle('visible', activeKey === 'graph');
  updatePanes();
}
function activateTab(key) {
  activeKey = key;
  renderTabs();
  const t = tabs.find(x => tabKey(x) === key);
  if (t && t.type === 'agent') { selectedId = t.id; renderNote(t.id); renderDetail(t.id); renderTree(); }
  if (t && t.type === 'report') renderReport();
}
function closeTab(key) {
  const idx = tabs.findIndex(t => tabKey(t) === key);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (activeKey === key) {
    const next = tabs[Math.max(0, idx - 1)] || tabs[0];
    activeKey = next ? tabKey(next) : 'graph';
  }
  renderTabs();
  const t = tabs.find(x => tabKey(x) === activeKey);
  if (t && t.type === 'agent') renderNote(t.id);
  if (t && t.type === 'report') renderReport();
}
function updatePanes() {
  const isGraph = activeKey === 'graph';
  $('#graph-pane').style.display = isGraph ? 'block' : 'none';
  $('#note-pane').hidden = isGraph;
  if (isGraph) Graph.resize();
}
function openAgent(id, openNote) {
  selectedId = id;
  renderDetail(id);
  renderTree();
  Graph.setSelected(id);
  if (openNote) {
    if (!tabs.some(t => t.type === 'agent' && t.id === id)) tabs.push({ type: 'agent', id });
    activeKey = 'agent:' + id;
    renderTabs();
    renderNote(id);
  }
}
function openReport() {
  if (!tabs.some(t => t.type === 'report')) tabs.push({ type: 'report' });
  activeKey = 'report';
  renderTabs();
  renderReport();
}

/* ================= note rendering ================= */
function renderJsonObject(obj, depth) {
  if (obj === null || obj === undefined) return '<span class="output-empty">—</span>';
  if (typeof obj !== 'object') return esc(String(obj));
  if (Array.isArray(obj)) {
    return '<ul>' + obj.map(v => `<li>${typeof v === 'object' ? renderJsonObject(v, depth + 1) : esc(String(v))}</li>`).join('') + '</ul>';
  }
  const rows = Object.entries(obj).map(([k, v]) => {
    const val = (v !== null && typeof v === 'object')
      ? renderJsonObject(v, depth + 1)
      : esc(String(v));
    return `<tr><td class="k">${esc(k)}</td><td>${val}</td></tr>`;
  }).join('');
  return `<table class="kv-table">${rows}</table>`;
}
function renderOutput(output) {
  if (output == null || output === '') return '<p class="output-empty">Waiting for output…</p>';
  if (typeof output === 'object') return renderJsonObject(output, 0);
  const str = String(output).trim();
  if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
    try { return renderJsonObject(JSON.parse(str), 0); } catch (e) { /* fall through to text */ }
  }
  return str.split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}
function renderNote(id) {
  const a = agentById(id);
  const pane = $('#note-content');
  if (!a) { pane.innerHTML = '<h1>Not found</h1>'; return; }
  pane.innerHTML = `
    <h1>${esc(a.title || a.label)}</h1>
    <div class="note-subtitle">${esc(a.label)} · ${esc(a.phase)}</div>
    <div class="properties">
      <div class="prop-row"><span class="prop-key">phase</span><span class="prop-val"><span class="pill">${esc(a.phase)}</span></span></div>
      <div class="prop-row"><span class="prop-key">role</span><span class="prop-val">${esc(KIND_ROLES[a.kind] || a.kind)}</span></div>
      <div class="prop-row"><span class="prop-key">status</span><span class="prop-val">${statusPill(a.status)}</span></div>
      <div class="prop-row"><span class="prop-key">elapsed</span><span class="prop-val">${fmtElapsed(a.elapsedMs)}</span></div>
      ${a.score != null ? `<div class="prop-row"><span class="prop-key">score</span><span class="prop-val">${Number(a.score).toFixed(1)} / 10</span></div>` : ''}
      <div class="prop-row"><span class="prop-key">id</span><span class="prop-val" style="font-family:var(--font-mono);font-size:12px">${esc(a.id)}</span></div>
    </div>
    <h2>Output</h2>
    ${renderOutput(a.output)}`;
  $('#note-pane').scrollTop = 0;
}
function renderReport() {
  const pane = $('#note-content');
  if (!DATA || !DATA.reportMd) {
    pane.innerHTML = '<h1>Arena report</h1><p class="output-empty">The final report has not been written yet.</p>';
    return;
  }
  pane.innerHTML = mdToHtml(DATA.reportMd);
  $('#note-pane').scrollTop = 0;
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

/* ================= right sidebar ================= */
function neighbors(id, dir) {
  if (!DATA) return [];
  return DATA.edges
    .filter(e => dir === 'in' ? e[1] === id : e[0] === id)
    .map(e => agentById(dir === 'in' ? e[0] : e[1]))
    .filter(Boolean);
}
function renderDetail(id) {
  const a = agentById(id);
  const detail = $('#agent-detail');
  const back = $('#backlinks');
  if (!a) {
    detail.innerHTML = '<div class="detail-empty">Select an agent in the graph or file tree to inspect it.</div>';
    back.innerHTML = '<div class="detail-empty">Nothing selected.</div>';
    return;
  }
  const ins = neighbors(id, 'in');
  const outs = neighbors(id, 'out');
  detail.innerHTML = `
    <div class="detail-title">${esc(a.title || a.label)}</div>
    <div class="detail-row"><span class="dk">label</span><span class="dv">${esc(a.label)}</span></div>
    <div class="detail-row"><span class="dk">phase</span><span class="dv">${esc(a.phase)}</span></div>
    <div class="detail-row"><span class="dk">role</span><span class="dv">${esc(KIND_ROLES[a.kind] || a.kind)}</span></div>
    <div class="detail-row"><span class="dk">status</span><span class="dv">${esc(a.status)}</span></div>
    <div class="detail-row"><span class="dk">elapsed</span><span class="dv">${fmtElapsed(a.elapsedMs)}</span></div>
    ${a.score != null ? `<div class="detail-row"><span class="dk">score</span><span class="dv">${Number(a.score).toFixed(1)} / 10</span></div>` : ''}
    <div class="detail-row"><span class="dk">consumes</span><span class="dv">${ins.length ? ins.map(x => esc(x.label)).join(', ') : '—'}</span></div>
    <div class="detail-row"><span class="dk">produces</span><span class="dv">${outs.length ? outs.map(x => esc(x.label)).join(', ') : '—'}</span></div>`;
  const linkItem = (x, tag) => `<div class="backlink-item" data-agent="${esc(x.id)}"><span class="status-dot dot-${esc(x.status)}"></span><span class="bl-label">${esc(x.label)}</span><span style="color:var(--text-faint);font-size:11px">${tag}</span></div>`;
  back.innerHTML =
    (ins.length ? '<div class="detail-sub">Feeds from</div>' + ins.map(x => linkItem(x, 'in')).join('') : '') +
    (outs.length ? '<div class="detail-sub">Feeds into</div>' + outs.map(x => linkItem(x, 'out')).join('') : '') ||
    '<div class="detail-empty">No links.</div>';
  back.querySelectorAll('[data-agent]').forEach(el => {
    el.addEventListener('click', () => openAgent(el.getAttribute('data-agent'), false));
  });
}

/* ================= quick switcher ================= */
const switcher = { items: [], activeIdx: 0 };
function fuzzyScore(needle, hay) {
  needle = needle.toLowerCase(); hay = hay.toLowerCase();
  let ni = 0, score = 0, last = -1;
  for (let hi = 0; hi < hay.length && ni < needle.length; hi++) {
    if (hay[hi] === needle[ni]) {
      score += last === hi - 1 ? 3 : 1;
      last = hi; ni++;
    }
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
  if (!DATA) return;
  const pool = DATA.agents.map(a => ({ a, text: `${a.label} ${a.title || ''} ${a.phase} ${a.kind}` }));
  let scored = pool.map(p => ({ ...p, s: q ? fuzzyScore(q, p.text) : 1 })).filter(p => p.s >= 0);
  scored.sort((x, y) => y.s - x.s);
  switcher.items = scored.slice(0, 12);
  switcher.activeIdx = 0;
  const list = $('#switcher-list');
  list.innerHTML = switcher.items.length
    ? switcher.items.map((p, i) => `<div class="switcher-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
        <span class="status-dot dot-${esc(p.a.status)}"></span>
        <span>${esc(p.a.label)}</span>
        ${p.a.title ? `<span class="sw-title">${esc(p.a.title)}</span>` : ''}
        <span class="sw-phase">${esc(p.a.phase)}</span></div>`).join('')
    : '<div class="switcher-empty">No matching agents</div>';
  list.querySelectorAll('.switcher-item').forEach(el => {
    el.addEventListener('click', () => {
      const p = switcher.items[Number(el.getAttribute('data-idx'))];
      if (p) { closeSwitcher(); openAgent(p.a.id, true); }
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
    if (p) { closeSwitcher(); openAgent(p.a.id, true); }
  }
});
$('#switcher-input').addEventListener('input', (e) => updateSwitcher(e.target.value));
$('#switcher-overlay').addEventListener('click', (e) => { if (e.target.id === 'switcher-overlay') closeSwitcher(); });

/* ================= ui wiring ================= */
$('#ribbon-search').addEventListener('click', openSwitcher);
$('#ribbon-graph').addEventListener('click', () => activateTab('graph'));
$('#new-tab-btn').addEventListener('click', openSwitcher);
$('#toggle-right').addEventListener('click', () => $('#right-sidebar').classList.toggle('hidden'));
$('#tree-filter').addEventListener('input', (e) => { treeFilter = e.target.value; renderTree(); });
$('#collapse-all').addEventListener('click', () => {
  const allCollapsed = PHASES.every(p => collapsedPhases.has(p));
  if (allCollapsed) collapsedPhases.clear(); else PHASES.forEach(p => collapsedPhases.add(p));
  renderTree();
});
$('#zoom-in').addEventListener('click', () => Graph.zoomBy(1.25));
$('#zoom-out').addEventListener('click', () => Graph.zoomBy(0.8));
$('#zoom-reset').addEventListener('click', () => Graph.resetLayout());

/* ================= graph ================= */
const Graph = (() => {
  const canvas = $('#graph-canvas');
  const ctx = canvas.getContext('2d');
  const nodes = new Map(); // id -> physics node
  let edges = [];
  let cam = { x: 0, y: 0, k: 1 };
  let W = 0, H = 0, dpr = 1;
  let hoverId = null, selectedNodeId = null, dragNode = null, dragMoved = false;
  let panning = false, panStart = null, lastPtr = null;

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function seedPos(a, siblings, idxInPhase) {
    const phaseIdx = PHASES.indexOf(a.phase);
    const x = (phaseIdx - 2) * 300 + ((hashCode(a.id) % 90) - 45);
    const spread = Math.max(1, siblings - 1);
    const y = (idxInPhase - spread / 2) * 92 + ((hashCode(a.id + 'y') % 50) - 25);
    return { x, y };
  }
  function syncData() {
    if (!DATA) return;
    edges = DATA.edges.slice();
    const deg = new Map();
    edges.forEach(([f, t]) => { deg.set(f, (deg.get(f) || 0) + 1); deg.set(t, (deg.get(t) || 0) + 1); });
    const byPhase = {};
    DATA.agents.forEach(a => { (byPhase[a.phase] = byPhase[a.phase] || []).push(a); });
    DATA.agents.forEach(a => {
      const siblings = byPhase[a.phase];
      const idx = siblings.indexOf(a);
      let n = nodes.get(a.id);
      if (!n) {
        const p = seedPos(a, siblings.length, idx);
        n = { id: a.id, x: p.x, y: p.y, vx: 0, vy: 0 };
        nodes.set(a.id, n);
      }
      n.agent = a;
      n.r = Math.min(17, 5.5 + (deg.get(a.id) || 0) * 1.05);
    });
    for (const id of Array.from(nodes.keys())) {
      if (!DATA.agents.some(a => a.id === id)) nodes.delete(id);
    }
    buildLegend();
  }
  function buildLegend() {
    const seen = new Map();
    if (DATA) DATA.agents.forEach(a => { if (!seen.has(a.kind)) seen.set(a.kind, KIND_COLORS[a.kind]); });
    $('#graph-legend').innerHTML = Array.from(seen.entries())
      .map(([k, c]) => `<div class="legend-row"><span class="legend-dot" style="background:${c}"></span>${esc(KIND_ROLES[k] || k)}</div>`).join('');
  }
  function resize() {
    const pane = $('#graph-pane');
    if (!pane || pane.clientWidth === 0) return;
    dpr = window.devicePixelRatio || 1;
    W = pane.clientWidth; H = pane.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  function fitView() {
    resize();
    if (!W) return;
    cam = { x: W / 2, y: H / 2, k: Math.min(1, Math.min(W / 1750, H / 1250) * 1.6) };
    if (!(cam.k > 0)) cam.k = 0.6;
  }
  function resetLayout() {
    nodes.forEach(n => {
      const siblings = DATA ? DATA.agents.filter(a => a.phase === n.agent.phase) : [n.agent];
      const idx = siblings.findIndex(a => a.id === n.id);
      const p = seedPos(n.agent, siblings.length, Math.max(0, idx));
      n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
    });
    fitView();
  }
  function zoomBy(f) {
    cam.k = Math.max(0.08, Math.min(3.2, cam.k * f));
  }
  function toWorld(px, py) {
    return { x: (px - cam.x) / cam.k, y: (py - cam.y) / cam.k };
  }
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
    // repulsion (O(n^2), n=45)
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
    // springs
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
    // centering + integrate
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
  function draw(now) {
    if (!W) resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#070706';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.k, cam.k);
    // edges
    ctx.lineWidth = 1 / cam.k;
    for (const [f, t] of edges) {
      const a = nodes.get(f), b = nodes.get(t);
      if (!a || !b) continue;
      const active = (a.agent && a.agent.status === 'completed') && b.agent && (b.agent.status === 'running' || b.agent.status === 'completed');
      ctx.strokeStyle = active ? 'rgba(201,247,58,0.45)' : 'rgba(150,148,138,0.28)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // nodes
    nodes.forEach(n => {
      const a = n.agent;
      const color = KIND_COLORS[a.kind] || '#888';
      const isHover = hoverId === n.id, isSel = selectedNodeId === n.id;
      ctx.save();
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
      if (a.status === 'pending') {
        ctx.fillStyle = 'rgba(10,10,9,0.9)';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (a.status === 'failed') {
        ctx.fillStyle = '#ff4b2e';
        ctx.shadowColor = '#ff4b2e'; ctx.shadowBlur = isHover ? 12 : 0;
        ctx.fill();
      } else {
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = isHover || isSel ? 14 : (a.status === 'running' ? 8 : 0);
        ctx.fill();
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.3;
        ctx.shadowBlur = 0;
        ctx.stroke();
      }
      ctx.restore();
      // labels
      if (cam.k >= 0.72 || isHover || isSel) {
        const label = a.title || a.label;
        ctx.font = `${isHover || isSel ? 700 : 500} ${11.5 / Math.sqrt(cam.k)}px Archivo, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = isHover || isSel ? '#f0f0f0' : 'rgba(200,200,200,0.82)';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 4;
        ctx.fillText(label, n.x, n.y + n.r + 15 / Math.sqrt(cam.k));
        ctx.shadowBlur = 0;
      }
    });
  }
  function loop(now) {
    if (activeKey === 'graph' && $('#graph-pane').style.display !== 'none') {
      step();
      draw(now);
    }
    requestAnimationFrame(loop);
  }
  /* pointer interactions */
  function ptrPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  canvas.addEventListener('pointerdown', (e) => {
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
  canvas.addEventListener('pointerup', (e) => {
    const wasNode = dragNode;
    const moved = dragMoved;
    dragNode = null; panning = false;
    canvas.classList.remove('dragging');
    if (wasNode && !moved) {
      openAgent(wasNode.id, false);
    }
  });
  canvas.addEventListener('dblclick', (e) => {
    const p = ptrPos(e);
    const n = pick(p.x, p.y);
    if (n) openAgent(n.id, true);
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

  requestAnimationFrame(loop);
  resize();

  return {
    syncData, resize, fitView, resetLayout, zoomBy,
    setSelected(id) { selectedNodeId = id; },
  };
})();

/* ================= boot ================= */
renderTabs();
loadData();
setInterval(loadData, 5000);
