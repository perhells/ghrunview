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
	files map[string]cached
}

type cached struct {
	wf  *workflow.Workflow
	err error
}

// New builds a Server; ui is the directory containing index.html. Requests are only answered for
// loopback hostnames plus listenHost, which defeats DNS-rebinding pages that resolve to 127.0.0.1.
func New(client *gh.Client, defaultRepo string, ui fs.FS, listenHost string) *Server {
	hosts := map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true}
	if listenHost != "" && listenHost != "0.0.0.0" && listenHost != "::" {
		hosts[strings.ToLower(listenHost)] = true
	}
	// Tampermonkey only updates when @version grows, so derive it from process start.
	return &Server{gh: client, defaultRepo: defaultRepo, ui: ui, files: map[string]cached{}, version: "0.1." + strconv.FormatInt(time.Now().Unix(), 10), hosts: hosts}
}

// Handler returns the HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.config)
	mux.HandleFunc("GET /api/runs", s.runs)
	mux.HandleFunc("GET /api/runs/{id}", s.run)
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

	var run *gh.Run
	var jobs []gh.Job
	var runErr, jobsErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); run, runErr = s.gh.GetRun(ctx, repo, id) }()
	go func() { defer wg.Done(); jobs, jobsErr = s.gh.ListJobs(ctx, repo, id, attempt) }()
	wg.Wait()
	if runErr != nil {
		writeErr(w, runErr)
		return
	}
	if jobsErr != nil {
		writeErr(w, jobsErr)
		return
	}

	resp := runResponse{Run: run, Fetched: time.Now(), Workflow: workflowInfo{Name: run.Name, Path: run.Path}}
	var wf *workflow.Workflow
	// Dependabot, Pages and default-setup CodeQL run GitHub-generated workflows with no file in the repo.
	if strings.HasPrefix(run.Path, "dynamic/") {
		resp.Workflow.Dynamic = true
	} else if w, err := s.workflowFile(ctx, repo, run.Path, run.HeadSHA); err != nil {
		resp.Workflow.Error = err.Error()
	} else {
		wf = w
	}
	resp.Nodes = graph.Build(wf, jobs, s.resolver(ctx, repo, run.HeadSHA))
	writeJSON(w, 200, resp)
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

func (s *Server) workflowFile(ctx context.Context, repo, path, sha string) (*workflow.Workflow, error) {
	key := repo + "@" + sha + ":" + path
	s.mu.Lock()
	c, ok := s.files[key]
	s.mu.Unlock()
	if ok {
		return c.wf, c.err
	}
	src, err := s.gh.FileAt(ctx, repo, path, sha)
	var wf *workflow.Workflow
	// Only outcomes that cannot change for this sha are cached: a parsed file, a parse error, or a
	// definitive 404/422. Rate limits, auth failures and 5xx must be retried on the next poll.
	cacheable := err == nil
	if err == nil {
		if wf, err = workflow.Parse(src); err != nil {
			err = fmt.Errorf("parse %s: %w", path, err)
		}
	} else if apiErr := (*gh.APIError)(nil); errors.As(err, &apiErr) && (apiErr.Status == 404 || apiErr.Status == 422) {
		cacheable = true
	}
	if cacheable {
		s.mu.Lock()
		s.files[key] = cached{wf: wf, err: err}
		s.mu.Unlock()
	}
	return wf, err
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
