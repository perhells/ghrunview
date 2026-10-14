'use strict';

const { esc, badge, stateOf, fmtDur, ago, runDur } = GHRV;
const app = document.getElementById('app');
const repoInput = document.getElementById('repo-input');
const rateEl = document.getElementById('rate');
const ghLink = document.getElementById('gh-link');

let timers = [];
let gen = 0;
let state = { repo: '', runs: [], page: 1, filters: { branch: '', status: '', event: '', workflow: '' }, run: null, view: null };

async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set('repo', state.repo);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) u.searchParams.set(k, v);
  const r = await fetch(u);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  if (body.rate) rateEl.textContent = `rate ${body.rate.remaining}`;
  return body;
}

// apiStream reads the two-line NDJSON run response, handing the skeleton to onPartial first.
async function apiStream(path, onPartial) {
  const u = new URL(path, location.origin);
  u.searchParams.set('repo', state.repo);
  const r = await fetch(u);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `${r.status} ${r.statusText}`);
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', last = null;
  const take = line => {
    if (!line.trim()) return;
    const obj = JSON.parse(line);
    if (obj.error) throw new Error(obj.error);
    last = obj;
    if (obj.partial) onPartial(obj);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  take(buf);
  if (!last || last.partial) throw new Error('incomplete response from server');
  return last;
}

function clearTimers() { timers.forEach(clearInterval); timers = []; }
function every(ms, fn) { timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); }
const showError = e => { app.innerHTML = `<div class="error">${esc(e.message || e)}</div>`; };

// ---------- routing ----------
function parseHash() {
  const m = location.hash.match(/^#\/([\w.-]+\/[\w.-]+)(?:\/run\/(\d+))?(\?.*)?$/);
  return m ? { repo: m[1], runId: m[2] ? Number(m[2]) : null, expand: (m[3] || '').includes('expand') } : null;
}
async function route() {
  clearTimers();
  const myGen = ++gen;
  if (state.view) { state.view.destroy(); state.view = null; }
  const h = parseHash();
  if (!h) {
    const cfg = await api('/api/config').catch(() => ({}));
    if (cfg.repo) { location.hash = `#/${cfg.repo}`; return; }
    app.innerHTML = '<div class="empty">Enter a repository (owner/name) above to get started.</div>';
    return;
  }
  state.repo = h.repo;
  repoInput.value = h.repo;
  ghLink.hidden = false;
  ghLink.href = `https://github.com/${h.repo}/actions`;
  if (h.runId) await showRun(h.runId, h.expand, myGen); else await showList(myGen);
}
window.addEventListener('hashchange', route);
document.getElementById('repo-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = repoInput.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) location.hash = `#/${v}`;
});

// ---------- runs list ----------
async function showList(myGen) {
  state.page = 1;
  state.runs = [];
  renderListShell();
  await loadRuns(true, myGen);
  every(15000, () => loadRuns(true, myGen));
}

