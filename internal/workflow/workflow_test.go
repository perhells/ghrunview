package workflow

import "testing"

func TestParseAliases(t *testing.T) {
	wf, err := Parse([]byte(`
x-needs: &needs [build, lint]
x-matrix: &matrix
  matrix:
    os: [a, b]
jobs:
  build:
  lint:
  test:
    needs: *needs
    strategy: *matrix
  pack:
    needs: *needs
`))
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]Job{}
	for _, j := range wf.Jobs {
		byKey[j.Key] = j
	}
	if len(byKey["test"].Needs) != 2 || !byKey["test"].Matrix || len(byKey["pack"].Needs) != 2 {
		t.Fatalf("aliases not dereferenced: %+v", byKey)
	}
}
