package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

//go:embed ui data
var assets embed.FS

const (
	appTitle      = "Rising2 Launcher"
	winW, winH    = 760, 540 // in 96-DPI pixels
	webview2Page  = "https://developer.microsoft.com/microsoft-edge/webview2/"
	createNoWindw = 0x08000000
)

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--elevated" {
		os.Exit(elevatedChild(os.Args[2]))
	}

	if v, _ := webviewloader.GetInstalledVersion(); v == "" {
		unsupported()
		return
	}

	dataDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Rising2_Launcher", "WebView2")
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     hasArg("--debug"),
		AutoFocus: true,
		DataPath:  dataDir,
		WindowOptions: webview2.WindowOptions{
			Title: appTitle, Width: winW, Height: winH, IconId: 1, Center: true,
		},
	})
	if w == nil {
		unsupported()
		return
	}
	defer w.Destroy()

	hwnd := uintptr(w.Window())
	makeFrameless(hwnd)
	bindBridge(w, hwnd)
	w.SetHtml(page())
	w.Run()
}

func hasArg(a string) bool {
	for _, x := range os.Args[1:] {
		if x == a {
			return true
		}
	}
	return false
}

func unsupported() {
	msg := "Rising2 Launcher can't start.\n\n" +
		"It needs the Microsoft Edge WebView2 Runtime, which is built into Windows 10 and 11.\n\n" +
		"Windows 7 / 8.1 are NOT supported. The last WebView2 Runtime for them was version 109 (early 2023). " +
		"If you install it yourself the launcher may work, but that is untested and at your own risk.\n\n" +
		"Open the WebView2 download page?"
	if messageBox(msg, appTitle, mbYesNo|mbIconError) == idYes {
		openURL(webview2Page)
	}
}

// page inlines style.css and app.js so the UI is one self-contained document.
func page() string {
	read := func(p string) string { b, _ := assets.ReadFile(p); return string(b) }
	html := read("ui/index.html")
	html = strings.Replace(html, `<link rel="stylesheet" href="style.css">`, "<style>"+read("ui/style.css")+"</style>", 1)
	html = strings.Replace(html, `<script src="app.js"></script>`, "<script>"+read("ui/app.js")+"</script>", 1)
	return html
}

// ---------- JS bridge ----------
//
// go-webview2 runs bound functions on the UI thread, so a slow action (download, UAC
// prompt) would freeze the window. JS calls __rpc(id, method, args); window ops run
// right away, everything else in a goroutine that answers via window.__rpcDone.

type handler func(args json.RawMessage) (any, error)

func bindBridge(w webview2.WebView, hwnd uintptr) {
	winOps := map[string]func(){
		"win.minimize": func() { procShowWindow.Call(hwnd, swMinimize) },
		"win.close":    func() { w.Terminate() },
		"win.drag": func() {
			procReleaseCapture.Call()
			procPostMessage.Call(hwnd, wmNCLButtonDown, htCaption, 0)
		},
	}
	h := handlers(w, hwnd)

	w.Bind("__rpc", func(id int, method string, args json.RawMessage) {
		if op, ok := winOps[method]; ok {
			op()
			return
		}
		go func() {
			var res any
			var err error
			if f, ok := h[method]; ok {
				res, err = f(args)
			} else {
				err = fmt.Errorf("unknown method %q", method)
			}
			payload := map[string]any{"ok": err == nil, "value": res}
			if err != nil {
				payload["value"] = err.Error()
			}
			b, _ := json.Marshal(payload)
			w.Dispatch(func() { w.Eval(fmt.Sprintf("window.__rpcDone(%d,%s)", id, b)) })
		}()
	})
}

