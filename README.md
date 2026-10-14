# ghrunview

Local browser UI for GitHub Actions runs. Draws each run as a dependency graph
(`needs:` edges), expands reusable workflows and matrix jobs into nested boxes,
and shows per-job steps and timings. Polls while a run is in progress.

## Run

```sh
go install .            # or: go build -o ghrunview .
cd some/repo && ghrunview          # repo from `git remote get-url origin`
ghrunview -repo octocat/hello-world
ghrunview -addr 127.0.0.1:9000 -open=false
```

Auth: `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token` (needs `repo` / `actions:read`
and `contents:read`; remote reusable workflows need read access to that repo too).

Any repo can be opened from the input in the top bar; the URL hash carries it:
`#/owner/repo` and `#/owner/repo/run/<id>` (`?expand` opens every group).

In the run view every reusable-workflow box starts collapsed. Click a box to
expand it, click again to collapse. Hovering a box highlights its edges and
neighbours in white, the selected box in blue. Edges are routed orthogonally
through free rows so they never cross other boxes.

The canvas captures the wheel: scroll pans, ctrl/⌘+scroll or pinch zooms around
the cursor, drag pans, double-click on empty space fits. The graph auto-fits
after every expand/collapse until you pan or zoom by hand; "Fit" re-enables that.

## Inside github.com (Tampermonkey)

With the server running, open `http://127.0.0.1:8788/ghrunview.user.js` (or the
Userscript link in the top bar). Tampermonkey shows its install dialog. The
script then renders the same graph on every `github.com/<owner>/<repo>/actions/runs/<id>`
page, right under GitHub's run summary box, themed with GitHub's own colour
variables (light and dark).

- The script talks to the server with `GM_xmlhttpRequest`, so GitHub's CSP and
  CORS do not get in the way. The server never sets CORS headers on purpose:
  other websites must not be able to read your runs through it.
- The server address is baked in from the URL you installed from. Change it
  from Tampermonkey's menu ("Set ghrunview server URL").
- The renderer (`graph.js`) is bundled through `@require` and, where the
  userscript sandbox allows `eval`, a fresh copy is also fetched from the
  server on every page load. github.com's CSP forbids `eval` in the page
  context, so with Tampermonkey's default sandbox you get the bundled copy;
  `@sandbox raw` asks for the isolated context where the fresh copy works.
  `@updateURL` points back at the server and `@version` is derived from
  server start time, so after a restart an update check (or a reinstall from
  the link) refreshes both the shim and the bundled renderer.
- The script re-attaches after GitHub's Turbo navigations and after GitHub's
  live-update swaps the run summary DOM.

## How the graph is built

1. `GET /actions/runs/{id}` and `/jobs` from the GitHub REST API.
2. The workflow file at the run's `head_sha` is fetched and parsed for `jobs`,
   `needs`, `strategy.matrix`, `if` and `uses`.
3. API job names (`Caller / Inner (matrix) / Leaf`) are matched back to the
   definitions; `uses:` targets (`./.github/...` and `owner/repo/path@ref`) are
   fetched recursively so nested reusable workflows get their own sub-DAG.
4. Jobs that cannot be matched are still shown, grouped by name, without edges.

Files are cached per `sha` in memory for the lifetime of the process.

## Layout

```
main.go                 flags, token, embedded UI, browser open
internal/gh             REST client (runs, jobs, raw file contents)
internal/workflow       YAML -> job definitions
internal/graph          match API jobs to definitions, nest reusable workflows
internal/server         /api/config, /api/runs, /api/runs/{id}, /ghrunview.user.js, static UI
web/graph.js            shared renderer (layout, routing, SVG, hover/select, side panel)
web/app.js              standalone page: routing, run list, run header
web/userscript.js       Tampermonkey shim; served concatenated with graph.js
```
