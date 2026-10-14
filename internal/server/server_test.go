package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestHostCheck(t *testing.T) {
	srv := New(nil, "o/r", fstest.MapFS{"index.html": {Data: []byte("hi")}}, "127.0.0.1")
	h := srv.Handler()
	for host, want := range map[string]int{"127.0.0.1:8788": 200, "localhost:8788": 200, "[::1]:8788": 200, "LOCALHOST": 200, "evil.example:8788": 403, "evil.example": 403} {
		req := httptest.NewRequest(http.MethodGet, "http://x/api/config", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("host %q: got %d, want %d", host, rec.Code, want)
		}
	}
}

func TestCheckWorkflowPath(t *testing.T) {
	ok := []string{".github/workflows/ci.yml", ".github/workflows/sub dir/x.yaml"}
	bad := []string{"ci.yml", ".github/workflows/../../user", ".github/workflows/x.yml?ref=main", ".github/workflows/x.yml#f", "/.github/workflows/x.yml", ".github/workflows//x.yml"}
	for _, p := range ok {
		if err := checkWorkflowPath(p); err != nil {
			t.Errorf("%q rejected: %v", p, err)
		}
	}
	for _, p := range bad {
		if checkWorkflowPath(p) == nil {
			t.Errorf("%q accepted", p)
		}
	}
}
