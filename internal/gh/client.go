// Package gh is a minimal GitHub REST client for the Actions endpoints used by the viewer.
package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Client calls the GitHub REST API with a bearer token.
type Client struct {
	token string
	http  *http.Client
	base  string
}

// NewClient returns a client for api.github.com.
func NewClient(token string) *Client {
	return &Client{token: token, http: &http.Client{Timeout: 30 * time.Second}, base: "https://api.github.com"}
}

// Token resolves a token from GH_TOKEN, GITHUB_TOKEN, or `gh auth token`.
func Token() (string, error) {
	for _, k := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v, nil
		}
	}
	out, err := exec.Command("gh", "auth", "token").Output()
	if err != nil {
		return "", fmt.Errorf("no token: set GH_TOKEN or run `gh auth login` (%w)", err)
	}
	t := strings.TrimSpace(string(out))
	if t == "" {
		return "", errors.New("gh auth token returned nothing")
	}
	return t, nil
}

// APIError is a non-2xx response from GitHub.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("github: %d %s", e.Status, e.Message) }

// Rate is the remaining rate-limit budget reported by the last response.
type Rate struct {
	Remaining int       `json:"remaining"`
	Reset     time.Time `json:"reset"`
}

// Run is a workflow run.
type Run struct {
	ID           int64      `json:"id"`
	Name         string     `json:"name"`
	DisplayTitle string     `json:"display_title"`
	Path         string     `json:"path"`
	RunNumber    int        `json:"run_number"`
	RunAttempt   int        `json:"run_attempt"`
	Event        string     `json:"event"`
	Status       string     `json:"status"`
	Conclusion   string     `json:"conclusion"`
	HeadBranch   string     `json:"head_branch"`
	HeadSHA      string     `json:"head_sha"`
	HTMLURL      string     `json:"html_url"`
	WorkflowID   int64      `json:"workflow_id"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	RunStartedAt *time.Time `json:"run_started_at"`
	Actor        Actor      `json:"actor"`
}

// Actor is the user who triggered a run.
type Actor struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

// Job is one job inside a run.
type Job struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	Status      string     `json:"status"`
	Conclusion  string     `json:"conclusion"`
	StartedAt   *time.Time `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at"`
	HTMLURL     string     `json:"html_url"`
	RunnerName  string     `json:"runner_name"`
	RunAttempt  int        `json:"run_attempt"`
	Steps       []Step     `json:"steps"`
}

// Step is one step inside a job.
type Step struct {
	Number      int        `json:"number"`
	Name        string     `json:"name"`
	Status      string     `json:"status"`
	Conclusion  string     `json:"conclusion"`
	StartedAt   *time.Time `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at"`
}

// RunsOpts filters ListRuns.
type RunsOpts struct {
	Branch  string
	Status  string
	Actor   string
	Event   string
	Page    int
	PerPage int
}

// RunsPage is one page of runs.
type RunsPage struct {
	TotalCount int   `json:"total_count"`
	Runs       []Run `json:"workflow_runs"`
	Rate       Rate  `json:"rate"`
}

func (c *Client) do(ctx context.Context, path string, q url.Values, accept string) ([]byte, *Rate, error) {
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if accept == "" {
		accept = "application/vnd.github+json"
	}
	req.Header.Set("Accept", accept)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, nil, err
	}
	rate := &Rate{}
	rate.Remaining, _ = strconv.Atoi(resp.Header.Get("X-RateLimit-Remaining"))
	if s, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		rate.Reset = time.Unix(s, 0)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var m struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &m)
		if m.Message == "" {
			m.Message = http.StatusText(resp.StatusCode)
		}
		return nil, rate, &APIError{Status: resp.StatusCode, Message: m.Message}
	}
	return body, rate, nil
}

// ListRuns returns one page of workflow runs for owner/repo.
func (c *Client) ListRuns(ctx context.Context, repo string, o RunsOpts) (*RunsPage, error) {
	q := url.Values{}
	if o.PerPage <= 0 {
		o.PerPage = 30
	}
	if o.Page <= 0 {
		o.Page = 1
	}
	q.Set("per_page", strconv.Itoa(o.PerPage))
	q.Set("page", strconv.Itoa(o.Page))
	for k, v := range map[string]string{"branch": o.Branch, "status": o.Status, "actor": o.Actor, "event": o.Event} {
		if v != "" {
			q.Set(k, v)
		}
	}
	body, rate, err := c.do(ctx, "/repos/"+repo+"/actions/runs", q, "")
	if err != nil {
		return nil, err
	}
	var p RunsPage
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, err
	}
	p.Rate = *rate
	return &p, nil
}

// GetRun returns a single run.
func (c *Client) GetRun(ctx context.Context, repo string, id int64) (*Run, error) {
	body, _, err := c.do(ctx, fmt.Sprintf("/repos/%s/actions/runs/%d", repo, id), nil, "")
	if err != nil {
		return nil, err
	}
	var r Run
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListJobs returns every job of a run; attempt 0 means the latest attempt.
func (c *Client) ListJobs(ctx context.Context, repo string, id int64, attempt int) ([]Job, error) {
	path := fmt.Sprintf("/repos/%s/actions/runs/%d/jobs", repo, id)
	q := url.Values{"per_page": {"100"}, "filter": {"latest"}}
	if attempt > 0 {
		path = fmt.Sprintf("/repos/%s/actions/runs/%d/attempts/%d/jobs", repo, id, attempt)
		q.Del("filter")
	}
	var all []Job
	for page := 1; page <= 20; page++ {
		q.Set("page", strconv.Itoa(page))
		body, _, err := c.do(ctx, path, q, "")
		if err != nil {
			return nil, err
		}
		var p struct {
			Jobs []Job `json:"jobs"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return nil, err
		}
		all = append(all, p.Jobs...)
		if len(p.Jobs) < 100 {
			break
		}
	}
	return all, nil
}

// FileAt returns the raw content of path in repo at ref.
func (c *Client) FileAt(ctx context.Context, repo, path, ref string) ([]byte, error) {
	q := url.Values{"ref": {ref}}
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, sg := range segs {
		segs[i] = url.PathEscape(sg)
	}
	body, _, err := c.do(ctx, "/repos/"+repo+"/contents/"+strings.Join(segs, "/"), q, "application/vnd.github.raw+json")
	return body, err
}
