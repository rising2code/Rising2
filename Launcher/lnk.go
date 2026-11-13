package main

// Resolving Windows shortcuts (.lnk) to the file they point to, by reading the
// file format directly ([MS-SHLLINK]). No COM, so it is unit-tested in Docker.

import (
	"encoding/binary"
	"errors"
	"os"
	"strings"
	"unicode/utf16"
)

func IsLnk(path string) bool { return strings.EqualFold(lnkExt(path), ".lnk") }

func lnkExt(p string) string {
	if i := strings.LastIndexByte(p, '.'); i >= 0 {
		return p[i:]
	}
	return ""
}

// ResolveLnk returns the target path stored in a .lnk file.
func ResolveLnk(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return parseLnk(b)
}

var errBadLnk = errors.New("not a shortcut with a local target")

func parseLnk(b []byte) (string, error) {
	u32 := func(off int) (int, bool) {
		if off < 0 || off+4 > len(b) {
			return 0, false
		}
		return int(binary.LittleEndian.Uint32(b[off:])), true
	}
	if hs, ok := u32(0); !ok || hs != 0x4C {
		return "", errBadLnk
	}
	flags, _ := u32(0x14)
	pos := 0x4C
	if flags&0x1 != 0 { // HasLinkTargetIDList: skip it
		if pos+2 > len(b) {
			return "", errBadLnk
		}
		pos += 2 + int(binary.LittleEndian.Uint16(b[pos:]))
	}
	if flags&0x2 == 0 { // no LinkInfo
		return "", errBadLnk
	}

	li := pos
	infoSize, ok1 := u32(li)
	hdrSize, ok2 := u32(li + 4)
	liFlags, ok3 := u32(li + 8)
	baseOff, ok4 := u32(li + 16)
	suffixOff, ok5 := u32(li + 24)
	if !(ok1 && ok2 && ok3 && ok4 && ok5) || li+infoSize > len(b) || liFlags&0x1 == 0 {
		return "", errBadLnk
	}
	info := b[li : li+infoSize]

	// Unicode fields exist when the LinkInfo header is 0x24+ bytes; prefer them
	// (paths with Hebrew letters are only correct there).
	if hdrSize >= 0x24 {
		baseU, _ := u32(li + 28)
		sufU, _ := u32(li + 32)
		if baseU > 0 && baseU < len(info) {
			s := utf16z(info[baseU:])
			if sufU > 0 && sufU < len(info) {
				s += utf16z(info[sufU:])
			}
			if s != "" {
				return s, nil
			}
		}
	}
	if baseOff <= 0 || baseOff >= len(info) {
		return "", errBadLnk
	}
	s := ansiz(info[baseOff:])
	if suffixOff > 0 && suffixOff < len(info) {
		s += ansiz(info[suffixOff:])
	}
	if s == "" {
		return "", errBadLnk
	}
	return s, nil
}

// decodeANSI turns system-code-page bytes into text. On Windows it uses the real
// code page (lnk_windows.go); elsewhere Latin-1 is close enough for tests.
var decodeANSI = latin1

func latin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// ansiz reads a NUL-terminated ANSI string.
func ansiz(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return decodeANSI(b[:i])
		}
	}
	return decodeANSI(b)
}

func utf16z(b []byte) string {
	var u []uint16
	for i := 0; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}
