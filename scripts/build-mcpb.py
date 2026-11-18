#!/usr/bin/env python3
"""Packs mcpb/ into "Keystone for Claude.mcpb" (a zip the Claude desktop app installs with a double-click).

    python3 scripts/build-mcpb.py
"""
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "Keystone for Claude.mcpb"
files = ["manifest.json", "server/index.cjs"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        info = zipfile.ZipInfo(f, date_time=(2026, 1, 1, 0, 0, 0))  # fixed date: the same input packs to the same file
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, (root / "mcpb" / f).read_bytes())
print(f"-> {out} ({out.stat().st_size} bytes)")