func handlers(w webview2.WebView, hwnd uintptr) map[string]handler {
	hostsPath := filepath.Join(os.Getenv("SystemRoot"), "System32", "drivers", "etc", "hosts")

	return map[string]handler{
		"app.boot": func(json.RawMessage) (any, error) {
			info := map[string]string{}
			entries, _ := assets.ReadDir("data/info")
			for _, e := range entries {
				b, _ := assets.ReadFile("data/info/" + e.Name())
				info[e.Name()] = string(b)
			}
			domains, _ := assets.ReadFile("data/hosts-domains.txt")
			ver, _ := webviewloader.GetInstalledVersion()
			return map[string]any{
				"version": Version, "elevated": windows.GetCurrentProcessToken().IsElevated(),
				"hostsPath": hostsPath, "domains": strings.Fields(string(domains)),
				"info": info, "webview": ver,
			}, nil
		},

		"hosts.status": func(json.RawMessage) (any, error) {
			b, err := os.ReadFile(hostsPath)
			if err != nil {
				return nil, err
			}
			return OurHostsLines(string(b)), nil
		},

		"hosts.apply": func(args json.RawMessage) (any, error) {
			var req HostsRequest
			if err := json.Unmarshal(args, &req); err != nil {
				return nil, err
			}
			req.Path = hostsPath
			msg, err := privileged("hosts", req, func() (string, error) { return ApplyHosts(req) })
			if err == nil {
				flushDNS()
			}
			return msg, err
		},

		"dup.create": func(args json.RawMessage) (any, error) {
			var req DupRequest
			if err := json.Unmarshal(args, &req); err != nil {
				return nil, err
			}
			return privileged("dup", req, func() (string, error) { return CreateDups(req) })
		},

		"dup.pick": func(args json.RawMessage) (any, error) {
			var current string
			_ = json.Unmarshal(args, &current)
			done := make(chan string, 1)
			w.Dispatch(func() { done <- openFileDialog(hwnd, current) }) // dialogs belong on the UI thread
			return <-done, nil
		},

		"links.fetch": func(json.RawMessage) (any, error) {
			text, err := FetchLinks(context.Background())
			if err != nil {
				b, _ := assets.ReadFile("data/links.txt")
				return map[string]any{"text": string(b), "online": false, "error": err.Error()}, nil
			}
			return map[string]any{"text": text, "online": true}, nil
		},

		"open.url": func(args json.RawMessage) (any, error) {
			var u string
			_ = json.Unmarshal(args, &u)
			if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
				return nil, errors.New("only web links can be opened")
			}
			openURL(u)
			return nil, nil
		},
	}
}

func flushDNS() {
	cmd := exec.Command("ipconfig", "/flushdns")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindw}
	_ = cmd.Run()
}

// ---------- Elevation ----------
//
// Try the action as the normal user first. Only if Windows says "access denied" do we
// re-run this exe as admin (one UAC prompt) for that single action.

type elevatedJob struct {
	Kind  string          `json:"kind"`
	Req   json.RawMessage `json:"req"`
	Msg   string          `json:"msg,omitempty"`
	Error string          `json:"error,omitempty"`
}

func privileged(kind string, req any, direct func() (string, error)) (string, error) {
	msg, err := direct()
	if err == nil || !errors.Is(err, fs.ErrPermission) || windows.GetCurrentProcessToken().IsElevated() {
		return msg, err
	}

	raw, _ := json.Marshal(req)
	job, _ := json.Marshal(elevatedJob{Kind: kind, Req: raw})
	f, err := os.CreateTemp("", "rising2-job-*.json")
	if err != nil {
		return "", err
	}
	jobPath := f.Name()
	defer os.Remove(jobPath)
	defer os.Remove(jobPath + ".out")
	f.Write(job)
	f.Close()

	exe, _ := os.Executable()
	code, err := runAsAdmin(exe, `--elevated "`+jobPath+`"`)
	if errors.Is(err, windows.ERROR_CANCELLED) {
		return "", errors.New("admin permission was declined, nothing changed")
	}
	if err != nil {
		return "", err
	}
	var out elevatedJob
	b, rerr := os.ReadFile(jobPath + ".out")
	if rerr != nil || json.Unmarshal(b, &out) != nil {
		return "", fmt.Errorf("admin helper failed (exit code %d)", code)
	}
	if out.Error != "" {
		return "", errors.New(out.Error)
	}
	return out.Msg, nil
}

func elevatedChild(jobPath string) int {
	var job elevatedJob
	b, err := os.ReadFile(jobPath)
	if err == nil {
		err = json.Unmarshal(b, &job)
	}
	if err == nil {
		switch job.Kind {
		case "hosts":
			var r HostsRequest
			if err = json.Unmarshal(job.Req, &r); err == nil {
				job.Msg, err = ApplyHosts(r)
			}
		case "dup":
			var r DupRequest
			if err = json.Unmarshal(job.Req, &r); err == nil {
				job.Msg, err = CreateDups(r)
			}
		default:
			err = fmt.Errorf("unknown job %q", job.Kind)
		}
	}
	if err != nil {
		job.Error = err.Error()
	}
	job.Req = nil
	out, _ := json.Marshal(job)
	if os.WriteFile(jobPath+".out", out, 0o644) != nil || err != nil {
		return 1
	}
	return 0
}
