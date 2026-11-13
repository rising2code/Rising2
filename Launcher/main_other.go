//go:build !windows

package main

// The launcher is Windows-only. This stub only lets `go test` run on Linux (Docker).
func main() { println("Rising2 Launcher runs on Windows only.") }
