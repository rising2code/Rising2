package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleHosts = "# Copyright (c) Microsoft\r\n127.0.0.1 localhost\r\n" +
	"1.2.3.4 gpcm.reagspy.com\r\n" + // user's own mapping of one of our domains
	"10.0.0.1 notgpcm.reagspy.com.example\r\n" + // old substring match would have removed this
	"# RisingEagle Game\r\n9.9.9.9 old.reagspy.com # RisingEagle Game\r\n\r\n\r\n"

func TestPatchHostsApply(t *testing.T) {
	out, err := PatchHosts(sampleHosts, HostsRequest{IP: "5.6.7.8", Domains: []string{" GPCM.reagspy.com", "", "gpsp.reagspy.com", "gpsp.reagspy.com"}})
	if err != nil {
		t.Fatal(err)
	}
	want := "# Copyright (c) Microsoft\r\n127.0.0.1 localhost\r\n10.0.0.1 notgpcm.reagspy.com.example\r\n\r\n" +
		"# RisingEagle Game\r\n5.6.7.8 gpcm.reagspy.com # RisingEagle Game\r\n5.6.7.8 gpsp.reagspy.com # RisingEagle Game\r\n"
	if out != want {
		t.Fatalf("got:\n%q\nwant:\n%q", out, want)
	}
	// Applying twice must not grow the file.
	again, _ := PatchHosts(out, HostsRequest{IP: "5.6.7.8", Domains: []string{"gpcm.reagspy.com", "gpsp.reagspy.com"}})
	if again != out {
		t.Fatalf("not idempotent:\n%q", again)
	}
	if got := OurHostsLines(out); len(got) != 2 || got[0] != "5.6.7.8 gpcm.reagspy.com" {
		t.Fatalf("OurHostsLines = %q", got)
	}
}

func TestPatchHostsRemove(t *testing.T) {
	out, err := PatchHosts(sampleHosts, HostsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "RisingEagle") || !strings.Contains(out, "1.2.3.4 gpcm") {
		t.Fatalf("remove went wrong:\n%q", out)
	}
}

func TestPatchHostsRejects(t *testing.T) {
	for _, r := range []HostsRequest{
		{IP: "999.1.1.1", Domains: []string{"a.com"}},
		{IP: "1.1.1.1", Domains: []string{"bad domain.com"}},
		{IP: "1.1.1.1", Domains: []string{"a.com #evil"}},
		{IP: "1.1.1.1"},
	} {
		if _, err := PatchHosts(sampleHosts, r); err == nil {
			t.Errorf("expected error for %+v", r)
		}
	}
}

func TestDups(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "RisingEagle.exe")
	src := []byte("MZ....game.log....storage.dat....game.log")
	os.WriteFile(exe, src, 0o644)

	msg, err := CreateDups(DupRequest{Exe: exe, Count: 3})
	if err != nil {
		t.Fatal(err)
	}
	if msg.Code != "dup.done" || msg.Args["n"] != 3 || msg.Args["last"] != "_DUP02.exe" {
		t.Fatalf("msg = %+v", msg)
	}
	b, _ := os.ReadFile(DupName(exe, 2))
	// Only the first ".log" changes, same as REExtraUtils.
	if string(b) != "MZ....game.l02....storage.d02....game.log" {
		t.Fatalf("dup 2 = %q", b)
	}
	if _, err := os.Stat(DupName(exe, 3)); err == nil {
		t.Fatal("made too many copies")
	}

	// Both patterns are required.
	if _, err := PatchDup([]byte("only game.log here"), 0); AsMsg(err).Code != "err.notGameExe" {
		t.Fatalf("expected err.notGameExe, got %v", err)
	}
	if _, err := CreateDups(DupRequest{Exe: exe, Count: 100}); AsMsg(err).Code != "err.count" {
		t.Fatalf("expected err.count, got %v", err)
	}
	if m := AsMsg(os.ErrNotExist); m.Code != "err.system" || m.Args["detail"] == "" {
		t.Fatalf("AsMsg(system error) = %+v", m)
	}
}
