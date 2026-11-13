package main

import "testing"

// testdata/*.lnk were made by Windows (IShellLink) and trimmed to the header,
// target ID list and LinkInfo, so they hold no machine name.
func TestResolveLnk(t *testing.T) {
	for file, want := range map[string]string{
		"testdata/ascii.lnk":  `E:\RE2LnkTest\Rising Eagle\RisingEagle.exe`, // ANSI LinkInfo
		"testdata/hebrew.lnk": `E:\RE2LnkTest\משחק\RisingEagle.exe`,         // Unicode LinkInfo
	} {
		got, err := ResolveLnk(file)
		if err != nil || got != want {
			t.Errorf("%s: got %q, %v; want %q", file, got, err, want)
		}
	}
	if !IsLnk(`C:\x\RisingEagle.exe - Shortcut.LNK`) || IsLnk(`C:\x\RisingEagle.exe`) {
		t.Error("IsLnk")
	}
	for _, bad := range [][]byte{nil, []byte("MZ not a shortcut"), make([]byte, 0x4C)} {
		if _, err := parseLnk(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}
