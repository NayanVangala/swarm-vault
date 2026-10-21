/*
 * js/folders.js
 *
 * FOLDER CARDS worker.
 * Renders each workflow (swarm) as a folder card positioned in world
 * coordinates inside #world-layer. Camera changes reposition the cards;
 * only cards roughly inside the viewport are updated.
 *
 * Public API (imported by js/app.js):
 *   initFolders({ layerEl, camera, onOpen })   setup once
 *   syncFolders(workflows)                     create/update/remove cards
 *   setHighlight(ids|null)                     dim non matching cards (search)
 *   layoutWorkflows(workflows)                 deterministic world positions
 *
 * CSS classes (must match style.css targets):
 *   .folder-card, .folder-title, .folder-status, .folder-stats,
 *   .folder-kinds, .folder-time, .dimmed, .folder-enter,
 *   .is-running, .is-done
 *
 * No emojis. No em-dashes in comments.
 */

/* World size of one card, in world px. Layout guarantees spacing above this. */
const CARD_W = 300;
const CARD_H = 170;
/* Extra world px around each card so cards never visually touch. */
const CARD_GAP = 80;

/* Screen margin (px) used to decide whether a card is close enough to
 * the viewport to deserve a transform update. */
const CULL_MARGIN = 240;

/* Refresh relative times ("2h ago") on this interval. */
const TIME_REFRESH_MS = 60000;

/* ------------------------------------------------------------------ */
/* Layout: deterministic golden-angle spiral, hashed per workflow id.  */
/* ------------------------------------------------------------------ */

/* Slot bookkeeping: each workflow id is assigned one spiral index, once.
 * Indices are never reassigned, so positions stay stable when workflows
 * are added or removed. Assignment order follows first-seen order, which
 * is deterministic given the same input sequence. */
const idSlots = new Map(); /* workflow id -> spiral slot index */
let nextSlot = 0;

function slotFor(id) {
  const key = String(id);
  let slot = idSlots.get(key);
  if (slot === undefined) {
    slot = nextSlot++;
    idSlots.set(key, slot);
  }
  return slot;
}

/*
 * Assign world positions to every workflow.
 * Phyllotaxis (golden-angle spiral): r = C * sqrt(n), theta = n * golden.
 * Spacing constant C is chosen so the nearest-neighbor distance between
 * any two cards exceeds the card diagonal (sqrt(300^2 + 170^2) ~= 345),
 * plus the card gap. Cards never overlap.
 * Positions are written back onto wf._wx / wf._wy and also returned as
 * a Map(id -> {x, y}) for convenience.
 */
