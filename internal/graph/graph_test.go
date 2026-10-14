package graph

import (
	"errors"
	"strings"
	"testing"

	"github.com/perhells/ghrunview/internal/gh"
	"github.com/perhells/ghrunview/internal/workflow"
)

const top = `
name: deploy
jobs:
  dev:
    name: Deploy dev
    uses: ./.github/workflows/env.yml
  prod:
    name: Deploy prod
    needs: dev
    uses: ./.github/workflows/env.yml
  lint:
    uses: ./.github/workflows/lint.yml
  lint-schema:
    uses: ./.github/workflows/lint.yml
`

const lintWf = `
jobs:
  lint:
`

const env = `
name: env
jobs:
  config:
    name: Read config
  api:
    name: Deploy API (${{ matrix.stack }})
    needs: config
    strategy:
      matrix:
        stack: [eu, us]
    uses: ./.github/workflows/svc.yml
  apply:
    name: Auto-apply
    uses: octo-org/actions/.github/workflows/x.yml@v1
  test:
    needs: config
    strategy:
      matrix:
        go: ["1.21", "1.22"]
`

const svc = `
jobs:
  setup:
  deploy:
    needs: setup
`

func ok(status, conclusion string) gh.Job { return gh.Job{Status: status, Conclusion: conclusion} }

func job(name string, j gh.Job) gh.Job { j.Name = name; return j }

func TestBuildNested(t *testing.T) {
	wf, err := workflow.Parse([]byte(top))
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(uses string) (*workflow.Workflow, error) {
		switch uses {
		case "./.github/workflows/env.yml":
			return workflow.Parse([]byte(env))
		case "./.github/workflows/svc.yml":
			return workflow.Parse([]byte(svc))
		case "./.github/workflows/lint.yml":
			return workflow.Parse([]byte(lintWf))
		}
		return nil, errors.New("not found")
	}
	jobs := []gh.Job{
		job("Deploy dev / Read config", ok("completed", "success")),
		job("Deploy dev / Deploy API (us) / setup", ok("completed", "success")),
		job("Deploy dev / Deploy API (us) / deploy", ok("in_progress", "")),
		job("Deploy dev / Deploy API (eu) / setup", ok("completed", "failure")),
		job("Deploy dev / Auto-apply / Detect", ok("completed", "success")),
		job("Deploy dev / Auto-apply / Apply ${{ matrix.dir }}", ok("completed", "success")),
		job("Deploy dev / test (1.21)", ok("completed", "success")),
		job("Deploy dev / test (1.22)", ok("completed", "skipped")),
		job("Deploy prod", ok("completed", "skipped")),
		job("lint / lint", ok("completed", "success")),
		job("lint-schema / lint", ok("completed", "success")),
		job("Mystery (a) / inner", ok("queued", "")),
	}
	nodes := Build(wf, jobs, resolve)
	byID := func(ns []Node, id string) *Node {
		for i := range ns {
			if ns[i].ID == id {
				return &ns[i]
			}
		}
		t.Fatalf("missing node %q in %v", id, ids(ns))
		return nil
	}
	if len(nodes) != 5 {
		t.Fatalf("want 5 top nodes, got %v", ids(nodes))
	}
	dev := byID(nodes, "dev")
	if dev.State != "running" || len(dev.Children) != 4 {
		t.Fatalf("dev: state=%s children=%v", dev.State, ids(dev.Children))
	}
	api := byID(dev.Children, "api")
	if !api.Matrix || len(api.Children) != 2 || api.Children[0].ID != "Deploy API (eu)" || api.Children[1].ID != "Deploy API (us)" {
		t.Fatalf("api: %+v", api)
	}
	if api.State != "running" || api.Children[0].State != "failure" || api.Children[1].State != "running" {
		t.Fatalf("api states: %s %s %s", api.State, api.Children[0].State, api.Children[1].State)
	}
	deploy := byID(api.Children[1].Children, "deploy")
	if deploy.Needs[0] != "setup" || deploy.State != "running" {
		t.Fatalf("deploy: %+v", deploy)
	}
	lint := byID(nodes, "lint")
	if len(lint.Children) != 0 || len(lint.Jobs) != 1 || lint.Label != "lint" || len(lint.Via) != 0 || !lint.Reusable {
		t.Fatalf("lint chain not collapsed: %+v", lint)
	}
	schema := byID(nodes, "lint-schema")
	if len(schema.Children) != 0 || len(schema.Jobs) != 1 || schema.Label != "lint-schema" || len(schema.Via) != 1 || schema.Via[0] != "lint" {
		t.Fatalf("lint-schema chain not collapsed: %+v", schema)
	}
	apply := byID(dev.Children, "apply")
	if apply.Error == "" || len(apply.Children) != 2 || apply.Children[1].Defined {
		t.Fatalf("apply: %+v", apply)
	}
	test := byID(dev.Children, "test")
	if len(test.Jobs) != 2 || test.State != "success" {
		t.Fatalf("test: %+v", test)
	}
	prod := byID(nodes, "prod")
	if prod.State != "skipped" || len(prod.Jobs) != 1 || len(prod.Children) != 0 {
		t.Fatalf("prod: %+v", prod)
	}
	myst := byID(nodes, "Mystery")
	if myst.Defined || myst.State != "queued" || len(myst.Children) != 0 || len(myst.Jobs) != 1 || strings.Join(myst.Via, "/") != "Mystery (a)/inner" {
		t.Fatalf("mystery: %+v", myst)
	}
}

