// Tampermonkey shim: embeds the GHRV graph into github.com run pages, fed by the local ghrunview server.
(function () {
  'use strict';
  const gm = typeof GM_getValue === 'function';
  const server = () => ((gm && GM_getValue('server')) || GHRV_DEFAULT_SERVER).replace(/\/$/, '');
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Set ghrunview server URL', () => {
      const v = prompt('ghrunview server URL', server());
      if (v) { GM_setValue('server', v.trim()); teardown(); setup(); }
    });
  }

  // A copy of the renderer is bundled through @require. On top of that a fresh copy is fetched from
  // the server and evaluated when the sandbox allows eval (github.com's CSP forbids it in the page
  // context), so renderer changes show up on reload where possible and on update otherwise.
  const bundled = typeof GHRV !== 'undefined' ? GHRV : null;
  let evalBlocked = false;
  try { (0, eval)('1'); } catch { evalBlocked = true; }
  let renderer = null;
  function loadRenderer() {
    if (evalBlocked) return bundled ? Promise.resolve() : Promise.reject(new Error('renderer missing: reinstall the userscript'));
    return renderer ||= new Promise(resolve => {
      const fallback = () => { renderer = null; resolve(); };
      GM_xmlhttpRequest({
        method: 'GET', url: `${server()}/graph.js`, timeout: 20000,
        onload: r => {
          if (r.status < 200 || r.status >= 300) return fallback();
          try { (0, eval)(`${r.responseText}\n;window.GHRV = GHRV;`); } catch { /* keep the bundled copy */ }
          resolve();
        },
        onerror: fallback,
        ontimeout: fallback,
      });
    }).then(() => { if (typeof GHRV === 'undefined') throw new Error(`ghrunview server not reachable at ${server()} (start it with \`ghrunview\`)`); });
  }

  let current = null;
  const hideGH = () => !gm || GM_getValue('hideGitHubGraph', true);
  function applyHideGH() { document.documentElement.classList.toggle('ghrv-hide-gh', hideGH()); }

  function runInfo() {
    const m = location.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/);
    return m ? { repo: m[1], id: m[2], attempt: m[3] || '' } : null;
  }

  // request reads the server's two-line NDJSON answer progressively: the skeleton line goes to
  // onPartial as soon as it arrives, the promise resolves with the final line.
  function request(url, onPartial) {
    return new Promise((resolve, reject) => {
      let seen = 0, last = null, failed = null;
      const consume = (text, final) => {
        if (failed) return;
        let end;
        while ((end = text.indexOf('\n', seen)) >= 0 || (final && seen < text.length)) {
          const line = end >= 0 ? text.slice(seen, end) : text.slice(seen);
          seen = end >= 0 ? end + 1 : text.length;
          if (!line.trim()) continue;
          const obj = safeJSON(line);
          if (!obj) continue;
          if (obj.error) { failed = new Error(obj.error); return; }
          last = obj;
          if (obj.partial && onPartial) onPartial(obj);
        }
      };
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 60000,
        onprogress: r => { if (r.status >= 200 && r.status < 300 && typeof r.responseText === 'string') consume(r.responseText, false); },
        onload: r => {
          if (r.status < 200 || r.status >= 300) { const body = safeJSON(r.responseText); return reject(new Error((body && body.error) || `${r.status} ${r.statusText}`)); }
          consume(r.responseText, true);
          if (failed) return reject(failed);
          if (!last || last.partial) return reject(new Error('incomplete response from server'));
          resolve(last);
        },
        onerror: () => reject(new Error(`ghrunview server not reachable at ${server()} (start it with \`ghrunview\`)`)),
        ontimeout: () => reject(new Error('ghrunview server timed out')),
      });
    });
  }
  const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };

  function anchor() {
    const stats = document.querySelector('.actions-workflow-stats');
    if (stats) return { parent: stats.parentNode, before: stats.nextSibling };
    const content = document.querySelector('.PageLayout-content') || document.querySelector('main');
    return content ? { parent: content, before: content.firstChild } : null;
  }

  function teardown() {
    document.documentElement.classList.remove('ghrv-hide-gh');
    if (!current) return;
    clearInterval(current.timer);
    current.view.destroy();
    current.host.remove();
    current = null;
  }

  async function setup() {
    const info = runInfo();
    if (!info) { teardown(); return; }
    if (current && current.key === location.pathname && document.contains(current.host)) return;
    teardown();
    const a = anchor();
    if (!a) return;
    const host = document.createElement('div');
    host.id = 'ghrv-root';
    host.className = 'ghrv-github';
    a.parent.insertBefore(host, a.before);
    const placeholder = { key: location.pathname, host, view: { destroy() {}, update() {}, error() {} }, timer: null };
    current = placeholder;
    try {
      await loadRenderer();
    } catch (e) {
      if (current === placeholder) host.innerHTML = `<div class="ghrv-fail">${String(e.message).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`;
      return;
    }
    if (current !== placeholder) return;
    const view = GHRV.mount(host, {});
    const bar = host.querySelector('.ghrv-bar');
    const ghBtn = document.createElement('button');
    ghBtn.dataset.act = 'gh-graph';
    const labelGH = () => { ghBtn.textContent = hideGH() ? 'Show GitHub graph' : 'Hide GitHub graph'; };
    ghBtn.addEventListener('click', () => { if (gm) GM_setValue('hideGitHubGraph', !hideGH()); applyHideGH(); labelGH(); });
    labelGH();
    bar.appendChild(ghBtn);
    applyHideGH();
    const me = { key: location.pathname, host, view, timer: null };
    current = me;
    const url = `${server()}/api/runs/${info.id}?repo=${encodeURIComponent(info.repo)}${info.attempt ? `&attempt=${info.attempt}` : ''}`;
    let shown = false;
    const load = async () => {
      try {
        const data = await request(url, partial => { if (current === me && !shown) view.update(partial); });
        if (current !== me) return;
        shown = true;
        view.update(data);
        if (data.run.status === 'completed') clearInterval(me.timer);
      } catch (e) {
        if (current === me) view.error(e.message);
      }
    };
    await load();
    if (current === me) me.timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
  }

  const style = document.createElement('style');
  style.textContent = `
    .ghrv-github { margin: 0 0 16px; --panel: var(--bgColor-default); --panel2: var(--bgColor-muted); --border: var(--borderColor-default);
      --text: var(--fgColor-default); --muted: var(--fgColor-muted); --accent: var(--fgColor-accent); --success: var(--fgColor-success);
      --failure: var(--fgColor-danger); --running: var(--fgColor-attention); --queued: var(--fgColor-muted); --skipped: var(--fgColor-muted);
      --pending: var(--borderColor-default); --group-bg: var(--bgColor-inset); --head-bg: var(--bgColor-muted); --edge: var(--borderColor-emphasis);
      --ghrv-max-h: 85vh; --ghrv-min-h: 55vh; }
    .ghrv-fail { padding: 8px 12px; border: 1px solid var(--borderColor-attention-emphasis); border-radius: 6px; color: var(--fgColor-attention); font-size: 13px; }
    html.ghrv-hide-gh .js-updatable-content[data-url$="/graph_partial"], html.ghrv-hide-gh action-graph { display: none !important; }`;
  document.head.appendChild(style);

  document.addEventListener('turbo:load', setup);
  document.addEventListener('turbo:render', setup);
  window.addEventListener('popstate', () => setTimeout(setup, 200));
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) { last = location.href; setup(); }
    else if (current && !document.contains(current.host)) setup();
  }, 1000);
  setup();
})();
