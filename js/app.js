// Shell and wiring for the swarm-vault dashboard.
// Owns the poll loop, store, camera, folder sync and swarm overlay state.

import { createStore, applyEvents, workflowStats } from './store.js';
import { mountGrid } from './canvas.js';
import { initFolders, syncFolders, layoutWorkflows } from './folders.js';
import { openSwarm, closeSwarm, updateSwarm } from './swarm.js';
import { initSearch } from './search.js';

const EVENTS_URL = 'https://raw.githubusercontent.com/NayanVangala/swarm-vault/main/agent-ops/events.jsonl';
const POLL_MS = 5000;
const BACKOFF_CAP_MS = 60000;

function $(id) { return document.getElementById(id); }

function setHud(text, live) {
  try {
    $('hud-text').textContent = text;
    document.querySelector('.live-dot').classList.toggle('on', !!live);
  } catch (e) { console.error(e); }
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

let store, camera, folders;
let knownIds = new Set();
let openWorkflowId = null;
let backoff = POLL_MS;
let lastPollOk = false;

function refreshChrome() {
  // Status bar: totals from the store and the last good poll time.
  try {
    let w = 0, a = 0;
    for (const wf of store.workflows.values()) {
      w += 1;
      a += workflowStats(wf).total;
    }
    $('status-totals').textContent = w + ' swarms · ' + a + ' agents';
    if (lastPollOk) $('status-text').textContent = 'synced ' + fmtTime(new Date());
  } catch (e) { console.error(e); }
}

function allWorkflows() {
  return [...store.workflows.values()];
}

function onNewEvents() {
  // Only lay out workflows we have never positioned before, so
  // existing folders never jump when fresh events arrive.
  try {
    const wfs = allWorkflows();
    const ids = wfs.map(w => w.id).filter(id => !knownIds.has(id));
    if (ids.length > 0) {
      layoutWorkflows(wfs);
      wfs.forEach(w => knownIds.add(w.id));
    }
  } catch (e) { console.error(e); }
}

async function poll() {
  try {
    const res = await fetch(EVENTS_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim().length > 0);

    // store.js applies only new lines by index (store.linesSeen), so it
    // always receives the full array.
    const delta = applyEvents(store, lines);
    if (delta.newWorkflows.length > 0 || delta.changedWorkflows.length > 0 || !lastPollOk) {
      onNewEvents();
      syncFolders(allWorkflows());
      if (openWorkflowId) {
        const wf = store.workflows.get(openWorkflowId);
        if (wf) updateSwarm(wf);
      }
    }

    backoff = POLL_MS;
    lastPollOk = true;
    setHud('live', true);
    document.querySelector('.sync-dot').classList.add('on');
    refreshChrome();
  } catch (e) {
    console.error('[poll]', e);
    setHud('reconnecting', false);
    document.querySelector('.sync-dot').classList.remove('on');
    $('status-text').textContent = 'reconnecting…';
    backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
  } finally {
    setTimeout(poll, backoff);
  }
}

function boot() {
  try {
    store = createStore();
    camera = mountGrid($('grid'));

    const layerEl = $('world-layer');
    folders = initFolders({
      layerEl: layerEl,
      camera: camera,
      onOpen: (wf) => {
        try {
          openWorkflowId = wf.id;
          openSwarm(wf, { onBack: () => { openWorkflowId = null; } });
        } catch (e) { console.error(e); }
      }
    });

    initSearch({
      inputEl: $('search-input'),
      listEl: $('search-list'),
      getWorkflows: () => allWorkflows(),
      camera: camera,
      folders: folders,
      workflowPos: (id) => {
        const wf = store.workflows.get(id);
        return wf ? { x: wf._wx || 0, y: wf._wy || 0 } : null;
      }
    });

    // Cmd/Ctrl+K focuses search.
    document.addEventListener('keydown', (e) => {
      try {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          $('search-input').focus();
        }
        if (e.key === 'Escape' && openWorkflowId) {
          openWorkflowId = null;
          closeSwarm();
        }
      } catch (err) { console.error(err); }
    });

    // Clicking empty canvas closes the overlay.
    layerEl.addEventListener('click', (e) => {
      try {
        if (e.target === layerEl && openWorkflowId) {
          openWorkflowId = null;
          closeSwarm();
        }
      } catch (err) { console.error(err); }
    });

    poll();
  } catch (e) {
    console.error('[boot]', e);
    $('status-text').textContent = 'failed to start';
    setHud('offline', false);
  }
}

boot();
