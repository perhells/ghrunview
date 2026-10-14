// Package workflow parses the job graph out of a GitHub Actions workflow file.
package workflow

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// Workflow is the subset of a workflow file needed to draw its job graph.
type Workflow struct {
	Name string
	Jobs []Job
}

// Job is one entry under `jobs:`, in file order.
type Job struct {
	Key    string
	Name   string
	Needs  []string
	Matrix bool
	Uses   string
	If     string
}

// Parse extracts job definitions and their `needs` edges from workflow YAML.
func Parse(src []byte) (*Workflow, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return nil, err
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 {
		return nil, fmt.Errorf("empty workflow")
	}
	root := deref(doc.Content[0])
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("workflow root is not a mapping")
	}
	wf := &Workflow{}
	for k, v := range pairs(root) {
		switch k {
		case "name":
			wf.Name = v.Value
		case "jobs":
			if v.Kind != yaml.MappingNode {
				return nil, fmt.Errorf("jobs is not a mapping")
			}
			for key, jn := range pairs(v) {
				wf.Jobs = append(wf.Jobs, parseJob(key, jn))
			}
		}
	}
	return wf, nil
}

func parseJob(key string, n *yaml.Node) Job {
	j := Job{Key: key}
	if n.Kind != yaml.MappingNode {
		return j
	}
	for k, v := range pairs(n) {
		switch k {
		case "name":
			j.Name = v.Value
		case "uses":
			j.Uses = v.Value
		case "if":
			j.If = v.Value
		case "needs":
			switch v.Kind {
			case yaml.ScalarNode:
				j.Needs = []string{v.Value}
			case yaml.SequenceNode:
				for _, c := range v.Content {
					if c = deref(c); c.Kind == yaml.ScalarNode && c.Value != "" {
						j.Needs = append(j.Needs, c.Value)
					}
				}
			}
		case "strategy":
			for sk := range pairs(v) {
				if sk == "matrix" {
					j.Matrix = true
				}
			}
		}
	}
	return j
}

func pairs(n *yaml.Node) func(yield func(string, *yaml.Node) bool) {
	return func(yield func(string, *yaml.Node) bool) {
		if n == nil || n.Kind != yaml.MappingNode {
			return
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			if !yield(n.Content[i].Value, deref(n.Content[i+1])) {
				return
			}
		}
	}
}

func deref(n *yaml.Node) *yaml.Node {
	for n != nil && n.Kind == yaml.AliasNode && n.Alias != nil {
		n = n.Alias
	}
	return n
}
