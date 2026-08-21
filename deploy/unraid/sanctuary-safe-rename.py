#!/usr/bin/python3
"""Rename one bound inode between inherited directory descriptors."""

import os
import sys


if len(sys.argv) != 5:
    raise RuntimeError("usage: sanctuary-safe-rename <source-name> <destination-name> <device> <inode>")

source_name, destination_name, expected_device, expected_inode = sys.argv[1:]
for value in (source_name, destination_name):
    if not value or value in (".", "..") or os.path.basename(value) != value or "/" in value or "\x00" in value:
        raise RuntimeError("rename coordinates must be basenames")

expected = (int(expected_device), int(expected_inode))
before = os.stat(source_name, dir_fd=3, follow_symlinks=False)
if (before.st_dev, before.st_ino) != expected:
    raise RuntimeError("source inode changed before bound rename")

os.rename(source_name, destination_name, src_dir_fd=3, dst_dir_fd=4)
after = os.stat(destination_name, dir_fd=4, follow_symlinks=False)
if (after.st_dev, after.st_ino) != expected:
    raise RuntimeError("source inode changed during bound rename")
