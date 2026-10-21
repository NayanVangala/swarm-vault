// search.js
// Case-insensitive workflow search for the swarm-vault canvas.
// Renders a small results dropdown under the search box and flies the
// camera to the chosen workflow's folder.

function agentCount(wf) {
  if (wf.agents instanceof Map) return wf.agents.size;
  if (Array.isArray(wf.agents)) return wf.agents.length;
  if (typeof wf.agentCount === 'number') return wf.agentCount;
  if (typeof wf.agents === 'number') return wf.agents;
  return 0;
}

function rankMatch(wf, q) {
  const title = String(wf.title || '').toLowerCase();
  const id = String(wf.id || '').toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  if (id.includes(q)) return 2;
  return -1;
}

export function initSearch({ inputEl, listEl, getWorkflows, camera, folders, workflowPos }) {
  let matches = [];
  let activeIndex = -1;
  let open = false;

  function close() {
    open = false;
    matches = [];
    activeIndex = -1;
    listEl.innerHTML = '';
    listEl.classList.remove('open');
  }

  function render() {
    listEl.innerHTML = '';
    matches.forEach((wf, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-row' + (i === activeIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');

      const dot = document.createElement('span');
      dot.className = 'search-status-dot ' + String(wf.status || 'unknown');

      const title = document.createElement('span');
      title.className = 'search-title';
      title.textContent = wf.title || wf.id;

      const count = document.createElement('span');
      count.className = 'search-count';
      count.textContent = agentCount(wf) + ' agents';

      row.append(dot, title, count);
      row.addEventListener('click', () => flyTo(i));
      row.addEventListener('mousemove', () => {
        if (activeIndex !== i) {
          activeIndex = i;
          paintActive();
        }
      });
      listEl.appendChild(row);
    });
    listEl.classList.toggle('open', open && matches.length > 0);
  }

  function paintActive() {
    Array.from(listEl.children).forEach((row, i) => {
      row.classList.toggle('active', i === activeIndex);
      row.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
    });
  }

  function flyTo(i) {
    const wf = matches[i];
    if (!wf) return;
    const pos = workflowPos(wf.id);
    if (pos && camera && typeof camera.flyTo === 'function') {
      /* flyTo centers the point; cards are positioned by top-left corner,
         so offset by half the card size (300x170 world px) to center the card. */
      camera.flyTo(pos.x + 150, pos.y + 85, 1.1, 600);
    }
    close();
    inputEl.blur();
  }

  function update() {
    const q = inputEl.value.trim().toLowerCase();
    if (!q) {
      close();
      if (folders && typeof folders.setHighlight === 'function') folders.setHighlight(null);
      return;
    }
    const wfs = getWorkflows() || [];
    matches = wfs
      .map((wf) => ({ wf, rank: rankMatch(wf, q) }))
      .filter((r) => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank || String(a.wf.title || '').localeCompare(String(b.wf.title || '')))
      .slice(0, 8)
      .map((r) => r.wf);
    activeIndex = matches.length ? 0 : -1;
    open = true;
    render();
    if (folders && typeof folders.setHighlight === 'function') {
      folders.setHighlight(matches.map((wf) => wf.id));
    }
  }

  inputEl.addEventListener('input', update);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!matches.length) return;
      e.preventDefault();
      activeIndex = (activeIndex + 1) % matches.length;
      paintActive();
    } else if (e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      activeIndex = (activeIndex - 1 + matches.length) % matches.length;
      paintActive();
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < matches.length) {
        e.preventDefault();
        flyTo(activeIndex);
      }
    } else if (e.key === 'Escape') {
      inputEl.value = '';
      update();
      inputEl.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (open && !e.target.closest('.search-box')) {
      close();
    }
  });

  function focus() {
    inputEl.focus();
    inputEl.select();
  }

  return { focus, close, update };
}
