package main

import "golang.org/x/sys/windows"

const cpACP = 0 // the system ANSI code page

// Shortcuts store ASCII-safe paths in the system ANSI code page; decode with the OS.
func init() {
	decodeANSI = func(b []byte) string {
		if len(b) == 0 {
			return ""
		}
		n, err := windows.MultiByteToWideChar(cpACP, 0, &b[0], int32(len(b)), nil, 0)
		if err != nil || n == 0 {
			return latin1(b)
		}
		u := make([]uint16, n)
		windows.MultiByteToWideChar(cpACP, 0, &b[0], int32(len(b)), &u[0], n)
		return windows.UTF16ToString(u)
	}
}
