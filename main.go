// Command ghrunview serves a local browser UI for GitHub Actions runs with a job dependency graph.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"

	"github.com/perhells/ghrunview/internal/gh"
	"github.com/perhells/ghrunview/internal/server"
	"github.com/perhells/ghrunview/internal/service"
)

//go:embed web
var web embed.FS

var remoteRe = regexp.MustCompile(`github\.com[:/]([\w.-]+/[\w.-]+?)(?:\.git)?$`)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "service" {
		serviceCmd(os.Args[2:])
		return
	}
	addr := flag.String("addr", "127.0.0.1:8788", "listen address")
	repo := flag.String("repo", "", "owner/name (default: origin remote of cwd)")
	open := flag.Bool("open", true, "open the browser on start")
	dev := flag.Bool("dev", false, "serve the UI from ./web on disk instead of the embedded copy")
	flag.Parse()

	if *repo == "" {
		*repo = repoFromGit()
	}
	token, err := gh.Token()
	if err != nil {
		log.Fatal(err)
	}
	var ui fs.FS
	if *dev {
		ui = os.DirFS("web")
	} else if ui, err = fs.Sub(web, "web"); err != nil {
		log.Fatal(err)
	}
	listenHost, _, _ := net.SplitHostPort(*addr)
	srv := server.New(gh.NewClient(token), *repo, ui, listenHost)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	url := "http://" + ln.Addr().String()
	fmt.Printf("ghrunview listening on %s (repo: %s)\n", url, orNone(*repo))
	if *open {
		openBrowser(url)
	}
	log.Fatal(http.Serve(ln, srv.Handler()))
}

// serviceCmd handles `ghrunview service install|uninstall|status`.
func serviceCmd(args []string) {
	fs := flag.NewFlagSet("service", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8788", "listen address for the background server")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: ghrunview service install [-addr host:port] | uninstall | status")
		fs.PrintDefaults()
	}
	if len(args) == 0 {
		fs.Usage()
		os.Exit(2)
	}
	_ = fs.Parse(args[1:])
	var err error
	switch args[0] {
	case "install":
		err = service.Install(*addr)
	case "uninstall":
		err = service.Uninstall()
	case "status":
		err = service.Status()
	default:
		fs.Usage()
		os.Exit(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func repoFromGit() string {
	out, err := exec.Command("git", "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	if m := remoteRe.FindStringSubmatch(strings.TrimSpace(string(out))); m != nil {
		return m[1]
	}
	return ""
}

func orNone(s string) string {
	if s == "" {
		return "none, pick one in the UI"
	}
	return s
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	_ = cmd.Start()
}