func ids(ns []Node) []string {
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = n.ID
	}
	return out
}

func TestExpressionOnlyNameDoesNotStealJobs(t *testing.T) {
	wf, err := workflow.Parse([]byte(`
jobs:
  lint:
  test:
    name: ${{ matrix.name }}
    strategy:
      matrix:
        name: [Unit, Integration]
  call:
    uses: ./.github/workflows/svc.yml
`))
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(string) (*workflow.Workflow, error) { return workflow.Parse([]byte(lintWf)) }
	nodes := Build(wf, []gh.Job{
		job("lint", ok("completed", "success")),
		job("Unit", ok("completed", "success")),
		job("Integration", ok("completed", "failure")),
		job("call / lint", ok("completed", "success")),
	}, resolve)
	got := map[string]int{}
	for _, n := range nodes {
		got[n.ID] = len(n.Jobs) + len(n.Children)
	}
	if got["lint"] != 1 || got["test"] != 2 || got["call"] != 1 || len(nodes) != 3 {
		t.Fatalf("jobs per node: %v (nodes %v)", got, ids(nodes))
	}
}

func TestExpressionMayBeEmpty(t *testing.T) {
	wf, _ := workflow.Parse([]byte("jobs:\n  d:\n    name: Deploy ${{ inputs.suffix }}\n"))
	nodes := Build(wf, []gh.Job{job("Deploy ", ok("completed", "success")), job("Deploy", ok("completed", "success"))}, nil)
	if len(nodes) != 1 || len(nodes[0].Jobs) != 2 {
		t.Fatalf("empty expression value not matched: %v", ids(nodes))
	}
}

func TestSameNameMatrixAndStatusJob(t *testing.T) {
	wf, _ := workflow.Parse([]byte(`
jobs:
  test_go_oldest:
    name: Go tests with previous Go version
    strategy:
      matrix:
        go: ["1.21", "1.22"]
  test_go_oldest_status:
    name: Go tests with previous Go version
    needs: test_go_oldest
`))
	nodes := Build(wf, []gh.Job{
		job("Go tests with previous Go version (1.21)", ok("completed", "success")),
		job("Go tests with previous Go version (1.22)", ok("completed", "success")),
		job("Go tests with previous Go version", ok("completed", "success")),
	}, nil)
	if len(nodes) != 2 || len(nodes[0].Jobs) != 2 || len(nodes[1].Jobs) != 1 {
		t.Fatalf("jobs: %d and %d", len(nodes[0].Jobs), len(nodes[1].Jobs))
	}
}
