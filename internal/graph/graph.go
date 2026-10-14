// Package graph joins workflow job definitions with the jobs GitHub reports for a run,
// expanding reusable workflows into nested subgraphs.
package graph

import (
	"regexp"
	"sort"
	"strings"

	"github.com/perhells/ghrunview/internal/gh"
	"github.com/perhells/ghrunview/internal/workflow"
)

// Resolver loads the workflow a `uses:` reference points at.
type Resolver func(uses string) (*workflow.Workflow, error)

// Node is one job definition plus the API jobs it expanded into; reusable workflows carry Children.
type Node struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Needs    []string `json:"needs"`
	Matrix   bool     `json:"matrix"`
	Reusable bool     `json:"reusable"`
	Uses     string   `json:"uses,omitempty"`
	If       string   `json:"if,omitempty"`
	Defined  bool     `json:"defined"`
	State    string   `json:"state"`
	Error    string   `json:"error,omitempty"`
	Via      []string `json:"via,omitempty"`
	Jobs     []gh.Job `json:"jobs"`
	Children []Node   `json:"children,omitempty"`
}

const maxDepth = 6

var exprRe = regexp.MustCompile(`\$\{\{.*?\}\}`)

type relJob struct {
	job gh.Job
	rel string
}

type matcher struct {
	idx     int
	prio    int
	literal int
	re      *regexp.Regexp
}

type instance struct {
	name string
	jobs []relJob
}

// Build matches API jobs to workflow job definitions and derives a state per node.
func Build(wf *workflow.Workflow, jobs []gh.Job, resolve Resolver) []Node {
	rel := make([]relJob, len(jobs))
	for i, j := range jobs {
		rel[i] = relJob{job: j, rel: j.Name}
	}
	return build(wf, rel, resolve, 0)
}

func build(wf *workflow.Workflow, jobs []relJob, resolve Resolver, depth int) []Node {
	var defs []workflow.Job
	if wf != nil {
		defs = append(defs, wf.Jobs...)
	}
	ms := matchers(defs)
	var synth []workflow.Job
	for _, j := range jobs {
		if m, _ := match(ms, j.rel); m != nil {
			continue
		}
		base := baseName(j.rel)
		if !hasKey(defs, base) && !hasKey(synth, base) {
			synth = append(synth, workflow.Job{Key: base})
		}
	}
	all := append(defs, synth...)
	ms = matchers(all)

	nodes := make([]Node, len(all))
	insts := make([][]instance, len(all))
	for i, d := range all {
		label := d.Name
		if label == "" {
			label = d.Key
		}
		needs := d.Needs
		if needs == nil {
			needs = []string{}
		}
		nodes[i] = Node{ID: d.Key, Label: label, Needs: needs, Matrix: d.Matrix, Reusable: d.Uses != "", Uses: d.Uses, If: d.If, Defined: i < len(defs), Jobs: []gh.Job{}}
	}
	leafRel := make([][]string, len(all))
	for _, j := range jobs {
		m, rem := match(ms, j.rel)
		if m == nil {
			continue
		}
		if rem == "" {
			nodes[m.idx].Jobs = append(nodes[m.idx].Jobs, j.job)
			leafRel[m.idx] = append(leafRel[m.idx], j.rel)
			continue
		}
		name := strings.TrimSuffix(j.rel, " / "+rem)
		k := -1
		for i, in := range insts[m.idx] {
			if in.name == name {
				k = i
			}
		}
		if k < 0 {
			insts[m.idx] = append(insts[m.idx], instance{name: name})
			k = len(insts[m.idx]) - 1
		}
		insts[m.idx][k].jobs = append(insts[m.idx][k].jobs, relJob{job: j.job, rel: rem})
	}
	for i := range nodes {
		if len(insts[i]) == 0 && hasExpr(nodes[i].Label) {
			if len(nodes[i].Jobs) == 1 {
				nodes[i].Label = leafRel[i][0]
			} else if len(nodes[i].Jobs) > 1 {
				nodes[i].Label = exprRe.ReplaceAllString(nodes[i].Label, "*")
			}
		}
		if len(insts[i]) == 0 {
			continue
		}
		nodes[i].Reusable = true
		var child *workflow.Workflow
		if all[i].Uses != "" && resolve != nil && depth < maxDepth {
			var err error
			if child, err = resolve(all[i].Uses); err != nil {
				nodes[i].Error = err.Error()
			}
		}
		one := insts[i][0]
		if len(insts[i]) == 1 && !all[i].Matrix && (one.name == nodes[i].Label || one.name == nodes[i].ID || hasExpr(nodes[i].Label)) {
			nodes[i].Label = one.name
			nodes[i].Children = build(child, one.jobs, resolve, depth+1)
			continue
		}
		nodes[i].Label = exprRe.ReplaceAllString(nodes[i].Label, "*")
		sort.SliceStable(insts[i], func(a, b int) bool { return insts[i][a].name < insts[i][b].name })
		for _, in := range insts[i] {
			inst := Node{
				ID: in.name, Label: in.name, Needs: []string{}, Reusable: true, Defined: true, Jobs: []gh.Job{},
				Children: build(child, in.jobs, resolve, depth+1),
			}
			inst.State = fold(&inst)
			nodes[i].Children = append(nodes[i].Children, collapseChain(inst))
		}
	}
	for i := range nodes {
		nodes[i].State = fold(&nodes[i])
		nodes[i] = collapseChain(nodes[i])
	}
	return nodes
}

