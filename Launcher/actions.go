package main

// Plain logic with no Windows calls, so it can be unit tested in Docker.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"time"
)

// Version is "v1.2.0 (ef7cbc3)" when built on a git tag, else the short commit
// ("ef7cbc3", "+dirty" for uncommitted changes). Go stamps both into the exe.
var Version = buildVersion()

var pseudoVersion = regexp.MustCompile(`\d{14}-[0-9a-f]{12}`)

func buildVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	var rev, dirty string
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value[:min(7, len(s.Value))]
		case "vcs.modified":
			if s.Value == "true" {
				dirty = "+dirty"
			}
		}
	}
	if rev == "" {
		return "dev"
	}
	if v := info.Main.Version; strings.HasPrefix(v, "v") && !pseudoVersion.MatchString(v) && dirty == "" {
		return v + " (" + rev + ")"
	}
	return rev + dirty
}

// ---------- 1] Hosts redirect ----------

// hostsMarker tags every line we own. Same marker as REExtraUtils v1,
// so lines written by the old tool are cleaned up too.
const hostsMarker = "# RisingEagle Game"

type HostsRequest struct {
	Path    string   `json:"path"`
	IP      string   `json:"ip"`      // empty = remove our lines only
	Domains []string `json:"domains"` // domains to (re)point
}

var domainRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$`)

func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.Split(s, "\n")
}

// CleanDomains trims, drops blanks/duplicates and rejects anything that is not a hostname.
func CleanDomains(in []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, d := range in {
		d = strings.ToLower(strings.TrimSpace(d))
		if d == "" || seen[d] {
			continue
		}
		if !domainRe.MatchString(d) {
			return nil, fmt.Errorf("not a valid domain: %q", d)
		}
		seen[d] = true
		out = append(out, d)
	}
	return out, nil
}

// lineHasDomain reports whether a hosts line maps one of the domains (exact host match,
// ignoring comments). REExtraUtils used a substring match, which could hit other hosts.
func lineHasDomain(line string, domains map[string]bool) bool {
	if i := strings.IndexByte(line, '#'); i >= 0 {
		line = line[:i]
	}
	f := strings.Fields(line)
	for _, h := range f[min(1, len(f)):] {
		if domains[strings.ToLower(h)] {
			return true
		}
	}
	return false
}

// PatchHosts returns the new hosts content. Our old lines and any other mapping of the
// same domains are removed; then, if IP is set, a fresh block is appended.
func PatchHosts(content string, req HostsRequest) (string, error) {
	domains, err := CleanDomains(req.Domains)
	if err != nil {
		return "", err
	}
	if req.IP != "" {
		if net.ParseIP(req.IP) == nil {
			return "", fmt.Errorf("IP is not valid: %q", req.IP)
		}
		if len(domains) == 0 {
			return "", errors.New("domain list is empty")
		}
	}
	set := map[string]bool{}
	for _, d := range domains {
		set[d] = true
	}

	var kept []string
	for _, l := range splitLines(content) {
		if strings.Contains(l, hostsMarker) || lineHasDomain(l, set) {
			continue
		}
		kept = append(kept, l)
	}
	for len(kept) > 0 && strings.TrimSpace(kept[len(kept)-1]) == "" {
		kept = kept[:len(kept)-1]
	}
	if req.IP != "" {
		kept = append(kept, "", hostsMarker)
		for _, d := range domains {
			kept = append(kept, fmt.Sprintf("%s %s %s", req.IP, d, hostsMarker))
		}
	}
	return strings.Join(kept, "\r\n") + "\r\n", nil
}

// OurHostsLines lists the lines we currently own, for the status view.
func OurHostsLines(content string) []string {
	var out []string
	for _, l := range splitLines(content) {
		if strings.Contains(l, hostsMarker) && strings.TrimSpace(l) != hostsMarker {
			out = append(out, strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(l), hostsMarker)))
		}
	}
	return out
}

func ApplyHosts(req HostsRequest) (string, error) {
	b, err := os.ReadFile(req.Path)
	if err != nil {
		return "", err
	}
	out, err := PatchHosts(string(b), req)
	if err != nil {
		return "", err
	}
	// Write in place (not rename) so the file keeps its permissions.
	if err := os.WriteFile(req.Path, []byte(out), 0o644); err != nil {
		return "", err
	}
	if req.IP == "" {
		return "Removed all Rising Eagle redirects.", nil
	}
	return fmt.Sprintf("Redirected %d domains to %s.", len(req.Domains), req.IP), nil
}

// ---------- 2] Duplicate client ----------

type DupRequest struct {
	Exe   string `json:"exe"`
	Count int    `json:"count"` // 1-99
}

// PatchDup returns copy number i of the exe bytes. Both patches are required for two
// clients to run side by side: ".log" -> ".lNN" and "storage.dat" -> "storage.dNN".
// They keep the same length, so offsets inside the exe do not move.
func PatchDup(src []byte, i int) ([]byte, error) {
	out := bytes.Clone(src)
	for _, p := range []struct{ from, to string }{
		{".log", fmt.Sprintf(".l%02d", i)},
		{"storage.dat", fmt.Sprintf("storage.d%02d", i)},
	} {
		at := bytes.Index(src, []byte(p.from))
		if at < 0 {
			return nil, fmt.Errorf("%q not found in the exe - is this RisingEagle.exe?", p.from)
		}
		copy(out[at:], p.to)
	}
	return out, nil
}

func DupName(exe string, i int) string { return fmt.Sprintf("%s_DUP%02d.exe", exe, i) }

func CreateDups(req DupRequest) (string, error) {
	if req.Count < 1 || req.Count > 99 {
		return "", errors.New("count must be 1-99")
	}
	src, err := os.ReadFile(req.Exe)
	if err != nil {
		return "", err
	}
	for i := 0; i < req.Count; i++ {
		b, err := PatchDup(src, i)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(DupName(req.Exe, i), b, 0o755); err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("Created %d copies next to %s (…_DUP00.exe - _DUP%02d.exe).",
		req.Count, filepath.Base(req.Exe), req.Count-1), nil
}

// ---------- 4] Links ----------

const linksURL = "https://github.com/yonixw/REExtraUtils/releases/latest/download/links.txt"

// FetchLinks downloads the community links file. Callers fall back to the embedded copy.
func FetchLinks(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, linksURL, nil)
	req.Header.Set("User-Agent", "Rising2_Launcher/"+Version)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if bytes.HasPrefix(bytes.TrimSpace(b), []byte(`{\rtf`)) {
		return "", errors.New("links file is RTF; publish it as plain text")
	}
	return strings.ReplaceAll(string(b), "\r", ""), nil
}