function renderListShell() {
  const f = state.filters;
  app.innerHTML = `
    <div class="filters">
      <input id="f-branch" placeholder="branch" value="${esc(f.branch)}">
      <select id="f-status">
        ${['', 'queued', 'in_progress', 'completed', 'success', 'failure', 'cancelled'].map(s => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${s || 'any status'}</option>`).join('')}
      </select>
      <select id="f-event">
        ${['', 'push', 'pull_request', 'workflow_dispatch', 'schedule', 'workflow_run', 'release'].map(s => `<option value="${s}" ${f.event === s ? 'selected' : ''}>${s || 'any event'}</option>`).join('')}
      </select>
      <select id="f-workflow"><option value="">any workflow</option></select>
      <span class="spacer"></span>
      <span class="hint">auto-refresh 15s</span>
      <button id="refresh">Refresh</button>
    </div>
    <div id="list"></div>`;
  const apply = () => {
    f.branch = document.getElementById('f-branch').value.trim();
    f.status = document.getElementById('f-status').value;
    f.event = document.getElementById('f-event').value;
    f.workflow = document.getElementById('f-workflow').value;
    state.page = 1; state.runs = [];
    loadRuns(true);
  };
  for (const id of ['f-branch', 'f-status', 'f-event']) document.getElementById(id).addEventListener('change', apply);
  document.getElementById('f-workflow').addEventListener('change', () => { f.workflow = document.getElementById('f-workflow').value; renderRuns(); });
  document.getElementById('refresh').addEventListener('click', () => { state.page = 1; state.runs = []; loadRuns(true); });
}

async function loadRuns(reset, myGen = gen) {
  const f = state.filters;
  const list = document.getElementById('list');
  if (!list) return;
  try {
    if (reset) {
      const all = [];
      for (let p = 1; p <= Math.max(1, state.page); p++) {
        const res = await api('/api/runs', { branch: f.branch, status: f.status, event: f.event, page: p, per_page: 30 });
        if (myGen !== gen) return;
        all.push(...res.workflow_runs);
        if (res.workflow_runs.length < 30) break;
      }
      state.runs = all;
    } else {
      const res = await api('/api/runs', { branch: f.branch, status: f.status, event: f.event, page: state.page, per_page: 30 });
      if (myGen !== gen) return;
      state.runs.push(...res.workflow_runs);
    }
    renderRuns();
  } catch (e) { if (myGen === gen) list.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

function renderRuns() {
  const list = document.getElementById('list');
  if (!list) return;
  const sel = document.getElementById('f-workflow');
  const names = [...new Set(state.runs.map(r => r.name))].sort();
  const cur = state.filters.workflow;
  sel.innerHTML = `<option value="">any workflow</option>` + names.map(n => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const runs = cur ? state.runs.filter(r => r.name === cur) : state.runs;
  if (!runs.length) { list.innerHTML = '<div class="empty">No runs.</div>'; return; }
  list.innerHTML = `
    <table class="runs">
      <thead><tr><th>Status</th><th>Run</th><th>Branch</th><th>Event</th><th>Actor</th><th>#</th><th>Started</th><th>Duration</th></tr></thead>
      <tbody>${runs.map(r => `<tr data-id="${r.id}">
          <td>${badge(stateOf(r))}</td>
          <td class="title"><div>${esc(r.display_title)}</div><div class="wf">${esc(r.name)}</div></td>
          <td class="mono">${esc(r.head_branch)}</td>
          <td class="muted">${esc(r.event)}</td>
          <td class="muted">${esc(r.actor?.login)}</td>
          <td class="muted mono">${r.run_number}${r.run_attempt > 1 ? ` (#${r.run_attempt})` : ''}</td>
          <td class="muted" title="${esc(r.created_at)}">${ago(r.run_started_at || r.created_at)}</td>
          <td class="mono">${fmtDur(runDur(r))}</td>
        </tr>`).join('')}</tbody>
    </table>
    <button class="load-more" id="more">Load more</button>`;
  list.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = `#/${state.repo}/run/${tr.dataset.id}`; }));
  document.getElementById('more').addEventListener('click', () => { state.page++; loadRuns(false); });
}

// ---------- run detail ----------
async function showRun(id, expandAll, myGen) {
  app.innerHTML = '<div class="empty">Loading…</div>';
  state.run = null;
  const show = res => {
    const first = !state.run;
    state.run = res;
    if (first) renderRunHead();
    else document.getElementById('run-badge').innerHTML = badge(stateOf(res.run));
    state.view.update(res);
  };
  const load = async () => {
    try {
      const res = await apiStream(`/api/runs/${id}`, partial => { if (myGen === gen && !state.run) show(partial); });
      if (myGen !== gen) return;
      show(res);
      if (res.run.status === 'completed') clearTimers();
    } catch (e) {
      if (myGen !== gen) return;
      if (state.run) state.view.error(e.message); else showError(e);
      clearTimers();
    }
  };
  const host = document.createElement('div');
  state.viewHost = host;
  state.view = GHRV.mount(host, { expandAll });
  await load();
  if (myGen !== gen) return;
  if (state.run && state.run.run.status !== 'completed') every(5000, load);
  every(1000, () => {
    const d = document.getElementById('run-dur');
    if (d && state.run) d.textContent = fmtDur(runDur(state.run.run));
  });
}

function renderRunHead() {
  const { run, workflow } = state.run;
  app.innerHTML = `
    <a class="back" href="#/${esc(state.repo)}">← runs</a>
    <div class="run-head">
      <span id="run-badge">${badge(stateOf(run))}</span>
      <h1>${esc(run.display_title)}</h1>
      <a href="${esc(run.html_url)}" target="_blank" rel="noopener">GitHub ↗</a>
    </div>
    <div class="run-meta">
      <span><b>${esc(run.name)}</b> <span class="mono">${esc(workflow.path)}</span></span>
      <span>branch <b class="mono">${esc(run.head_branch)}</b></span>
      <span>commit <a class="mono" href="https://github.com/${esc(state.repo)}/commit/${esc(run.head_sha)}" target="_blank" rel="noopener">${esc(run.head_sha.slice(0, 7))}</a></span>
      <span>by <b>${esc(run.actor?.login)}</b> via <b>${esc(run.event)}</b></span>
      <span>#${run.run_number}${run.run_attempt > 1 ? ` attempt ${run.run_attempt}` : ''}</span>
      <span>started <b>${ago(run.run_started_at || run.created_at)}</b></span>
      <span>duration <b class="mono" id="run-dur">${fmtDur(runDur(run))}</b></span>
    </div>
    <div id="view"></div>`;
  document.getElementById('view').replaceWith(state.viewHost);
}

route();