// collapseChain merges a reusable-workflow call that wraps exactly one job into that job, so a
// workflow whose only content is "lint / lint" draws as one box; the inner labels are kept in Via.
func collapseChain(n Node) Node {
	for len(n.Jobs) == 0 && len(n.Children) == 1 {
		c := n.Children[0]
		if c.Label != n.Label {
			n.Via = append(n.Via, c.Label)
		}
		n.Via = append(n.Via, c.Via...)
		n.Matrix = n.Matrix || c.Matrix
		if n.Error == "" {
			n.Error = c.Error
		}
		n.Jobs, n.Children = c.Jobs, c.Children
	}
	return n
}

func matchers(defs []workflow.Job) []matcher {
	var ms []matcher
	for i, d := range defs {
		// A matrix job whose name carries no expression always gets " (values)" appended by GitHub,
		// so its matcher must insist on that suffix or it would also capture a same-named plain job.
		if d.Name != "" {
			ms = append(ms, matcher{idx: i, prio: 0, literal: len(exprRe.ReplaceAllString(d.Name, "")), re: nameRe(d.Name, d.Matrix && !hasExpr(d.Name))})
		}
		ms = append(ms, matcher{idx: i, prio: 1, literal: len(exprRe.ReplaceAllString(d.Key, "")), re: nameRe(d.Key, d.Matrix)})
	}
	// Longest literal first: a name that is only an expression matches anything and must go last.
	sort.SliceStable(ms, func(a, b int) bool {
		if ms[a].literal != ms[b].literal {
			return ms[a].literal > ms[b].literal
		}
		return ms[a].prio < ms[b].prio
	})
	return ms
}

func match(ms []matcher, name string) (*matcher, string) {
	for i := range ms {
		if sm := ms[i].re.FindStringSubmatch(name); sm != nil {
			return &ms[i], sm[len(sm)-1]
		}
	}
	return nil, ""
}

// nameRe matches "<name>", "<name> (matrix values)" and "<name>[ (...)] / <job in reusable workflow>".
// Expressions may evaluate to anything including the empty string, in which case GitHub also
// drops the space next to them, so spaces adjacent to an expression are optional.
func nameRe(name string, requireSuffix bool) *regexp.Regexp {
	parts := exprRe.Split(name, -1)
	var b strings.Builder
	b.WriteString("^")
	for i, p := range parts {
		if i > 0 {
			b.WriteString(".*?")
			if strings.HasPrefix(p, " ") {
				b.WriteString(" ?")
				p = p[1:]
			}
		}
		if i < len(parts)-1 && strings.HasSuffix(p, " ") {
			b.WriteString(regexp.QuoteMeta(p[:len(p)-1]) + " ?")
			continue
		}
		b.WriteString(regexp.QuoteMeta(p))
	}
	if requireSuffix {
		b.WriteString(`( \(.*?\))(?: / (.*))?$`)
	} else {
		b.WriteString(`( \(.*?\))?(?: / (.*))?$`)
	}
	return regexp.MustCompile(b.String())
}

func hasExpr(s string) bool { return exprRe.MatchString(s) }

func baseName(rel string) string {
	if i := strings.Index(rel, " / "); i > 0 {
		rel = rel[:i]
	}
	if strings.HasSuffix(rel, ")") {
		if i := strings.LastIndex(rel, " ("); i > 0 {
			rel = rel[:i]
		}
	}
	return rel
}

func hasKey(defs []workflow.Job, key string) bool {
	for _, d := range defs {
		if d.Key == key {
			return true
		}
	}
	return false
}

var statePrio = map[string]int{"running": 0, "queued": 1, "failure": 2, "cancelled": 3, "success": 4, "skipped": 5, "neutral": 6, "pending": 7}

// fold combines job and child states into one of: running, queued, failure, cancelled, success, skipped, neutral, pending.
func fold(n *Node) string {
	best := "pending"
	consider := func(s string) {
		if statePrio[s] < statePrio[best] {
			best = s
		}
	}
	for _, j := range n.Jobs {
		consider(JobState(j))
	}
	for _, c := range n.Children {
		consider(c.State)
	}
	return best
}

// JobState maps a job's status and conclusion to a single state word.
func JobState(j gh.Job) string {
	switch j.Status {
	case "in_progress":
		return "running"
	case "queued", "waiting", "pending", "requested":
		return "queued"
	}
	switch j.Conclusion {
	case "success":
		return "success"
	case "failure", "timed_out", "action_required", "startup_failure":
		return "failure"
	case "cancelled":
		return "cancelled"
	case "skipped":
		return "skipped"
	}
	if j.Status == "completed" {
		return "neutral"
	}
	return "pending"
}
