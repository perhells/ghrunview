// Package server exposes the viewer's JSON API and embedded UI.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	pathpkg "path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/perhells/ghrunview/internal/gh"
	"github.com/perhells/ghrunview/internal/graph"
	"github.com/perhells/ghrunview/internal/workflow"
)

var repoRe = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// Server holds the GitHub client and a cache of workflow files keyed by sha.
type Server struct {
	gh          *gh.Client
	defaultRepo string
	ui          fs.FS
	version     string
	hosts       map[string]bool

	mu    sync.Mutex
	dirs  map[string]dirEntry
	blobs map[string]cached
}

type cached struct {
	wf  *workflow.Workflow
	err error
}

type dirEntry struct {
	files map[string]string // file name -> blob sha
	err   error
	at    time.Time
}

// refTTL bounds how long a directory listing for a branch or tag ref is trusted; sha refs never expire.
const refTTL = 10 * time.Minute

// New builds a Server; ui is the directory containing index.html. Requests are only answered for
// loopback hostnames plus listenHost, which defeats DNS-rebinding pages that resolve to 127.0.0.1.
func New(client *gh.Client, defaultRepo string, ui fs.FS, listenHost string) *Server {
	hosts := map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true}
	if listenHost != "" && listenHost != "0.0.0.0" && listenHost != "::" {
		hosts[strings.ToLower(listenHost)] = true
	}
	// Tampermonkey only updates when @version grows, so derive it from process start.
	return &Server{gh: client, defaultRepo: defaultRepo, ui: ui, dirs: map[string]dirEntry{}, blobs: map[string]cached{}, version: "0.1." + strconv.FormatInt(time.Now().Unix(), 10), hosts: hosts}
}

// Handler returns the HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.config)
	mux.HandleFunc("GET /api/runs", s.runs)
	mux.HandleFunc("GET /api/runs/{id}", s.run)
	mux.HandleFunc("GET /api/jobs/{id}", s.job)
	mux.HandleFunc("GET /ghrunview.user.js", s.userscript)
	mux.Handle("GET /", http.FileServerFS(s.ui))
	return logging(s.hostCheck(mux))
}

func (s *Server) hostCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if !s.hosts[strings.ToLower(strings.Trim(host, "[]"))] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

const userscriptHeader = `// ==UserScript==
// @name         ghrunview
// @namespace    ghrunview
// @version      %s
// @description  Nested job dependency graph for GitHub Actions runs, rendered by a local ghrunview server (renderer loaded from it at runtime)
// @match        https://github.com/*/*/actions/runs/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      %s
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// @sandbox      raw
// @require      %s/graph.js?v=%s
// @downloadURL  %s/ghrunview.user.js
// @updateURL    %s/ghrunview.user.js
// ==/UserScript==

'use strict';
const GHRV_DEFAULT_SERVER = %q;

`

func (s *Server) userscript(w http.ResponseWriter, r *http.Request) {
	shim, err := fs.ReadFile(s.ui, "userscript.js")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	host := r.Host
	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}
	base := "http://" + host
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintf(w, userscriptHeader, s.version, hostname, base, s.version, base, base, base)
	w.Write(shim)
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"repo": s.defaultRepo})
}

