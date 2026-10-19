// Package service installs ghrunview as a per-user background service (launchd on macOS, systemd
// --user on Linux) so the userscript always finds a server.
package service

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const label = "com.github.perhells.ghrunview"

// Install writes the service definition for the current executable and starts it.
func Install(addr string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	// launchd and systemd start with a minimal PATH; keep the directory of gh so the token lookup works.
	path := os.Getenv("PATH")
	if gh, err := exec.LookPath("gh"); err == nil && !strings.Contains(path, filepath.Dir(gh)) {
		path = filepath.Dir(gh) + ":" + path
	}
	switch runtime.GOOS {
	case "darwin":
		return installLaunchd(exe, addr, path)
	case "linux":
		return installSystemd(exe, addr, path)
	}
	return fmt.Errorf("background service is only supported on macOS and Linux")
}

// Uninstall stops the service and removes its definition.
func Uninstall() error {
	switch runtime.GOOS {
	case "darwin":
		p, err := plistPath()
		if err != nil {
			return err
		}
		_ = exec.Command("launchctl", "bootout", domain(), p).Run()
		return os.Remove(p)
	case "linux":
		_ = run("systemctl", "--user", "disable", "--now", "ghrunview")
		p, err := unitPath()
		if err != nil {
			return err
		}
		return os.Remove(p)
	}
	return fmt.Errorf("background service is only supported on macOS and Linux")
}

// Status prints the service manager's view of the service.
func Status() error {
	switch runtime.GOOS {
	case "darwin":
		return run("launchctl", "print", domain()+"/"+label)
	case "linux":
		return run("systemctl", "--user", "status", "ghrunview")
	}
	return fmt.Errorf("background service is only supported on macOS and Linux")
}

func installLaunchd(exe, addr, path string) error {
	p, err := plistPath()
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, "Library", "Logs", "ghrunview.log")
	_ = exec.Command("launchctl", "bootout", domain(), p).Run() // not loaded yet on first install
	if err := checkAddr(addr); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>-open=false</string>
		<string>-addr</string>
		<string>%s</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict><key>PATH</key><string>%s</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>%s</string>
	<key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, xml(exe), xml(addr), xml(path), xml(logFile), xml(logFile))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(plist), 0o644); err != nil {
		return err
	}
	if err := run("launchctl", "bootstrap", domain(), p); err != nil {
		return err
	}
	fmt.Printf("installed %s\nlogs: %s\n", p, logFile)
	return nil
}

func installSystemd(exe, addr, path string) error {
	p, err := unitPath()
	if err != nil {
		return err
	}
	// enable --now leaves an already running unit alone, so stop it to start the new build.
	_ = exec.Command("systemctl", "--user", "stop", "ghrunview").Run()
	if err := checkAddr(addr); err != nil {
		return err
	}
	unit := fmt.Sprintf(`[Unit]
Description=ghrunview local server for GitHub Actions run graphs

[Service]
ExecStart=%s -open=false -addr %s
Environment=PATH=%s
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`, exe, addr, path)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(unit), 0o644); err != nil {
		return err
	}
	if err := run("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	if err := run("systemctl", "--user", "enable", "--now", "ghrunview"); err != nil {
		return err
	}
	fmt.Printf("installed %s\nlogs: journalctl --user -u ghrunview\n", p)
	return nil
}

// checkAddr gives a just-stopped service a moment to release addr, then fails if another process
// still holds it, since the service would otherwise retry in the background without a word.
func checkAddr(addr string) error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln.Close()
		}
		if !errors.Is(err, syscall.EADDRINUSE) {
			return err
		}
		if time.Now().After(deadline) {
			_, port, _ := net.SplitHostPort(addr)
			return fmt.Errorf("%s is in use by another process (a ghrunview started in a terminal?); stop it and run `ghrunview service install` again. Find it with: lsof -nP -iTCP:%s -sTCP:LISTEN", addr, port)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func plistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", label+".plist"), nil
}

func unitPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user", "ghrunview.service"), nil
}

func domain() string {
	u, err := user.Current()
	if err != nil {
		return "gui/501"
	}
	return "gui/" + u.Uid
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func xml(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
