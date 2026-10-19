'use strict';

// GHRV: shared run-graph renderer used by the standalone page and the userscript.
const GHRV = (() => {
  const SEP = '\u001f';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    success: '<svg class="ghrv-ico" viewBox="0 0 16 16"><path fill="currentColor" d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5z"/></svg>',
    failure: '<svg class="ghrv-ico" viewBox="0 0 16 16"><path fill="currentColor" d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zM5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22z"/></svg>',
    running: '<svg class="ghrv-ico ghrv-spin" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5h-1.5A5 5 0 1 1 8 3V1.5z"/></svg>',
    queued: '<svg class="ghrv-ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>',
    pending: '<svg class="ghrv-ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/></svg>',
    cancelled: '<svg class="ghrv-ico" viewBox="0 0 16 16"><path fill="currentColor" d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zM4.5 7.25a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-7z"/></svg>',
    skipped: '<svg class="ghrv-ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M10.5 5.5l-5 5 .7.7 5-5z"/></svg>',
    neutral: '<svg class="ghrv-ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  };
  const icon = s => ICONS[s] || ICONS.neutral;

  function stateOf(o) {
    if (!o) return 'pending';
    if (o.status === 'in_progress') return 'running';
    if (['queued', 'waiting', 'pending', 'requested'].includes(o.status)) return 'queued';
    switch (o.conclusion) {
      case 'success': return 'success';
      case 'failure': case 'timed_out': case 'action_required': case 'startup_failure': return 'failure';
      case 'cancelled': return 'cancelled';
      case 'skipped': return 'skipped';
    }
    return o.status === 'completed' ? 'neutral' : 'pending';
  }
  const badge = s => `<span class="ghrv-badge gs-${s}">${icon(s)}${esc(s)}</span>`;

  function fmtDur(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h === 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60, h = m / 60, d = h / 24;
    if (m < 60) return `${Math.floor(m)}m ago`;
    if (h < 24) return `${Math.floor(h)}h ago`;
    if (d < 30) return `${Math.floor(d)}d ago`;
    return new Date(iso).toLocaleDateString();
  }
  function span(started, completed) {
    if (!started) return null;
    return (completed ? new Date(completed) : new Date()) - new Date(started);
  }
  function runDur(r) {
    return span(r.run_started_at || r.created_at, r.status === 'completed' ? r.updated_at : null);
  }
  function nodeDurOf(jobs) {
    let start = null, end = null, open = false;
    for (const j of jobs) {
      if (!j.started_at) continue;
      const s = new Date(j.started_at);
      if (!start || s < start) start = s;
      if (j.completed_at) { const e = new Date(j.completed_at); if (!end || e > end) end = e; } else open = true;
    }
    if (!start) return null;
    return (open || !end ? new Date() : end) - start;
  }
  function* walk(nodes, parent = '') {
    for (const n of nodes) {
      const path = parent + SEP + n.id;
      yield { n, path };
      if (n.children) yield* walk(n.children, path);
    }
  }
  function allJobs(n, out = []) { out.push(...n.jobs); (n.children || []).forEach(c => allJobs(c, out)); return out; }
  const lastSeg = name => { const i = name.lastIndexOf(' / '); return i < 0 ? name : name.slice(i + 3); };

  // ---------- layout ----------
  const W = 230, H = 56, GX = 64, GY = 16, GH = 34, GP = 14, ROW = 22, PAD = 24, DGAP = 8, DH = 4, RAD = 6, CH_IN = 10, CH_OUT = 26;

  function measure(n, path, ctx) {
    if (n.children?.length && ctx.expanded.has(path)) {
      const inner = layoutGraph(n.children, path, 0, ctx);
      return { w: Math.max(W + 40, inner.width + 2 * GP), h: GH + inner.height + GP, inner };
    }
    if (!n.children?.length && n.jobs.length > 1) return { w: W, h: GH + n.jobs.length * ROW + 8 };
    return { w: W, h: H };
  }

  // layoutGraph lays out one level. Geometry depends only on ids, needs and child sizes, so finished
  // levels are cached in ctx.cache and re-bound to the current node objects on later renders.
  function layoutGraph(nodes, parentPath, pad, ctx) {
    const meas = nodes.map(n => { const path = parentPath + SEP + n.id; return { n, path, ...measure(n, path, ctx) }; });
    const key = `${parentPath}|${pad}|${meas.map(m => `${m.n.id}:${m.w}x${m.h}:${m.n.needs.join('+')}`).join(',')}`;
    const hit = ctx.cache.get(key);
    if (hit) {
      hit.items.forEach((it, i) => { it.n = meas[i].n; it.inner = meas[i].inner; });
      return hit;
    }
    const lay = layoutLevel(meas, pad);
    if (ctx.cache.size > 300) ctx.cache.clear();
    ctx.cache.set(key, lay);
    return lay;
  }

  function layoutLevel(meas, pad) {
    const items = meas.map(m => ({ ...m, id: m.n.id, preds: [], succs: [] }));
    const byId = new Map(items.map(it => [it.id, it]));
    const rank = (it, stack) => {
      if (it.rank != null) return it.rank;
      if (stack.has(it)) return 0;
      stack.add(it);
      let v = 0;
      for (const d of it.n.needs) if (byId.has(d)) v = Math.max(v, rank(byId.get(d), stack) + 1);
      stack.delete(it);
      it.rank = v;
      return v;
    };
    items.forEach(it => rank(it, new Set()));
    const cols = [];
    for (const it of items) (cols[it.rank] ||= []).push(it);
    for (let k = 0; k < cols.length; k++) cols[k] ||= [];

    const edges = [];
    let dn = 0;
    for (const it of items) for (const d of it.n.needs) {
      const src = byId.get(d);
      if (!src || src.rank >= it.rank) continue;
      const chain = [src];
      for (let k = src.rank + 1; k < it.rank; k++) {
        const dm = { dummy: true, id: '__d' + dn++, rank: k, w: 0, h: DH, preds: [], succs: [] };
        cols[k].push(dm);
        chain.push(dm);
      }
      chain.push(it);
      for (let i = 1; i < chain.length; i++) { chain[i].preds.push(chain[i - 1]); chain[i - 1].succs.push(chain[i]); }
      edges.push({ src, dst: it, chain });
    }

    const setPos = col => col.forEach((it, i) => it.pos = i);
    cols.forEach(setPos);
    const sweep = down => {
      const ks = down ? cols.map((_, k) => k).slice(1) : cols.map((_, k) => k).slice(0, -1).reverse();
      for (const k of ks) {
        cols[k] = cols[k].map(it => {
          const refs = (down ? it.preds : it.succs).map(p => p.pos);
          return { it, b: refs.length ? refs.reduce((a, c) => a + c, 0) / refs.length : it.pos };
        }).sort((a, b) => a.b - b.b || a.it.pos - b.it.pos).map(x => x.it);
        setPos(cols[k]);
      }
    };
    sweep(true); sweep(false); sweep(true);
    // Sugiyama transpose: swap neighbours within a column while that lowers crossings with adjacent columns.
    const between2 = (left, right) => {
      const es = [];
      for (const r of right) for (const p of r.preds) es.push([p.pos, r.pos]);
      let c = 0;
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) c++;
      return c;
    };
    const around = k => (k > 0 ? between2(cols[k - 1], cols[k]) : 0) + (k + 1 < cols.length ? between2(cols[k], cols[k + 1]) : 0);
    for (let guard = 0, improved = true; improved && guard < 10; guard++) {
      improved = false;
      for (let k = 0; k < cols.length; k++) {
        const col = cols[k];
        for (let i = 0; i + 1 < col.length; i++) {
          const before = around(k);
          [col[i], col[i + 1]] = [col[i + 1], col[i]];
          setPos(col);
          if (around(k) < before) improved = true;
          else { [col[i], col[i + 1]] = [col[i + 1], col[i]]; setPos(col); }
        }
      }
    }

    const colW = cols.map(c => Math.max(0, ...c.map(it => it.w)));
    const gapSegs = cols.map(() => []);
    for (const e of edges) for (let i = 1; i < e.chain.length; i++) gapSegs[e.chain[i - 1].rank].push([e.chain[i - 1], e.chain[i]]);
    const gapW = cols.map((_, k) => k === cols.length - 1 ? 0 : Math.max(GX, 10 * (gapSegs[k].length + 1) + CH_IN + CH_OUT));
    const portY = it => it.dummy ? it.y + it.h / 2 : it.y + (it.inner ? GH / 2 : it.h / 2);
    let width = 0, height = 0;

    // place stacks each column, assigns channels and builds edge polylines; returns the geometric crossing count.
    function place() {
      const colH = cols.map(c => c.reduce((a, it, i) => a + it.h + (i ? (it.dummy && c[i - 1].dummy ? DGAP : GY) : 0), 0));
      height = Math.max(0, ...colH);
      let x = pad;
      cols.forEach((col, k) => {
        let y = pad + (height - colH[k]) / 2;
        col.forEach((it, i) => { if (i) y += it.dummy && col[i - 1].dummy ? DGAP : GY; it.x = x; it.y = y; y += it.h; });
        x += colW[k] + gapW[k];
      });
      width = x;
      cols.forEach((col, k) => {
        const segs = gapSegs[k].map(([a, b]) => ({ a, b, ay: portY(a), by: portY(b) }));
        segs.sort((p, q) => p.ay - q.ay || p.by - q.by);
        orderChannels(segs);
        const x0 = col.length ? col[0].x + colW[k] : 0;
        segs.forEach((sg, i) => {
          sg.cx = x0 + CH_IN + (gapW[k] - CH_IN - CH_OUT) * (i + 1) / (segs.length + 1);
          sg.a.chx ||= new Map();
          sg.a.chx.set(sg.b, sg.cx);
        });
      });
      const hs = [], vs = [];
      for (const e of edges) {
        const c = e.chain, pts = [[c[0].x + c[0].w, portY(c[0])]];
        for (let i = 1; i < c.length; i++) {
          const cx = c[i - 1].chx.get(c[i]);
          pts.push([cx, portY(c[i - 1])], [cx, portY(c[i])]);
        }
        pts.push([c[c.length - 1].x, portY(c[c.length - 1])]);
        e.pts = simplify(pts);
        for (let i = 1; i < e.pts.length; i++) {
          const p = e.pts[i - 1], q = e.pts[i];
          if (p[1] === q[1]) hs.push([e, Math.min(p[0], q[0]) + 0.5, Math.max(p[0], q[0]) - 0.5, p[1]]);
          else vs.push([e, p[0], Math.min(p[1], q[1]) + 0.5, Math.max(p[1], q[1]) - 0.5]);
        }
      }
      let n = 0;
      for (const h of hs) for (const v of vs) if (h[0] !== v[0] && v[1] > h[1] && v[1] < h[2] && h[3] > v[2] && h[3] < v[3]) n++;
      return n;
    }

    // Geometric refinement: move any row to any other slot in its column while the routed drawing has fewer crossings.
    let best = place();
    const t0 = performance.now();
    const inBudget = () => performance.now() - t0 < 30;
    for (let guard = 0, improved = true; improved && best > 0 && items.length <= 24 && inBudget() && guard < 8; guard++) {
      improved = false;
      scan: for (let k = 0; k < cols.length; k++) {
        const col = cols[k];
        for (let i = 0; i < col.length; i++) {
          for (let j = 0; j < col.length; j++) {
            if (i === j) continue;
            if (!inBudget()) break scan;
            const [it] = col.splice(i, 1);
            col.splice(j, 0, it);
            const n = place();
            if (n < best) { best = n; improved = true; i = -1; break; }
            col.splice(j, 1);
            col.splice(i, 0, it);
          }
        }
      }
    }
    // A rejected trial restores the order but not the geometry, so always re-place at the end.
    best = place();
    cols.forEach(setPos);
    return { items, edges, width: width + pad, height: height + 2 * pad, crossings: best };
  }

  // Two segments in one gap cross when the left one's exit row cuts the right one's vertical, or the
  // right one's entry row cuts the left one's vertical. Costs are pairwise, so adjacent swaps settle it.
  const between = (y, p, q) => y > Math.min(p, q) + 0.5 && y < Math.max(p, q) - 0.5;
  const crosses = (l, r) => (between(l.by, r.ay, r.by) ? 1 : 0) + (between(r.ay, l.ay, l.by) ? 1 : 0);
  function orderChannels(segs) {
    const m = segs.length;
    if (m < 2) return;
    const C = segs.map(a => segs.map(b => (a === b ? 0 : crosses(a, b))));
    let order = segs.map((_, i) => i);
    const total = () => { let c = 0; for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) c += C[order[i]][order[j]]; return c; };
    let best = total();
    for (let round = 0; round < m && best > 0; round++) {
      let bestDelta = 0, bi = -1, bj = -1;
      for (let i = 0; i < m; i++) {
        const sId = order[i];
        let d = 0;
        for (let j = i + 1; j < m; j++) {            // move s rightwards past order[j]
          const k = order[j];
          d += C[k][sId] - C[sId][k];
          if (d < bestDelta) { bestDelta = d; bi = i; bj = j; }
        }
        d = 0;
        for (let j = i - 1; j >= 0; j--) {           // move s leftwards past order[j]
          const k = order[j];
          d += C[sId][k] - C[k][sId];
          if (d < bestDelta) { bestDelta = d; bi = i; bj = j; }
        }
      }
      if (bi < 0) break;
      const [sId] = order.splice(bi, 1);
      order.splice(bj, 0, sId);
      best += bestDelta;
    }
    const sorted = order.map(i => segs[i]);
    for (let i = 0; i < m; i++) segs[i] = sorted[i];
  }

  function simplify(pts) {
    const out = [];
    for (const p of pts) {
      if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < .01 && Math.abs(out[out.length - 1][1] - p[1]) < .01) continue;
      if (out.length >= 2) {
        const [a, b] = out.slice(-2);
        if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) { out[out.length - 1] = p; continue; }
      }
      out.push(p);
    }
    return out;
  }

  function roundedPath(pts) {
    if (pts.length < 2) return '';
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
      const r = Math.min(RAD, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
      const ux = Math.sign(cx - px), uy = Math.sign(cy - py), vx = Math.sign(nx - cx), vy = Math.sign(ny - cy);
      d += ` L${cx - ux * r},${cy - uy * r} Q${cx},${cy} ${cx + vx * r},${cy + vy * r}`;
    }
    const [lx, ly] = pts[pts.length - 1];
    return d + ` L${lx - 1},${ly}`;
  }

  // matrixParts splits a matrix node's label "Wait for Scalr (*)" into the shared base and a per-job value extractor.
  function matrixParts(n) {
    const tpl = n.label.includes('*') ? n.label : (n.via || []).find(v => v.includes('*')) || n.label;
    const star = tpl.indexOf('*');
    const pre = star >= 0 ? tpl.slice(0, star) : tpl + ' (';
    const post = star >= 0 ? tpl.slice(star + 1) : ')';
    const base = tpl === n.label ? (pre + post).replace(/\s*\(\s*\)\s*$/, '').trim() : n.label;
    const value = j => {
      const seg = lastSeg(j.name);
      return seg.startsWith(pre) && seg.endsWith(post) && seg.length > pre.length + post.length ? seg.slice(pre.length, seg.length - post.length) : seg;
    };
    return { base, value };
  }

  // strip draws the 5px status bar clipped to the box's 8px rounded left corners.
  const strip = h => `<path class="ghrv-strip" d="M5,0.58 A8,8 0 0 0 0,8 V${h - 8} A8,8 0 0 0 5,${h - 0.58} Z"/>`;

  // Labels are clipped by measured pixel width in the UI font, not by character count.
  const measureCtx = document.createElement('canvas').getContext('2d');
  let fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
  const widthCache = new Map();
  function textWidth(text, px) {
    const key = `${px}|${text}`;
    let w = widthCache.get(key);
    if (w == null) {
      measureCtx.font = `${px}px ${fontFamily}`;
      w = measureCtx.measureText(text).width;
      if (widthCache.size > 5000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  }
  function fitText(text, maxPx, px) {
    if (textWidth(text, px) <= maxPx) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (textWidth(text.slice(0, mid) + '…', px) <= maxPx) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo).trimEnd() + '…';
  }

  // lbl renders a label fitted to maxPx; the full text is kept in data-full for the hover expansion.
  const lbl = (x, y, text, maxPx, cls = '') => {
    const c = fitText(text, maxPx, cls === 'ghrv-row' ? 12 : 13);
    return `<text${cls ? ` class="${cls}"` : ''} x="${x}" y="${y}"${c !== text ? ` data-full="${esc(text)}"` : ''}>${esc(c)}</text>`;
  };

  const svgIcon = (s, x, y) => `<g class="ghrv-st gs-${s}" transform="translate(${x},${y})">${icon(s).replace('class="ghrv-ico', 'width="16" height="16" class="ghrv-ico')}</g>`;

  // jobLink draws a 12px link-external icon at (x, y) that opens the job's log on GitHub.
  const LINK_W = 18;
  const jobLink = (j, x, y) => j.html_url ? `<a class="ghrv-link" href="${esc(j.html_url)}" target="_blank" rel="noopener" transform="translate(${x},${y})"><title>Open job log</title><rect x="-4" y="-4" width="20" height="20"/><path transform="scale(.75)" d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></a>` : '';

  const STYLE = `
.ghrv { --p: var(--panel, #161b22); --p2: var(--panel2, #1c2129); --b: var(--border, #30363d); --t: var(--text, #e6edf3); --m: var(--muted, #8b949e);
  --a: var(--accent, #58a6ff); --ok: var(--success, #3fb950); --bad: var(--failure, #f85149); --run: var(--running, #d29922); --q: var(--queued, #8b949e);
  --skip: var(--skipped, #6e7681); --pend: var(--pending, #484f58); --gbg: var(--group-bg, rgba(255,255,255,.025)); --hbg: var(--head-bg, rgba(255,255,255,.04));
  --f: var(--font, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif); --fm: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--t); font: 14px/1.4 var(--f); }
.ghrv *, .ghrv *::before, .ghrv *::after { box-sizing: border-box; }
.ghrv a { color: var(--a); text-decoration: none; }
.ghrv a:hover { text-decoration: underline; }
.ghrv button { font: inherit; font-size: 12px; color: var(--t); background: var(--p2); border: 1px solid var(--b); border-radius: 6px; padding: 2px 8px; cursor: pointer; line-height: 1.4; }
.ghrv button:hover { border-color: var(--m); }
.ghrv .ghrv-mono { font-family: var(--fm); font-size: 12px; }
.ghrv .ghrv-muted { color: var(--m); }
.ghrv .ghrv-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.ghrv .ghrv-bar .ghrv-spacer { flex: 1; }
.ghrv .ghrv-layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: start; }
.ghrv .ghrv-dag { background: var(--p); border: 1px solid var(--b); border-radius: 8px; overflow: hidden; max-height: var(--ghrv-max-h, calc(100vh - 190px)); min-height: var(--ghrv-min-h, 420px); height: 420px; display: flex; flex-direction: column; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.ghrv .ghrv-dag.ghrv-dragging { cursor: grabbing; }
.ghrv .ghrv-svg { flex: 1; min-height: 0; position: relative; }
.ghrv .ghrv-hint { position: absolute; right: 10px; bottom: 6px; font-size: 11px; color: var(--m); opacity: .7; pointer-events: none; }
.ghrv .ghrv-caption { position: absolute; left: 10px; top: 8px; padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--p) 85%, transparent); pointer-events: none; line-height: 1.35; }
.ghrv .ghrv-caption b { font-size: 15px; font-weight: 600; color: var(--t); }
.ghrv .ghrv-caption a { color: var(--t); pointer-events: auto; }
.ghrv .ghrv-caption div { font-size: 13px; color: var(--m); }
.ghrv .ghrv-dag { position: relative; }
.ghrv .ghrv-dag svg { display: block; width: 100%; height: 100%; }
.ghrv .ghrv-warn { padding: 8px 12px; color: var(--run); font-size: 12px; border-bottom: 1px solid var(--b); }
.ghrv .ghrv-warn.ghrv-note { color: var(--m); }
.ghrv .ghrv-side { background: var(--p); border: 1px solid var(--b); border-radius: 8px; padding: 14px; overflow: auto; overscroll-behavior: contain; }
.ghrv .ghrv-side h2 { font-size: 15px; font-weight: 600; margin: 0 0 6px; word-break: break-word; display: flex; align-items: center; gap: 6px; }
.ghrv .ghrv-side .ghrv-kv { color: var(--m); font-size: 12px; margin-bottom: 10px; }
.ghrv .ghrv-side .ghrv-kv code { font-family: var(--fm); color: var(--t); background: none; padding: 0; }
.ghrv .ghrv-job { border-top: 1px solid var(--b); padding: 10px 0; }
.ghrv .ghrv-job-head { display: flex; align-items: center; gap: 8px; font-weight: 600; min-width: 0; }
.ghrv .ghrv-job-head > a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghrv .ghrv-job-head .ghrv-dur { margin-left: auto; color: var(--m); font-weight: 400; font-family: var(--fm); font-size: 12px; }
.ghrv .ghrv-job-sub { color: var(--m); font-size: 12px; margin: 2px 0 6px 22px; }
.ghrv .ghrv-steps { list-style: none; margin: 0; padding: 0 0 0 4px; }
.ghrv .ghrv-steps li { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 13px; }
.ghrv .ghrv-steps li > span:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghrv .ghrv-steps li .ghrv-dur { margin-left: auto; color: var(--m); font-family: var(--fm); font-size: 12px; }
.ghrv .ghrv-steps li.gs-skipped { color: var(--skip); }
.ghrv .ghrv-empty { color: var(--m); padding: 40px; text-align: center; }
.ghrv .ghrv-warn-text { color: var(--run); }
.ghrv .ghrv-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid; }
.ghrv .ghrv-badge.gs-success { color: var(--ok); border-color: var(--ok); }
.ghrv .ghrv-badge.gs-failure { color: var(--bad); border-color: var(--bad); }
.ghrv .ghrv-badge.gs-running { color: var(--run); border-color: var(--run); }
.ghrv .ghrv-badge.gs-queued, .ghrv .ghrv-badge.gs-cancelled, .ghrv .ghrv-badge.gs-neutral { color: var(--q); border-color: var(--q); }
.ghrv .ghrv-badge.gs-skipped, .ghrv .ghrv-badge.gs-pending { color: var(--skip); border-color: var(--skip); }
.ghrv .ghrv-ico { width: 14px; height: 14px; flex: none; }
.ghrv .ghrv-ico.ghrv-spin { animation: ghrv-spin 1.2s linear infinite; transform-box: fill-box; transform-origin: center; }
@keyframes ghrv-spin { to { transform: rotate(360deg); } }
.ghrv .ghrv-node { cursor: pointer; }
.ghrv .ghrv-node > rect.ghrv-box { fill: var(--p2); stroke: none; rx: 8; }
.ghrv .ghrv-node.ghrv-group > rect.ghrv-box { fill: var(--gbg); }
.ghrv .ghrv-node > rect.ghrv-head { fill: var(--hbg); rx: 8; pointer-events: none; }
.ghrv .ghrv-node > rect.ghrv-outline { fill: none; stroke: var(--b); stroke-width: 1; rx: 8; pointer-events: none; }
.ghrv .ghrv-node.ghrv-nb > rect.ghrv-outline { stroke: var(--t); }
.ghrv .ghrv-node.ghrv-nb-sel > rect.ghrv-outline { stroke: var(--a); }
.ghrv .ghrv-node.ghrv-selected > rect.ghrv-outline { stroke: var(--a); stroke-width: 2.5; }
.ghrv .ghrv-node.ghrv-hov > rect.ghrv-outline { stroke: var(--t); stroke-width: 2.5; }
.ghrv .ghrv-node.gs-pending > rect.ghrv-outline, .ghrv .ghrv-node.gs-skipped > rect.ghrv-outline { stroke-dasharray: 4 3; }
.ghrv .ghrv-node text { fill: var(--t); font-family: var(--f); font-size: 13px; pointer-events: none; }
.ghrv .ghrv-node text.ghrv-sub { fill: var(--m); font-size: 11px; font-family: var(--fm); }
.ghrv .ghrv-node text.ghrv-tb { fill: var(--m); font-size: 11px; }
.ghrv .ghrv-node text.ghrv-row { font-size: 12px; }
.ghrv .ghrv-node text.ghrv-chev { fill: var(--m); font-size: 13px; }
.ghrv .ghrv-link { color: var(--m); }
.ghrv .ghrv-link:hover { color: var(--a); }
.ghrv .ghrv-link rect { fill: transparent; }
.ghrv .ghrv-link path { fill: currentColor; }
.ghrv .gs-success > .ghrv-strip { fill: var(--ok); }
.ghrv .gs-failure > .ghrv-strip { fill: var(--bad); }
.ghrv .gs-running > .ghrv-strip { fill: var(--run); }
.ghrv .gs-queued > .ghrv-strip, .ghrv .gs-cancelled > .ghrv-strip, .ghrv .gs-neutral > .ghrv-strip { fill: var(--q); }
.ghrv .gs-skipped > .ghrv-strip, .ghrv .gs-pending > .ghrv-strip { fill: var(--pend); }
.ghrv .ghrv-st { color: var(--m); }
.ghrv .ghrv-st.gs-success { color: var(--ok); }
.ghrv .ghrv-st.gs-failure { color: var(--bad); }
.ghrv .ghrv-st.gs-running { color: var(--run); }
.ghrv .ghrv-st.gs-skipped, .ghrv .ghrv-st.gs-pending { color: var(--skip); }
.ghrv .ghrv-edge { fill: none; stroke: var(--edge, #4b5563); stroke-width: 1.6; marker-end: url(#ghrv-arrow); pointer-events: none; }
.ghrv .ghrv-edge.ghrv-sel { stroke: var(--a); stroke-width: 2.2; marker-end: url(#ghrv-arrow-sel); }
.ghrv .ghrv-edge.ghrv-hover { stroke: var(--t); stroke-width: 2.2; marker-end: url(#ghrv-arrow-hover); }
.ghrv marker.ghrv-m path { fill: var(--edge, #4b5563); }
.ghrv .ghrv-tip { pointer-events: none; }
.ghrv .ghrv-tip text { fill: var(--t); font-family: var(--f); font-size: 13px; paint-order: stroke; stroke: var(--p2); stroke-width: 5px; stroke-linejoin: round; }
.ghrv .ghrv-tip text.ghrv-row { font-size: 12px; }
.ghrv marker.ghrv-m.ghrv-sel path { fill: var(--a); }
.ghrv marker.ghrv-m.ghrv-hover path { fill: var(--t); }
@media (max-width: 1000px) { .ghrv .ghrv-layout { grid-template-columns: 1fr; } .ghrv .ghrv-side { height: auto !important; max-height: 50vh; } }
`;

  function injectCSS(doc) {
    if (doc.getElementById('ghrv-style')) return;
    const st = doc.createElement('style');
    st.id = 'ghrv-style';
    st.textContent = STYLE;
    doc.head.appendChild(st);
  }

  // mount renders a run graph into host and returns {update, error, destroy, fit, expandAll, collapseAll}.
  function mount(host, opts = {}) {
    injectCSS(host.ownerDocument);
    host.classList.add('ghrv');
    fontFamily = getComputedStyle(host).fontFamily || fontFamily;
    host.innerHTML = `
      <div class="ghrv-bar">
        <span class="ghrv-title"></span>
        <span class="ghrv-spacer"></span>
        <button data-act="expand">Expand all</button>
        <button data-act="collapse">Collapse all</button>
        <button data-act="zoom-out" title="zoom out">−</button>
        <span class="ghrv-mono ghrv-zoom">100%</span>
        <button data-act="zoom-in" title="zoom in">+</button>
        <button data-act="fit">Fit</button>
      </div>
      <div class="ghrv-layout">
        <div class="ghrv-dag"><div class="ghrv-warn" hidden></div><div class="ghrv-svg"><div class="ghrv-empty">Loading…</div></div><div class="ghrv-caption" hidden></div><div class="ghrv-hint">ghrunview · scroll pans · ⌘/ctrl+scroll zooms · double-click fits</div></div>
        <aside class="ghrv-side"></aside>
      </div>`;
    const $ = sel => host.querySelector(sel);
    // Jobs that were not re-run keep their timestamps from an earlier attempt; durations only count
    // jobs of the current attempt when the run has any, and such jobs are flagged in the side panel.
    let runStart = null;
    const inAttempt = j => !runStart || !j.started_at || new Date(j.started_at) >= runStart;
    const attemptJobs = jobs => { const cur = jobs.filter(inAttempt); return cur.length ? cur : jobs; };
    const nodeDur = n => nodeDurOf(attemptJobs(n.jobs));
    const subtreeDur = n => nodeDurOf(attemptJobs(allJobs(n)));
    const st = { data: null, selected: null, expanded: new Set(), cache: new Map(), zoom: 1, tx: 0, ty: 0, autoFit: true, lay: null, hovered: null, dragged: false, details: new Map(), loading: new Set() };

    const findNode = path => { for (const x of walk(st.data.nodes)) if (x.path === path) return x.n; return null; };
    const findJob = id => { for (const { n } of walk(st.data.nodes)) for (const j of n.jobs) if (j.id === id) return j; return null; };
    const nodeEl = path => { for (const el of host.querySelectorAll('.ghrv-node')) if (el.dataset.path === path) return el; return null; };
    const expandAncestors = path => { const parts = path.split(SEP); for (let i = 2; i < parts.length; i++) st.expanded.add(parts.slice(0, i).join(SEP)); };

    function renderLevel(lay) {
      const sel = st.selected, nb = new Set();
      const edges = lay.edges.map(e => {
        const isSel = e.src.path === sel || e.dst.path === sel;
        if (isSel) nb.add(e.src.path === sel ? e.dst.path : e.src.path);
        return `<path class="ghrv-edge${isSel ? ' ghrv-sel' : ''}" data-src="${esc(e.src.path)}" data-dst="${esc(e.dst.path)}" d="${roundedPath(e.pts)}"/>`;
      });
      const boxes = lay.items.map(it => {
        const n = it.n, cls = `ghrv-node gs-${n.state}${it.path === sel ? ' ghrv-selected' : ''}${nb.has(it.path) ? ' ghrv-nb-sel' : ''}`;
        const title = '';
        if (it.inner) {
          const jobs = allJobs(n).length, dur = fmtDur(subtreeDur(n)), durX = it.w - 30, showJobs = it.w >= 340;
          let right = durX - dur.length * 7 - 14;
          if (showJobs) right -= String(jobs).length * 7 + 36;
          return `<g class="${cls} ghrv-group ghrv-open" data-path="${esc(it.path)}" transform="translate(${it.x},${it.y})">${title}
            <rect class="ghrv-box" width="${it.w}" height="${it.h}"/><rect class="ghrv-head" width="${it.w}" height="${GH}"/>${strip(it.h)}<rect class="ghrv-outline" width="${it.w}" height="${it.h}"/>
            ${svgIcon(n.state, 14, 9)}
            ${lbl(38, 22, n.label, right - 44)}
            ${showJobs ? `<text class="ghrv-tb" x="${durX - dur.length * 7 - 14}" y="22" text-anchor="end">${jobs} job${jobs === 1 ? '' : 's'}</text>` : ''}
            <text class="ghrv-sub" x="${durX}" y="22" text-anchor="end" data-dur="${esc(it.path)}">${dur}</text>
            <text class="ghrv-chev" x="${it.w - 12}" y="22" text-anchor="end">▾</text>
            <g class="ghrv-inner" transform="translate(${GP},${GH})">${renderLevel(it.inner)}</g>
          </g>`;
        }
        if (n.children?.length) {
          const jobs = allJobs(n).length;
          return `<g class="${cls} ghrv-group" data-path="${esc(it.path)}" transform="translate(${it.x},${it.y})">${title}
            <rect class="ghrv-box" width="${it.w}" height="${it.h}"/>${strip(it.h)}<rect class="ghrv-outline" width="${it.w}" height="${it.h}"/>
            ${svgIcon(n.state, 14, 11)}
            ${lbl(38, 24, n.label, W - 66)}
            <text class="ghrv-sub" x="38" y="43" data-dur="${esc(it.path)}">${fmtDur(subtreeDur(n))}</text>
            <text class="ghrv-tb" x="${W - 30}" y="43" text-anchor="end">${jobs} job${jobs === 1 ? '' : 's'}</text>
            <text class="ghrv-chev" x="${W - 12}" y="35" text-anchor="end">▸</text>
          </g>`;
        }
        if (n.jobs.length > 1) {
          const { base, value } = matrixParts(n);
          const rows = n.jobs.map((j, i) => {
            const s = stateOf(j), y = GH + 4 + i * ROW, lw = j.html_url ? LINK_W : 0;
            return `${svgIcon(s, 14, y + 3)}${lbl(38, y + 15, value(j), W - 56 - lw - textWidth(fmtDur(span(j.started_at, j.completed_at)), 11), 'ghrv-row')}<text class="ghrv-sub" x="${W - 10 - lw}" y="${y + 15}" text-anchor="end" data-job-dur="${j.id}">${fmtDur(span(j.started_at, j.completed_at))}</text>${jobLink(j, W - 22, y + 5)}`;
          }).join('');
          return `<g class="${cls} ghrv-leaf" data-path="${esc(it.path)}" transform="translate(${it.x},${it.y})">${title}
            <rect class="ghrv-box" width="${it.w}" height="${it.h}"/><rect class="ghrv-head" width="${it.w}" height="${GH}"/>${strip(it.h)}<rect class="ghrv-outline" width="${it.w}" height="${it.h}"/>
            ${svgIcon(n.state, 14, 9)}
            ${lbl(38, 22, base, W - 56 - textWidth(`×${n.jobs.length}`, 11))}
            <text class="ghrv-tb" x="${W - 10}" y="22" text-anchor="end">×${n.jobs.length}</text>
            ${rows}
          </g>`;
        }
        const extra = n.reusable && !n.jobs.length ? 'no jobs' : n.jobs.length === 0 ? 'pending' : '';
        const link = n.jobs.length ? jobLink(n.jobs[0], W - 22, 13) : '';
        return `<g class="${cls} ghrv-leaf" data-path="${esc(it.path)}" transform="translate(${it.x},${it.y})">${title}
          <rect class="ghrv-box" width="${it.w}" height="${it.h}"/>${strip(it.h)}<rect class="ghrv-outline" width="${it.w}" height="${it.h}"/>
          ${svgIcon(n.state, 14, 11)}
          ${lbl(38, 24, n.label, W - 48 - (link ? LINK_W : 0))}
          ${link}
          <text class="ghrv-sub" x="38" y="43" data-dur="${esc(it.path)}">${fmtDur(nodeDur(n))}</text>
          ${extra ? `<text class="ghrv-tb" x="${W - 10}" y="43" text-anchor="end">${esc(extra)}</text>` : ''}
        </g>`;
      });
      return boxes.join('') + edges.join('');
    }

    // After a short hover, truncated labels of the hovered box are shown in full in an overlay that
    // lives inside the viewport group, so it pans and zooms with the graph.
    const SVGNS = 'http://www.w3.org/2000/svg';
    let tipTimer = 0;
    function clearTips() {
      clearTimeout(tipTimer);
      tipTimer = 0;
      host.querySelectorAll('.ghrv-tip').forEach(el => el.remove());
    }
    function showTips(path) {
      const g = nodeEl(path), vp = $('.ghrv-svg svg .ghrv-vp');
      if (!g || !vp) return;
      for (const t of g.querySelectorAll(':scope > text[data-full]')) {
        const m = vp.getScreenCTM().inverse().multiply(t.getScreenCTM());
        const tip = document.createElementNS(SVGNS, 'g');
        tip.setAttribute('class', 'ghrv-tip');
        tip.setAttribute('transform', `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`);
        const text = document.createElementNS(SVGNS, 'text');
        text.setAttribute('class', t.getAttribute('class') || '');
        text.setAttribute('x', t.getAttribute('x'));
        text.setAttribute('y', t.getAttribute('y'));
        text.textContent = t.dataset.full;
        tip.appendChild(text);
        vp.appendChild(tip);
      }
    }
    function setHover(path) {
      const svg = $('.ghrv-svg svg');
      if (!svg) return;
      svg.querySelectorAll('.ghrv-edge.ghrv-hover').forEach(el => el.classList.remove('ghrv-hover'));
      svg.querySelectorAll('.ghrv-node.ghrv-nb, .ghrv-node.ghrv-hov').forEach(el => el.classList.remove('ghrv-nb', 'ghrv-hov'));
      clearTips();
      st.hovered = path;
      if (!path) return;
      nodeEl(path)?.classList.add('ghrv-hov');
      tipTimer = setTimeout(() => { if (st.hovered === path) showTips(path); }, 400);
      for (const el of svg.querySelectorAll('.ghrv-edge')) {
        if (el.dataset.src !== path && el.dataset.dst !== path) continue;
        el.classList.add('ghrv-hover');
        el.parentNode.appendChild(el);
        const other = nodeEl(el.dataset.src === path ? el.dataset.dst : el.dataset.src);
        if (other) other.classList.add('ghrv-nb');
      }
    }
    function targetNode(e) {
      const g = e.target.closest('.ghrv-node');
      if (!g) return null;
      const inner = e.target.closest('.ghrv-inner');
      return inner && inner.parentElement === g ? null : g;
    }

    const ZMIN = 0.1, ZMAX = 3, FITMAX = 1.5;
    function applyTransform() {
      const vp = $('.ghrv-svg svg .ghrv-vp');
      if (vp) vp.setAttribute('transform', `translate(${st.tx.toFixed(2)},${st.ty.toFixed(2)}) scale(${st.zoom.toFixed(4)})`);
      $('.ghrv-zoom').textContent = `${Math.round(st.zoom * 100)}%${st.autoFit ? ' fit' : ''}`;
    }
    function viewSize() {
      const el = $('.ghrv-svg');
      return { w: el.clientWidth, h: el.clientHeight };
    }
    // zoomAt rescales around a point given in container pixels.
    function zoomAt(z, px, py) {
      z = Math.min(ZMAX, Math.max(ZMIN, z));
      st.tx = px - (px - st.tx) * (z / st.zoom);
      st.ty = py - (py - st.ty) * (z / st.zoom);
      st.zoom = z;
      applyTransform();
    }
    // fit scales the graph to the container and centres it.
    function fit() {
      st.autoFit = true;
      if (!st.lay || !$('.ghrv-svg')) return;
      const { w, h } = viewSize();
      const z = Math.min(FITMAX, Math.max(ZMIN, Math.min((w - 16) / st.lay.width, (h - 8) / st.lay.height)));
      st.zoom = z;
      st.tx = (w - st.lay.width * z) / 2;
      st.ty = (h - st.lay.height * z) / 2;
      applyTransform();
    }
    // sizeContainer gives the canvas the height the graph needs at width-fit zoom, within its max-height.
    function sizeContainer() {
      const dag = $('.ghrv-dag');
      const warnH = $('.ghrv-warn').hidden ? 0 : $('.ghrv-warn').offsetHeight;
      const cs = getComputedStyle(dag);
      const maxH = parseFloat(cs.maxHeight) || 700, minH = parseFloat(cs.minHeight) || 240;
      const fitW = Math.min(FITMAX, (dag.clientWidth - 16) / st.lay.width);
      dag.style.height = `${Math.min(maxH, Math.max(minH, st.lay.height * fitW + 8)) + warnH + 2}px`;
      $('.ghrv-side').style.height = dag.style.height;
    }
    // Late layout changes (fonts, host page reflow, side panel wrapping) must re-fit too.
    let fitRaf = 0;
    // visibleFraction is the share of the laid-out graph currently inside the canvas.
    function visibleFraction() {
      if (!st.lay) return 1;
      const { w, h } = viewSize();
      const gw = st.lay.width * st.zoom, gh = st.lay.height * st.zoom;
      const vx = Math.max(0, Math.min(w, st.tx + gw) - Math.max(0, st.tx));
      const vy = Math.max(0, Math.min(h, st.ty + gh) - Math.max(0, st.ty));
      return gw > 0 && gh > 0 ? (vx * vy) / (gw * gh) : 1;
    }
    const onResize = () => { if (st.autoFit && !fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fit(); }); };
    window.addEventListener('resize', onResize);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe($('.ghrv-svg'));

    const dag = $('.ghrv-dag');
    // A trackpad pinch arrives as a stream of ctrl+wheel (Chrome) or gesture (Safari) events whose
    // anchor follows the fingers, so panning the anchor's movement lets zoom and pan blend in one gesture.
    let pinch = null, gestureActive = false, gestureScale = 1;
    function pinchStep(factor, cx, cy) {
      const now = performance.now();
      if (pinch && now - pinch.t < 200) { st.tx += cx - pinch.x; st.ty += cy - pinch.y; }
      pinch = { x: cx, y: cy, t: now };
      st.autoFit = false;
      zoomAt(st.zoom * factor, cx, cy);
    }
    const local = e => { const r = $('.ghrv-svg').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    dag.addEventListener('wheel', e => {
      if (!st.lay) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewSize().h : 1;
      st.autoFit = false;
      if (e.ctrlKey || e.metaKey) {
        if (gestureActive) return;
        const d = Math.max(-50, Math.min(50, e.deltaY * unit));
        pinchStep(Math.exp(-d * 0.008), ...local(e));
        return;
      }
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      st.tx -= dx;
      st.ty -= dy;
      applyTransform();
    }, { passive: false });
    dag.addEventListener('gesturestart', e => { e.preventDefault(); gestureActive = true; gestureScale = 1; pinch = null; });
    dag.addEventListener('gesturechange', e => {
      e.preventDefault();
      if (!st.lay) return;
      pinchStep(e.scale / gestureScale, ...local(e));
      gestureScale = e.scale;
    });
    dag.addEventListener('gestureend', e => { e.preventDefault(); gestureActive = false; pinch = null; });
    let drag = null;
    dag.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.target.closest('.ghrv-svg')) return;
      // after a captured drag the click lands on the container, not the svg, so reset here
      st.dragged = false;
      drag = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: false, id: e.pointerId };
    });
    dag.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      // capture only once it is a drag, so plain clicks still reach the nodes
      if (!drag.moved) dag.setPointerCapture(drag.id);
      drag.moved = true;
      st.autoFit = false;
      st.tx = drag.tx + dx;
      st.ty = drag.ty + dy;
      dag.classList.add('ghrv-dragging');
      applyTransform();
    });
    const endDrag = e => {
      if (!drag) return;
      st.dragged = drag.moved;
      drag = null;
      dag.classList.remove('ghrv-dragging');
      if (e.pointerId != null && dag.hasPointerCapture(e.pointerId)) dag.releasePointerCapture(e.pointerId);
    };
    dag.addEventListener('pointerup', endDrag);
    dag.addEventListener('pointercancel', endDrag);
    dag.addEventListener('dblclick', e => { if (!e.target.closest('.ghrv-node')) fit(); });

    function renderGraph() {
      const hostSvg = $('.ghrv-svg');
      const nodes = st.data.nodes;
      if (!nodes.length) { hostSvg.innerHTML = '<div class="ghrv-empty">No jobs reported yet.</div>'; return; }
      const lay = layoutGraph(nodes, '', PAD, { expanded: st.expanded, cache: st.cache });
      st.lay = lay;
      const arrow = (id, cls) => `<marker id="${id}" class="${cls}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,1 L9,5 L0,9 z"/></marker>`;
      hostSvg.innerHTML = `<svg width="100%" height="100%"><defs>${arrow('ghrv-arrow', 'ghrv-m')}${arrow('ghrv-arrow-sel', 'ghrv-m ghrv-sel')}${arrow('ghrv-arrow-hover', 'ghrv-m ghrv-hover')}</defs><g class="ghrv-vp">${renderLevel(lay)}</g></svg>`;
      sizeContainer();
      if (st.autoFit) fit(); else applyTransform();
      const svg = hostSvg.querySelector('svg');
      st.hovered = null;
      svg.addEventListener('click', e => {
        if (st.dragged) { st.dragged = false; return; }
        if (e.target.closest('.ghrv-link')) return;
        const g = targetNode(e);
        if (!g) {
          if (st.selected) { st.selected = null; renderGraph(); renderSide(); }
          return;
        }
        const path = g.dataset.path;
        if (g.classList.contains('ghrv-group')) {
          if (st.expanded.has(path)) st.expanded.delete(path); else st.expanded.add(path);
          st.selected = path;
        } else {
          st.selected = st.selected === path ? null : path;
        }
        const before = g.getBoundingClientRect();
        renderGraph(); renderSide();
        const after = nodeEl(path)?.getBoundingClientRect();
        if (!st.autoFit && after) { st.tx += before.left - after.left; st.ty += before.top - after.top; applyTransform(); }
        if (!st.autoFit && visibleFraction() < 0.2) fit();
        if (st.selected) setHover(st.selected);
      });
      svg.addEventListener('mouseover', e => {
        const g = targetNode(e), path = g ? g.dataset.path : null;
        if (path !== st.hovered) setHover(path);
      });
      svg.addEventListener('mouseleave', () => setHover(null));
    }

    function renderSide() {
      const side = $('.ghrv-side');
      const nodes = st.data.nodes;
      const n = st.selected ? findNode(st.selected) : null;
      const list = (ns, parent) => ns.map(x => `<div class="ghrv-job"><div class="ghrv-job-head" data-select="${esc(parent + SEP + x.id)}" style="cursor:pointer">${icon(x.state)} ${esc(x.label)}<span class="ghrv-dur">${fmtDur(subtreeDur(x))}</span></div></div>`).join('');
      if (!n) {
        const counts = {};
        for (const { n: x } of walk(nodes)) if (!x.children?.length) counts[x.state] = (counts[x.state] || 0) + 1;
        side.innerHTML = `<h2>Jobs</h2><div class="ghrv-kv">${Object.entries(counts).map(([s, c]) => `${badge(s)} ${c}`).join(' &nbsp; ')}</div>
          <div class="ghrv-muted">Select a job in the graph to see its steps.</div>${list(nodes, '')}`;
      } else {
        side.innerHTML = `
          <h2>${icon(n.state)} ${esc(n.label)}</h2>
          <div class="ghrv-kv">
            ${n.id !== n.label ? `key <code>${esc(n.id)}</code><br>` : ''}
            ${n.needs.length ? `needs <code>${esc(n.needs.join(', '))}</code><br>` : ''}
            ${n.if ? `if <code>${esc(n.if)}</code><br>` : ''}
            ${n.uses ? `uses <code>${esc(n.uses)}</code><br>` : ''}
            ${n.via?.length ? `via <code>${esc(n.via.join(' / '))}</code><br>` : ''}
            ${n.error ? `<span class="ghrv-warn-text">${esc(n.error)}</span><br>` : ''}
            ${!n.defined ? '<span>not in workflow file (reported by API only)</span><br>' : ''}
            ${!n.jobs.length && !n.children?.length ? '<span>no job reported yet</span>' : ''}
          </div>
          ${n.children?.length ? list(n.children, st.selected) : ''}
          ${n.jobs.map(j => {
            const s = stateOf(j);
            if (!j.steps) loadDetails(j);
            return `<div class="ghrv-job">
              <div class="ghrv-job-head">${icon(s)} <a href="${esc(j.html_url)}" target="_blank" rel="noopener">${esc(lastSeg(j.name))}</a><span class="ghrv-dur" data-job-dur="${j.id}">${fmtDur(span(j.started_at, j.completed_at))}</span></div>
              <div class="ghrv-job-sub">${esc(j.status)}${j.conclusion ? ` · ${esc(j.conclusion)}` : ''}${j.runner_name ? ` · ${esc(j.runner_name)}` : ''}${inAttempt(j) ? '' : ' · from an earlier attempt'}</div>
              ${j.steps ? `<ul class="ghrv-steps">${j.steps.map(stp => {
                const ss = stateOf(stp);
                return `<li class="gs-${ss}">${icon(ss)} <span>${esc(stp.name)}</span><span class="ghrv-dur">${fmtDur(span(stp.started_at, stp.completed_at))}</span></li>`;
              }).join('')}</ul>` : `<div class="ghrv-job-sub ghrv-muted">${opts.loadJob ? 'Loading steps…' : ''}</div>`}
            </div>`;
          }).join('')}`;
      }
      side.querySelectorAll('[data-select]').forEach(el => el.addEventListener('click', () => {
        st.selected = el.dataset.select;
        expandAncestors(st.selected);
        renderGraph(); renderSide();
      }));
    }

    // Steps are not part of the run response; they are fetched per job when its panel is shown and
    // remembered for completed jobs, so a poll only re-fetches jobs that are still running.
    function applyDetails(data) {
      for (const { n } of walk(data.nodes)) for (const j of n.jobs) {
        const d = st.details.get(j.id);
        if (d && (d.status === 'completed' || !j.steps)) { j.steps = d.steps; j.runner_name = d.runner_name || j.runner_name; }
      }
    }
    function loadDetails(j) {
      if (!opts.loadJob || st.loading.has(j.id)) return;
      st.loading.add(j.id);
      opts.loadJob(j.id).then(d => {
        st.details.set(j.id, { steps: d.steps || [], runner_name: d.runner_name, status: d.status });
        if (st.data) { applyDetails(st.data); if (st.selected) renderSide(); }
      }).catch(() => {}).finally(() => st.loading.delete(j.id));
    }

    function tick() {
      if (!st.data) return;
      const running = new Map();
      for (const { n, path } of walk(st.data.nodes)) if (n.state === 'running') running.set(path, n);
      host.querySelectorAll('[data-dur]').forEach(el => {
        const n = running.get(el.dataset.dur);
        if (n) el.textContent = fmtDur(subtreeDur(n));
      });
      host.querySelectorAll('[data-job-dur]').forEach(el => {
        const j = findJob(Number(el.dataset.jobDur));
        if (j && j.started_at && !j.completed_at) el.textContent = fmtDur(span(j.started_at, null));
      });
    }

    $('.ghrv-bar').addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act || !st.data) return;
      if (act === 'expand') { for (const { n, path } of walk(st.data.nodes)) if (n.children?.length) st.expanded.add(path); st.autoFit = true; renderGraph(); }
      if (act === 'collapse') { st.expanded.clear(); st.autoFit = true; renderGraph(); }
      const { w, h } = viewSize();
      if (act === 'zoom-in') { st.autoFit = false; zoomAt(st.zoom * 1.25, w / 2, h / 2); }
      if (act === 'zoom-out') { st.autoFit = false; zoomAt(st.zoom / 1.25, w / 2, h / 2); }
      if (act === 'fit') fit();
    });
    const timer = setInterval(tick, 1000);

    return {
      update(data) {
        const first = !st.data;
        st.data = data;
        applyDetails(data);
        const warn = $('.ghrv-warn');
        warn.hidden = !data.workflow?.error && !data.partial;
        warn.classList.toggle('ghrv-note', !!data.partial && !data.workflow?.error);
        warn.textContent = data.workflow?.error ? `Could not load ${data.workflow.path || 'the workflow file'} at this commit (${data.workflow.error}), so jobs are shown without dependencies.` : data.partial ? 'Loading jobs…' : '';
        const cap = $('.ghrv-caption'), run = data.run || {}, path = data.workflow?.path || run.path || '';
        if (path) {
          const base = path.slice(path.lastIndexOf('/') + 1);
          const repo = (run.html_url || '').replace(/\/actions\/runs\/.*$/, '');
          const file = repo && run.head_sha && !data.workflow?.dynamic ? `<a href="${esc(`${repo}/blob/${run.head_sha}/${path}`)}" target="_blank" rel="noopener">${esc(base)}</a>` : esc(base);
          cap.innerHTML = `<b>${file}</b>${run.event ? `<div>on: ${esc(run.event)}</div>` : ''}`;
          cap.hidden = false;
        }
        if (opts.expandAll && !st.expandAllDone) {
          for (const { n, path } of walk(data.nodes)) if (n.children?.length) st.expanded.add(path);
          st.expandAllDone = !data.partial;
        }
        runStart = run.run_started_at ? new Date(run.run_started_at) : null;
        renderGraph(); renderSide();
      },
      error(msg) {
        const warn = $('.ghrv-warn');
        warn.hidden = false;
        warn.textContent = msg;
        if (!st.data) $('.ghrv-svg').innerHTML = '';
      },
      fit,
      destroy() { clearInterval(timer); clearTips(); cancelAnimationFrame(fitRaf); window.removeEventListener('resize', onResize); if (ro) ro.disconnect(); host.innerHTML = ''; host.classList.remove('ghrv'); },
    };
  }

  return { mount, esc, icon, badge, stateOf, fmtDur, ago, span, runDur, _layout: layoutGraph, SEP };
})();
