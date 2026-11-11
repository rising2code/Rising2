#!/usr/bin/env python3
"""Remove the "players must have different addresses" stats gate from the
OFFICIAL Rising Eagle dedicated server (Official_DedicatedServer_131.exe), so
a stats (Competition) session starts even when every player connects from the
same IP - handy for debugging on one machine / one LAN.

The input file is never modified; a patched copy is written.

  python patch_dedicated_server.py "C:/Games/RisingEagle/bin/win32/Official_DedicatedServer_131.exe"
  python patch_dedicated_server.py IN.exe --out OUT.exe --mode B
  python patch_dedicated_server.py IN.exe --check          # only report the current state

Modes (file offsets, from the binary analysis of 2026-11-10):
  A (default) remove only the different-address rule. Still needs >=1 player on each side.
      0x42D02C  75 12 -> 90 90   (path 1: player joins a running session, fn 0x82CBA0)
      0x42F3B4  74 05 -> 90 90   (path 2: new session begins, fn ~0x82ED90)
  B  remove every condition: a single player starts a stats session (testing only).
      A + 0x42D01C 74 22 -> 90 90, 0x42D024 74 1A -> 90 90, 0x42F3FB 0F 94 C0 -> B0 01 90

Only the patched official server ever sends Competition reports; the
unofficial DedicatedServer.exe has the report code stubbed out.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

PATCHES_A = [
    (0x42D02C, bytes.fromhex("7512"), bytes.fromhex("9090"), "path 1: skip different-address check"),
    (0x42F3B4, bytes.fromhex("7405"), bytes.fromhex("9090"), "path 2: skip different-address check"),
]
PATCHES_B = PATCHES_A + [
    (0x42D01C, bytes.fromhex("7422"), bytes.fromhex("9090"), "path 1: skip 'side A has players' check"),
    (0x42D024, bytes.fromhex("741a"), bytes.fromhex("9090"), "path 1: skip 'side B has players' check"),
    (0x42F3FB, bytes.fromhex("0f94c0"), bytes.fromhex("b00190"), "path 2: force 'allowed' flag = 1"),
]
EXPECTED_SIZE = 6922240


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exe", help="Official_DedicatedServer_131.exe (input, not modified)")
    ap.add_argument("--out", help="output path (default: <input>_rising2_<mode>.exe next to the input)")
    ap.add_argument("--mode", choices=["A", "B"], default="A")
    ap.add_argument("--check", action="store_true", help="only print which patches are applied")
    ap.add_argument("--force", action="store_true", help="overwrite --out if it exists")
    a = ap.parse_args()

    data = bytearray(open(a.exe, "rb").read())
    print(f"input  {a.exe}  {len(data)} bytes  sha256={hashlib.sha256(data).hexdigest()}")
    if len(data) != EXPECTED_SIZE:
        print(f"WARNING: size differs from the analysed exe ({EXPECTED_SIZE} bytes) - offsets may be wrong")

    patches = PATCHES_B if a.mode == "B" else PATCHES_A
    state_ok = True
    for off, orig, new, what in PATCHES_B:
        cur = bytes(data[off:off + len(orig)])
        st = "original" if cur == orig else "PATCHED" if cur == new else f"UNKNOWN ({cur.hex()})"
        if st.startswith("UNKNOWN"):
            state_ok = False
        print(f"  0x{off:06X}  {cur.hex():<6}  {st:<9}  {what}")
    if a.check:
        return 0 if state_ok else 2
    if not state_ok:
        print("ERROR: unexpected bytes at a patch offset - this is not the analysed exe. Nothing written.")
        return 2

    for off, orig, new, what in patches:
        cur = bytes(data[off:off + len(orig)])
        if cur == orig:
            data[off:off + len(orig)] = new
            print(f"patch  0x{off:06X}  {orig.hex()} -> {new.hex()}  {what}")
        else:
            print(f"keep   0x{off:06X}  already {cur.hex()}")

    out = a.out or os.path.splitext(a.exe)[0] + f"_rising2_{a.mode}.exe"
    if os.path.abspath(out) == os.path.abspath(a.exe):
        print("ERROR: refusing to overwrite the input file")
        return 2
    if os.path.exists(out) and not a.force:
        print(f"ERROR: {out} exists (use --force)")
        return 2
    with open(out, "wb") as f:
        f.write(data)
    print(f"output {out}  sha256={hashlib.sha256(data).hexdigest()}")
    print("Run the patched exe instead of the original. The rest of the install stays the same.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