func (s *Server) runs(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	per, _ := strconv.Atoi(q.Get("per_page"))
	p, err := s.gh.ListRuns(r.Context(), repo, gh.RunsOpts{
		Branch: q.Get("branch"), Status: q.Get("status"), Actor: q.Get("actor"), Event: q.Get("event"),
		Page: page, PerPage: per,
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, p)
}

type runResponse struct {
	Run      *gh.Run      `json:"run"`
	Workflow workflowInfo `json:"workflow"`
	Nodes    []graph.Node `json:"nodes"`
	Fetched  time.Time    `json:"fetched_at"`
	Partial  bool         `json:"partial,omitempty"`
}

type workflowInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Dynamic bool   `json:"dynamic,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (s *Server) run(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad run id"})
		return
	}
	attempt, _ := strconv.Atoi(r.URL.Query().Get("attempt"))
	ctx := r.Context()

	run, err := s.gh.GetRun(ctx, repo, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	// Jobs come from the check-runs endpoint (fast, no steps; steps are loaded per job on demand) and
	// are fetched while the workflow files are resolved. Attempt views keep the jobs endpoint.
	var jobs []gh.Job
	var jobsErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		if attempt == 0 && run.CheckSuiteID > 0 {
			jobs, jobsErr = s.gh.ListCheckRuns(ctx, repo, run.CheckSuiteID)
		} else {
			jobs, jobsErr = s.gh.ListJobs(ctx, repo, id, attempt)
		}
	}()

	resp := runResponse{Run: run, Fetched: time.Now(), Workflow: workflowInfo{Name: run.Name, Path: run.Path}}
	var wf *workflow.Workflow
	// Dependabot, Pages and default-setup CodeQL run GitHub-generated workflows with no file in the repo.
	if strings.HasPrefix(run.Path, "dynamic/") {
		resp.Workflow.Dynamic = true
	} else if w, err := s.workflowFile(ctx, repo, run.Path, run.HeadSHA); err != nil {
		resp.Workflow.Error = err.Error()
	} else {
		wf = w
		s.prefetch(ctx, repo, run.HeadSHA, wf)
	}
	resolve := s.resolver(ctx, repo, run.HeadSHA)

	// Older clients get one JSON object once everything is in.
	if r.URL.Query().Get("stream") != "1" {
		<-done
		if jobsErr != nil {
			writeErr(w, jobsErr)
			return
		}
		resp.Nodes = graph.Build(wf, jobs, resolve)
		writeJSON(w, 200, resp)
		return
	}

	// Streaming clients get NDJSON in two lines: the graph skeleton from the workflow files as soon
	// as it is known, then the same object with jobs filled in once GitHub's (slow) jobs call returns.
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	flusher, _ := w.(http.Flusher)
	if wf != nil || resp.Workflow.Dynamic {
		resp.Partial = true
		resp.Nodes = graph.Build(wf, nil, resolve)
		_ = enc.Encode(resp)
		if flusher != nil {
			flusher.Flush()
		}
	}
	<-done
	if jobsErr != nil {
		_ = enc.Encode(map[string]string{"error": errMessage(jobsErr)})
		return
	}
	resp.Partial = false
	resp.Fetched = time.Now()
	resp.Nodes = graph.Build(wf, jobs, resolve)
	_ = enc.Encode(resp)
}

func errMessage(err error) string {
	var apiErr *gh.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Message
	}
	return err.Error()
}

func (s *Server) job(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo(w, r)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad job id"})
		return
	}
	j, err := s.gh.GetJob(r.Context(), repo, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, j)
}

// prefetch resolves every uses: reference reachable from wf one level at a time, in parallel, so
// Build later finds them all in the cache instead of fetching them one by one.
func (s *Server) prefetch(ctx context.Context, repo, sha string, wf *workflow.Workflow) {
	resolve := s.resolver(ctx, repo, sha)
	seen := map[string]bool{}
	level := []*workflow.Workflow{wf}
	for depth := 0; depth < 6 && len(level) > 0; depth++ {
		var refs []string
		for _, w := range level {
			for _, j := range w.Jobs {
				if j.Uses != "" && !seen[j.Uses] {
					seen[j.Uses] = true
					refs = append(refs, j.Uses)
				}
			}
		}
		next := make([]*workflow.Workflow, len(refs))
		var wg sync.WaitGroup
		for i, ref := range refs {
			wg.Add(1)
			go func(i int, ref string) {
				defer wg.Done()
				if w, err := resolve(ref); err == nil {
					next[i] = w
				}
			}(i, ref)
		}
		wg.Wait()
		level = level[:0]
		for _, w := range next {
			if w != nil {
				level = append(level, w)
			}
		}
	}
}

var remoteUsesRe = regexp.MustCompile(`^([\w.-]+/[\w.-]+)/(.+?)@(.+)$`)

func (s *Server) resolver(ctx context.Context, repo, sha string) graph.Resolver {
	return func(uses string) (*workflow.Workflow, error) {
		if strings.HasPrefix(uses, "./") {
			path := strings.TrimPrefix(uses, "./")
			if err := checkWorkflowPath(path); err != nil {
				return nil, err
			}
			return s.workflowFile(ctx, repo, path, sha)
		}
		if m := remoteUsesRe.FindStringSubmatch(uses); m != nil {
			if err := checkWorkflowPath(m[2]); err != nil {
				return nil, err
			}
			return s.workflowFile(ctx, m[1], m[2], m[3])
		}
		return nil, fmt.Errorf("unsupported uses reference %q", uses)
	}
}

// checkWorkflowPath accepts only what GitHub itself accepts for a reusable workflow, so a crafted
// uses: value cannot steer the authenticated contents request elsewhere or drop its ref.
func checkWorkflowPath(path string) error {
	if !strings.HasPrefix(path, ".github/workflows/") || strings.ContainsAny(path, "?#\\") || strings.Contains(path, "..") || strings.Contains(path, "//") {
		return fmt.Errorf("refusing workflow path %q", path)
	}
	return nil
}

// workflowFile resolves repo:path@ref through a directory listing (cached per ref) and the blob
// cache (immutable by sha), so a file that did not change between commits is never fetched twice.
func (s *Server) workflowFile(ctx context.Context, repo, path, ref string) (*workflow.Workflow, error) {
	dir, name := pathpkg.Split(path)
	files, err := s.listDir(ctx, repo, strings.TrimSuffix(dir, "/"), ref)
	if err != nil {
		return nil, err
	}
	sha, ok := files[name]
	if !ok {
		return nil, &gh.APIError{Status: 404, Message: path + " not found at " + ref}
	}
	return s.blob(ctx, repo, sha, path)
}

func (s *Server) listDir(ctx context.Context, repo, dir, ref string) (map[string]string, error) {
	key := repo + "@" + ref + ":" + dir
	s.mu.Lock()
	d, ok := s.dirs[key]
	s.mu.Unlock()
	if ok && (isSHA(ref) || time.Since(d.at) < refTTL) {
		return d.files, d.err
	}
	entries, err := s.gh.ListDir(ctx, repo, dir, ref)
	files := map[string]string{}
	for _, e := range entries {
		if e.Type == "file" {
			files[e.Name] = e.SHA
		}
	}
	// Only definitive outcomes are cached; rate limits, auth failures and 5xx are retried next time.
	if err == nil || isDefinitive(err) {
		s.mu.Lock()
		s.dirs[key] = dirEntry{files: files, err: err, at: time.Now()}
		s.mu.Unlock()
	}
	return files, err
}

func (s *Server) blob(ctx context.Context, repo, sha, path string) (*workflow.Workflow, error) {
	key := repo + ":" + sha
	s.mu.Lock()
	c, ok := s.blobs[key]
	s.mu.Unlock()
	if ok {
		return c.wf, c.err
	}
	src, err := s.gh.Blob(ctx, repo, sha)
	if err != nil {
		return nil, err
	}
	wf, err := workflow.Parse(src)
	if err != nil {
		err = fmt.Errorf("parse %s: %w", path, err)
	}
	s.mu.Lock()
	s.blobs[key] = cached{wf: wf, err: err}
	s.mu.Unlock()
	return wf, err
}

func isSHA(ref string) bool {
	if len(ref) != 40 {
		return false
	}
	for _, c := range ref {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func isDefinitive(err error) bool {
	var apiErr *gh.APIError
	return errors.As(err, &apiErr) && (apiErr.Status == 404 || apiErr.Status == 422)
}

func (s *Server) repo(w http.ResponseWriter, r *http.Request) (string, bool) {
	repo := r.URL.Query().Get("repo")
	if repo == "" {
		repo = s.defaultRepo
	}
	if !repoRe.MatchString(repo) {
		writeJSON(w, 400, map[string]string{"error": "repo must be owner/name"})
		return "", false
	}
	return repo, true
}

func writeErr(w http.ResponseWriter, err error) {
	var apiErr *gh.APIError
	if errors.As(err, &apiErr) {
		writeJSON(w, apiErr.Status, map[string]string{"error": apiErr.Message})
		return
	}
	writeJSON(w, 502, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.RequestURI(), time.Since(start).Round(time.Millisecond))
	})
}