export function layoutWorkflows(workflows) {
  const out = new Map();

  for (const wf of workflows) {
    if (typeof wf._wx === "number" && typeof wf._wy === "number") {
      out.set(wf.id, { x: wf._wx, y: wf._wy });
      continue; /* already placed: keep position stable */
    }

    /* Golden angle in radians: consecutive slots spread out evenly. */
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    /* Spacing constant. Nearest-neighbor distance on this spiral with
     * the 0.9 vertical squash is ~404 world px, safely above the ~345
     * card diagonal, so cards never overlap. */
    const SPIRAL_C = 280;

    const slot = slotFor(wf.id);
    const radius = SPIRAL_C * Math.sqrt(slot + 1);
    const angle = slot * GOLDEN;

    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * 0.9; /* slight vertical squash */

    wf._wx = Math.round(x);
    wf._wy = Math.round(y);
    out.set(wf.id, { x: wf._wx, y: wf._wy });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Relative time formatting.                                          */
/* ------------------------------------------------------------------ */

function relativeTime(epochMs) {
  if (!epochMs || Number.isNaN(epochMs)) return "time unknown";
  const diff = Date.now() - epochMs;
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d ago";
  const w = Math.floor(d / 7);
  if (w < 5) return w + "w ago";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + "mo ago";
  return Math.floor(d / 365) + "y ago";
}

/* ------------------------------------------------------------------ */
/* Card content.                                                      */
/* ------------------------------------------------------------------ */

/* Up to three most frequent agent kinds in this workflow. */
function topKinds(wf) {
  const counts = new Map();
  if (wf.agents && typeof wf.agents.forEach === "function") {
    wf.agents.forEach((a) => {
      const k = (a && a.kind) || "agent";
      counts.set(k, (counts.get(k) || 0) + 1);
    });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
}

function agentStats(wf) {
  let total = 0;
  let done = 0;
  if (wf.agents && typeof wf.agents.forEach === "function") {
    wf.agents.forEach((a) => {
      total++;
      if (a && (a.status === "done" || a.done === true)) done++;
    });
  }
  return { total, done };
}

function isRunning(wf) {
  const st = String(wf.status || "").toUpperCase();
  return st === "RUNNING" || st === "ACTIVE";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function cardHTML(wf) {
  const running = isRunning(wf);
  const { total, done } = agentStats(wf);
  const kinds = topKinds(wf);
  const kindsHTML = kinds
    .map((k) => '<span class="kind-chip">' + esc(k) + "</span>")
    .join("");
  const statusLabel = running ? "RUNNING" : "DONE";
  const statusDot = running ? '<span class="status-dot"></span>' : "";

  return (
    '<div class="folder-status">' +
    statusDot +
    '<span class="status-label">' +
    statusLabel +
    "</span>" +
    "</div>" +
    '<div class="folder-title">' +
    esc(wf.title || wf.id || "untitled") +
    "</div>" +
    '<div class="folder-stats">' +
    esc(total) +
    " agents, " +
    esc(done) +
    " done" +
    "</div>" +
    '<div class="folder-kinds">' +
    kindsHTML +
    "</div>" +
    '<div class="folder-time" data-started-at="' +
    esc(wf.startedAt || "") +
    '">' +
    esc(relativeTime(wf.startedAt)) +
    "</div>"
  );
}

/* ------------------------------------------------------------------ */
/* Module state.                                                      */
/* ------------------------------------------------------------------ */

let layerEl = null;
let camera = null;
let onOpen = null;

const cards = new Map(); /* workflowId -> { el, wf, x, y } */
let highlightIds = null; /* Set of ids, or null when no search filter */
let timeTimer = null;

/* ------------------------------------------------------------------ */
/* Transform updates on camera change (with viewport culling).        */
/* ------------------------------------------------------------------ */

function viewportInWorld() {
  if (!camera || typeof camera.screenToWorld !== "function") {
    return null; /* no way to map screen to world: update everything */
  }
  const tl = camera.screenToWorld(-CULL_MARGIN, -CULL_MARGIN);
  const br = camera.screenToWorld(
    window.innerWidth + CULL_MARGIN,
    window.innerHeight + CULL_MARGIN
  );
  return {
    minX: Math.min(tl.x, br.x),
    minY: Math.min(tl.y, br.y),
    maxX: Math.max(tl.x, br.x),
    maxY: Math.max(tl.y, br.y),
  };
}

function isNearViewport(x, y, vp) {
  if (!vp) return true;
  const half = CARD_W / 2 + CARD_GAP;
  return (
    x + half >= vp.minX &&
    x - half <= vp.maxX &&
    y + half >= vp.minY &&
    y - half <= vp.maxY
  );
}

function placeCard(rec) {
  const { el, x, y } = rec;
  const p = camera.worldToScreen(x, y);
  el.style.transform =
    "translate(" + Math.round(p.x) + "px," + Math.round(p.y) + "px)";
}

function refreshTransforms() {
  if (!camera) return;
  const vp = viewportInWorld();
  cards.forEach((rec) => {
    if (isNearViewport(rec.x, rec.y, vp)) {
      placeCard(rec);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Card lifecycle.                                                    */
/* ------------------------------------------------------------------ */

function makeCard(wf, x, y) {
  const el = document.createElement("div");
  el.className = "folder-card folder-enter";
  el.dataset.workflowId = String(wf.id);
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.innerHTML = cardHTML(wf);
  el.addEventListener("click", () => {
    if (onOpen) onOpen(wf.id);
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (onOpen) onOpen(wf.id);
    }
  });
  layerEl.appendChild(el);

  const rec = { el, wf, x, y };
  cards.set(wf.id, rec);

  /* Remove the enter animation class after it plays once. */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.remove("folder-enter");
    });
  });

  return rec;
}

function updateCard(rec, wf) {
  rec.wf = wf;
  rec.el.innerHTML = cardHTML(wf);
  applyDim(rec);
}

function applyDim(rec) {
  const shouldDim =
    highlightIds !== null && !highlightIds.has(rec.wf.id);
  rec.el.classList.toggle("dimmed", shouldDim);
}

/* Update only the relative time text; cheap, runs on a timer. */
function refreshTimes() {
  cards.forEach((rec) => {
    const t = rec.el.querySelector(".folder-time");
    if (t) {
      const startedAt = Number(t.dataset.startedAt);
      t.textContent = relativeTime(startedAt);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Public API.                                                        */
/* ------------------------------------------------------------------ */

/*
 * One-time setup. layerEl is the <div id="world-layer">; camera comes from
 * js/canvas.js and must expose worldToScreen(wx,wy) plus
 * onCameraChange(cb). onOpen(workflowId) fires when a card is clicked.
 */
export function initFolders({ layerEl: el, camera: cam, onOpen: openCb }) {
  layerEl = el;
  camera = cam;
  onOpen = openCb || null;

  if (camera && typeof camera.onCameraChange === "function") {
    camera.onCameraChange(refreshTransforms);
  }

  if (!timeTimer) {
    timeTimer = setInterval(refreshTimes, TIME_REFRESH_MS);
  }

  refreshTransforms();
}

/*
 * Reconcile the DOM with the current workflow list.
 * Creates cards for new workflows (with .folder-enter animation),
 * updates content and position for existing ones, removes stale ones.
 * workflows: array of wf objects with .id, .title, .status,
 *            .startedAt (epoch ms), .agents (Map).
 */
export function syncFolders(workflows) {
  if (!layerEl) return;

  layoutWorkflows(workflows);

  const seen = new Set();

  for (const wf of workflows) {
    seen.add(wf.id);
    const x = wf._wx || 0;
    const y = wf._wy || 0;
    let rec = cards.get(wf.id);

    if (!rec) {
      rec = makeCard(wf, x, y);
      /* New cards get the correct status class from the start. */
      rec.el.classList.add(isRunning(wf) ? "is-running" : "is-done");
      applyDim(rec);
    } else {
      /* Swap running/done classes when status changed. */
      const wasRunning = rec.el.classList.contains("is-running");
      const nowRunning = isRunning(wf);
      if (wasRunning !== nowRunning) {
        rec.el.classList.toggle("is-running", nowRunning);
        rec.el.classList.toggle("is-done", !nowRunning);
      }
      rec.x = x;
      rec.y = y;
      updateCard(rec, wf);
    }

    placeCard(rec);
  }

  /* Remove cards whose workflow is gone. */
  for (const [id, rec] of cards) {
    if (!seen.has(id)) {
      rec.el.remove();
      cards.delete(id);
    }
  }

  refreshTransforms();
}

/*
 * Dim every card whose id is not in ids (used by search).
 * Pass null (or an empty-behaving value) to clear the filter.
 */
export function setHighlight(ids) {
  if (ids == null) {
    highlightIds = null;
  } else if (ids instanceof Set) {
    highlightIds = ids;
  } else {
    highlightIds = new Set(ids);
  }
  cards.forEach(applyDim);
}
