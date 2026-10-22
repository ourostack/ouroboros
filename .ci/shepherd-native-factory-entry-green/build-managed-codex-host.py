"""Own an exact Codex source/build stage; never install or run a coding backend."""
from dataclasses import dataclass
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import tomllib
import urllib.request
import uuid

if not (__debug__ and sys.dont_write_bytecode):
    raise RuntimeError("Unoptimized Python with -B required before loading the fsmonitor-B builder")


UPSTREAM_COMMIT = "6b9826e3aa83b1a5947db50f4332cb9c65f1b340"
UPSTREAM_TREE = "74ba48a4b6b086beb9226a79ffe0f3d9f6d40f52"
RELEASE_MANIFEST_BLOB = "3cf0d009a8ecede0fb207cc9ec40ebef30f59b09"
RELEASE_LOCK_BLOB = "45fca1b150822ec5f09689acef48c346b61a7afd"
SOURCE_OWNER = ".cmux-managed-codex-source.json"
STAGE_OWNER = ".cmux-managed-codex-stage.json"
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_SOURCE = 256 * 1024 * 1024
MEMBER = "cmux-managed-codex-host"
TARGET_OWNER = ".cmux-managed-codex-target.json"
PATCH_PATHS = frozenset({
    "codex-rs/app-server/src/config_manager.rs",
    "codex-rs/app-server/src/config_manager_service.rs",
    "codex-rs/app-server/src/in_process.rs",
    "codex-rs/app-server/src/outgoing_message.rs",
    "codex-rs/app-server/src/message_processor.rs",
    "codex-rs/app-server/src/request_processors/thread_processor.rs",
    "codex-rs/core/src/tools/mod.rs",
    "codex-rs/core/src/lib.rs",
})


class BuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class SourceManifest:
    root: Path
    commit: str
    files: dict


@dataclass(frozen=True)
class StageManifest:
    root: Path
    source: Path
    source_tree: str
    files: dict


@dataclass(frozen=True)
class BuildResult:
    command: tuple[str, ...]
    log: Path
    receipt: Path
    minimum_free_bytes: int


def _git_hash(kind, content):
    return hashlib.sha1(kind.encode() + b" " + str(len(content)).encode() + b"\0" + content).hexdigest()


def _safe_name(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or str(path) != value or any(
        part in ("", ".", "..", ".git") for part in path.parts
    ) or "\\" in value or "\0" in value:
        raise BuildError(f"Unsafe source path: {value!r}")
    return path


def _root(path):
    path = Path(path)
    if not path.is_absolute() or path == Path(path.anchor) or ".." in path.parts:
        raise BuildError("An explicit absolute non-root path is required")
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise BuildError(f"Symlinked owner path: {parent}")
    if path.exists() and not path.is_dir():
        raise BuildError(f"Owner path is not a directory: {path}")
    return path


def _fetch_tree():
    request = urllib.request.Request(
        f"https://api.github.com/repos/openai/codex/git/trees/{UPSTREAM_COMMIT}?recursive=1",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "cmux-managed-codex-build"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise BuildError("Upstream Git tree exceeds its bound")
    return json.loads(data)


def _fetch_archive():
    with urllib.request.urlopen(
        f"https://codeload.github.com/openai/codex/tar.gz/{UPSTREAM_COMMIT}", timeout=120
    ) as response:
        data = response.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        raise BuildError("Upstream archive exceeds its bound")
    return data


def _inventory(tree):
    if tree.get("sha") != UPSTREAM_COMMIT or tree.get("truncated") is not False:
        raise BuildError("Incomplete or foreign upstream tree")
    records = {}
    for item in tree["tree"]:
        name = str(_safe_name(item["path"]))
        if name in records or (item["type"], item["mode"]) not in (
            ("tree", "040000"), ("blob", "100644"), ("blob", "100755"), ("blob", "120000")
        ):
            raise BuildError(f"Duplicate or unsupported Git entry: {name}")
        if len(item["sha"]) != 40:
            raise BuildError(f"Invalid Git object identity: {name}")
        records[name] = item
    for name in records:
        parent = str(PurePosixPath(name).parent)
        if parent != "." and (parent not in records or records[parent]["type"] != "tree"):
            raise BuildError(f"Missing directory or linked parent: {name}")
    children = {}
    for name, entry in records.items():
        children.setdefault(str(PurePosixPath(name).parent), []).append(entry)
    for name in [".", *[name for name, value in records.items() if value["type"] == "tree"]]:
        content = b""
        for item in sorted(children.get(name, []), key=lambda value:
                           PurePosixPath(value["path"]).name + ("/" if value["type"] == "tree" else "")):
            mode = item["mode"].lstrip("0")
            content += (mode + " " + PurePosixPath(item["path"]).name).encode() + b"\0" + bytes.fromhex(item["sha"])
        expected = UPSTREAM_TREE if name == "." else records[name]["sha"]
        if _git_hash("tree", content) != expected:
            raise BuildError(f"Pinned Git tree mismatch: {name}")
    files = {name: entry for name, entry in records.items() if entry["type"] == "blob"}
    if sum(entry["size"] for entry in files.values()) > MAX_SOURCE:
        raise BuildError("Upstream source exceeds its bound")
    return records, files


def _link_target(name, target):
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    if target.startswith("/") or "\\" in target or "\0" in target or resolved in (".", "..") or resolved.startswith("../"):
        raise BuildError(f"Escaping symlink: {name}")


def acquire_sdk(destination: Path) -> SourceManifest:
    destination = _root(destination)
    if destination.exists():
        raise BuildError("Source acquisition requires a fresh destination")
    tree = _fetch_tree()
    records, files = _inventory(tree)
    archive = _fetch_archive()
    if len(archive) > MAX_ARCHIVE:
        raise BuildError("Upstream archive exceeds its bound")
    contents = {}
    seen = set()
    prefix = None
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r|gz") as reader:
        for index, item in enumerate(reader):
            if index > len(records) + 1:
                raise BuildError("Too many archive entries")
            parts = PurePosixPath(item.name.rstrip("/")).parts
            if PurePosixPath(item.name.rstrip("/")).as_posix() != item.name.rstrip("/"):
                raise BuildError("Noncanonical archive path")
            if not parts or parts[0] in (".", "..", "/"):
                raise BuildError("Unsafe archive root")
            if prefix is None:
                prefix = parts[0]
            if parts[0] != prefix:
                raise BuildError("Multiple archive roots")
            if len(parts) == 1 and item.isdir():
                continue
            name = str(_safe_name("/".join(parts[1:])))
            if name in seen or name not in records:
                raise BuildError(f"Duplicate or unlisted archive path: {name}")
            seen.add(name)
            entry = records[name]
            if item.isdir() and entry["type"] == "tree":
                continue
            if name not in files:
                raise BuildError(f"Unexpected archive entry type: {name}")
            if item.issym() and entry["mode"] == "120000":
                _link_target(name, item.linkname)
                content = item.linkname.encode()
            elif item.isfile() and entry["mode"] in ("100644", "100755") and item.size == entry["size"]:
                content = reader.extractfile(item).read(entry["size"] + 1)
                if bool(item.mode & 0o111) != (entry["mode"] == "100755"):
                    raise BuildError(f"Archive executable-mode drift: {name}")
            else:
                raise BuildError(f"Unsupported archive member: {name}")
            if len(content) != entry["size"] or _git_hash("blob", content) != entry["sha"]:
                raise BuildError(f"Archive blob drift: {name}")
            contents[name] = content
    if set(contents) != set(files):
        raise BuildError("Archive does not contain the complete pinned source")
    destination.mkdir(parents=True)
    for name, content in contents.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if files[name]["mode"] == "120000":
            target.symlink_to(content.decode())
        else:
            with target.open("xb") as handle:
                handle.write(content)
            target.chmod(0o755 if files[name]["mode"] == "100755" else 0o644)
    with (destination / SOURCE_OWNER).open("x") as handle:
        json.dump(tree, handle, sort_keys=True)
    return _source(destination)


def _snapshot(root, exclude=()):
    result = {}
    for parent, directories, names in os.walk(root, followlinks=False):
        for name in directories[:]:
            path = Path(parent) / name
            if path.is_symlink():
                directories.remove(name)
                names.append(name)
        for name in names:
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            if relative in exclude:
                continue
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                content = os.readlink(path).encode()
                _link_target(relative, content.decode())
                mode = "120000"
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                content = path.read_bytes()
                mode = "100755" if metadata.st_mode & 0o111 else "100644"
            else:
                raise BuildError(f"Unsupported source file: {path}")
            result[relative] = {"sha": _git_hash("blob", content), "mode": mode, "size": len(content)}
    return result


def _source(root):
    root = _root(root)
    owner = root / SOURCE_OWNER
    if owner.is_symlink() or not owner.is_file():
        raise BuildError("Missing exact source ownership manifest")
    _, files = _inventory(json.loads(owner.read_text()))
    expected = {name: {key: value[key] for key in ("sha", "mode", "size")} for name, value in files.items()}
    if _snapshot(root, [SOURCE_OWNER]) != expected:
        raise BuildError("Source no longer matches its complete pinned Git tree")
    return SourceManifest(root, UPSTREAM_COMMIT, expected)


def prepare_stage(source: Path, stage: Path, member: Path | None, patch: Path | None) -> StageManifest:
    source = _source(source)
    stage = _root(stage)
    _disjoint(stage, source.root)
    previous = _stage(stage) if stage.exists() else None
    if previous is not None and (previous.source != source.root or previous.source_tree != UPSTREAM_TREE):
        raise BuildError("Stage belongs to another exact source generation")
    member_files, member_manifest = _member(member, source, stage)
    patch_paths = _patch_paths(source.root, patch)
    old_owner = json.loads((stage / STAGE_OWNER).read_text()) if previous else {}
    old_member = set(old_owner.get("member_files", []))
    if not old_member.issubset(member_files):
        raise BuildError("Removing a staged member file requires a fresh stage")
    workspace = source.root / "codex-rs"
    manifest = (workspace / "Cargo.toml").read_bytes()
    lock = (workspace / "Cargo.lock").read_bytes()
    lock, release_projection = _release_lock_projection(manifest, lock)
    if member_manifest is not None:
        manifest, lock = _workspace_member(manifest, lock, member_manifest)
    if not stage.exists():
        shutil.copytree(source.root, stage, symlinks=True)
    for name in set(old_owner.get("patch_paths", [])) | patch_paths:
        (stage / name).write_bytes((source.root / name).read_bytes())
    if patch is not None:
        _git_apply(stage, patch)
    if member_files:
        for name in member_files:
            output = stage / "codex-rs" / MEMBER / name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes((member / name).read_bytes())
            output.chmod(0o755 if member_files[name]["mode"] == "100755" else 0o644)
    (stage / "codex-rs/Cargo.toml").write_bytes(manifest)
    (stage / "codex-rs/Cargo.lock").write_bytes(lock)
    metadata = stage.stat()
    owner = {
        "schema": 1, "root": str(stage), "device": metadata.st_dev, "inode": metadata.st_ino,
        "source": str(source.root), "source_tree": UPSTREAM_TREE,
        "token": old_owner.get("token", uuid.uuid4().hex),
        "patch_paths": sorted(patch_paths), "member_files": sorted(member_files),
        "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest() if patch is not None else None,
        "member_sha256": hashlib.sha256(json.dumps(member_files, sort_keys=True).encode()).hexdigest(),
        "release_lock_projection": release_projection,
        "files": _snapshot(stage, [STAGE_OWNER]),
    }
    with (stage / STAGE_OWNER).open("w" if previous else "x") as handle:
        json.dump(owner, handle, sort_keys=True)
    return _stage(stage)


def _disjoint(first, second):
    if first == second or first.is_relative_to(second) or second.is_relative_to(first):
        raise BuildError(f"Ownership roots overlap: {first}, {second}")


def _stage(root):
    root = _root(root)
    path = root / STAGE_OWNER
    if path.is_symlink() or not path.is_file():
        raise BuildError("Existing stage has no regular ownership manifest")
    owner = json.loads(path.read_text())
    metadata = root.stat()
    if (owner.get("schema"), owner.get("root"), owner.get("device"), owner.get("inode"),
        owner.get("source_tree")) != (1, str(root), metadata.st_dev, metadata.st_ino, UPSTREAM_TREE):
        raise BuildError("Stage owner/source generation mismatch")
    patch_paths, member_files = owner.get("patch_paths"), owner.get("member_files")
    if not isinstance(patch_paths, list) or not all(
        isinstance(name, str) and name in PATCH_PATHS for name in patch_paths
    ) or len(set(patch_paths)) != len(patch_paths):
        raise BuildError("Stage owner contains undeclared patch paths")
    if not isinstance(member_files, list) or not all(isinstance(name, str) for name in member_files):
        raise BuildError("Stage owner contains invalid member paths")
    for name in member_files:
        _safe_name(name)
    if not isinstance(owner.get("token"), str) or not re.fullmatch(r"[0-9a-f]{32}", owner["token"]):
        raise BuildError("Stage owner token is invalid")
    files = _snapshot(root, [STAGE_OWNER])
    if files != owner["files"]:
        raise BuildError("Stage or upstream lock changed outside the owned projection")
    source = _source(Path(owner["source"]))
    _disjoint(root, source.root)
    expected_paths = set(source.files) | {SOURCE_OWNER} | {
        f"codex-rs/{MEMBER}/{name}" for name in member_files
    }
    if set(files) != expected_paths:
        raise BuildError("Stage contains missing or undeclared source paths")
    if (root / SOURCE_OWNER).read_bytes() != (source.root / SOURCE_OWNER).read_bytes():
        raise BuildError("Staged source provenance changed")
    changes = set(patch_paths) | {"codex-rs/Cargo.toml", "codex-rs/Cargo.lock"}
    for name, entry in source.files.items():
        if (name not in changes and files[name] != entry) or files[name]["mode"] != entry["mode"]:
            raise BuildError(f"Stage changes an undeclared source or mode: {name}")
    manifest = (source.root / "codex-rs/Cargo.toml").read_bytes()
    lock = (source.root / "codex-rs/Cargo.lock").read_bytes()
    lock, release_projection = _release_lock_projection(manifest, lock)
    if owner.get("release_lock_projection") != release_projection:
        raise BuildError("Stage release-local lock projection metadata changed")
    if member_files:
        actual_member, member_manifest = _member_contents(root / "codex-rs" / MEMBER)
        if set(actual_member) != set(member_files):
            raise BuildError("Staged member inventory is incomplete")
        manifest, lock = _workspace_member(manifest, lock, member_manifest)
    if (root / "codex-rs/Cargo.toml").read_bytes() != manifest or (root / "codex-rs/Cargo.lock").read_bytes() != lock:
        raise BuildError("Stage changed upstream workspace settings or lock packages")
    return StageManifest(root, source.root, owner["source_tree"], files)


def _member(member, source, stage):
    if member is None:
        return {}, None
    member = _root(member)
    _disjoint(member, source.root)
    _disjoint(member, stage)
    return _member_contents(member)


def _member_contents(member):
    files = _snapshot(member)
    for name, entry in files.items():
        if entry["mode"] == "120000" or not (
            name in ("Cargo.toml", "LICENSE", "NOTICE")
            or (name.startswith(("src/", "tests/")) and name.endswith(".rs"))
        ):
            raise BuildError(f"Unapproved member input: {name}")
    if "Cargo.toml" not in files or "src/main.rs" not in files:
        raise BuildError("Owned member must contain its manifest and real main source")
    manifest = tomllib.loads((member / "Cargo.toml").read_text())
    if set(manifest) - {"package", "dependencies", "dev-dependencies"}:
        raise BuildError("Only the fixed workspace-inheriting member is supported")
    package = manifest["package"]
    if package.get("name") != MEMBER or package.get("version") != "0.1.0" or set(package) - {
        "name", "version", "edition", "rust-version", "publish", "license", "description"
    }:
        raise BuildError("Foreign member identity or build configuration")
    for kind in ("dependencies", "dev-dependencies"):
        for dependency in manifest.get(kind, {}).values():
            if not isinstance(dependency, dict) or dependency.get("workspace") is not True or set(dependency) - {
                "workspace", "features", "default-features"
            }:
                raise BuildError("Every member dependency must inherit the pinned workspace")
    return files, manifest


def _release_lock_projection(manifest_bytes, lock_bytes):
    manifest_blob = _git_hash("blob", manifest_bytes)
    lock_blob = _git_hash("blob", lock_bytes)
    if manifest_blob != RELEASE_MANIFEST_BLOB and lock_blob != RELEASE_LOCK_BLOB:
        return lock_bytes, None
    if manifest_blob != RELEASE_MANIFEST_BLOB or lock_blob != RELEASE_LOCK_BLOB:
        raise BuildError("Mixed release workspace manifest/lock projection pair")
    manifest = tomllib.loads(manifest_bytes.decode())
    lock = tomllib.loads(lock_bytes.decode())
    packages = lock.get("package")
    if manifest.get("workspace", {}).get("package", {}).get("version") != "0.154.0":
        raise BuildError("Release workspace version is not the pinned 0.154.0")
    if not isinstance(packages, list) or not all(
        isinstance(package, dict)
        and isinstance(package.get("name"), str)
        and re.fullmatch(r"[A-Za-z0-9_-]+", package["name"])
        and isinstance(package.get("version"), str)
        and ("source" not in package or isinstance(package["source"], str))
        for package in packages
    ):
        raise BuildError("Malformed release lock package identity")
    identities = [(package["name"], package["version"], package.get("source")) for package in packages]
    local = [package for package in packages if "source" not in package]
    if (len(set(identities)) != len(identities) or len(local) != 150
            or len({package["name"] for package in local}) != 150
            or any(package["version"] != "0.0.0" for package in local)):
        raise BuildError("Release lock must contain exactly 150 unique local 0.0.0 packages")
    mapping = {package["name"]: {"from": "0.0.0", "to": "0.154.0"}
               for package in sorted(local, key=lambda package: package["name"])}
    expected = json.loads(json.dumps(lock))
    for package in expected["package"]:
        if "source" not in package:
            package["version"] = "0.154.0"
    blocks = re.split(rb"(?m)(?=^\[\[package\]\]$)", lock_bytes)
    changed = 0
    for index, block in enumerate(blocks):
        if not block.startswith(b"[[package]]"):
            continue
        package = tomllib.loads(block.decode())["package"][0]
        if "source" not in package:
            blocks[index], count = re.subn(
                rb'(?m)^version = "0\.0\.0"$', b'version = "0.154.0"', block, count=1)
            if count != 1:
                raise BuildError("Cannot project exact release-local version bytes")
            changed += count
    projected = b"".join(blocks)
    if changed != 150 or tomllib.loads(projected.decode()) != expected:
        raise BuildError("Release lock projection changed an undeclared field or dependency")
    return projected, {
        "kind": "pinned-release-local-version-projection",
        "manifest_git_blob": manifest_blob, "original_lock_git_blob": lock_blob,
        "original_lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
        "projected_lock_sha256": hashlib.sha256(projected).hexdigest(),
        "local_packages": mapping, "external_package_count": len(packages) - len(local),
        "qualification": False,
    }


def _workspace_member(manifest_bytes, lock_bytes, member):
    manifest = tomllib.loads(manifest_bytes.decode())
    lock = tomllib.loads(lock_bytes.decode())
    if MEMBER in manifest["workspace"]["members"] or any(p["name"] == MEMBER for p in lock["package"]):
        raise BuildError("Upstream unexpectedly owns our member name")
    dependencies = set()
    workspace_dependencies = manifest["workspace"]["dependencies"]
    for name in set(member.get("dependencies", {})) | set(member.get("dev-dependencies", {})):
        if name not in workspace_dependencies:
            raise BuildError(f"Member dependency is not pinned upstream: {name}")
        value = workspace_dependencies[name]
        package = value.get("package", name) if isinstance(value, dict) else name
        matches = [item for item in lock["package"] if item["name"] == package]
        if (package == "sha2" and value == "0.10" and len(matches) == 2
                and sorted(item["version"] for item in matches) == ["0.10.9", "0.11.0"]):
            # Qualify only our new edge for this exact pinned workspace ambiguity.
            dependencies.add("sha2 0.10.9")
            continue
        if len(matches) != 1:
            raise BuildError(f"Ambiguous or missing upstream lock dependency: {package}")
        dependencies.add(package)
    changed, count = re.subn(
        rb"(?m)^members\s*=\s*\[", b'members = [\n    "' + MEMBER.encode() + b'",', manifest_bytes, count=1
    )
    if count != 1:
        raise BuildError("Cannot identify the exact workspace member declaration")
    expected = json.loads(json.dumps(manifest))
    expected["workspace"]["members"].insert(0, MEMBER)
    if tomllib.loads(changed.decode()) != expected:
        raise BuildError("Workspace changes would alter upstream configuration")
    entry = {"name": MEMBER, "version": member["package"]["version"], "dependencies": sorted(dependencies)}
    addition = "\n\n[[package]]\n" + "\n".join(
        key + " = " + json.dumps(value) for key, value in entry.items()
    ) + "\n"
    changed_lock = lock_bytes + addition.encode()
    if tomllib.loads(changed_lock.decode()) != dict(lock, package=lock["package"] + [entry]):
        raise BuildError("Owned lock addition changes an upstream package")
    return changed, changed_lock


def _git_environment(root):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return dict(environment, GIT_CEILING_DIRECTORIES=str(root.parent),
                GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_SYSTEM=os.devnull,
                GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_COUNT="0", GIT_OPTIONAL_LOCKS="0",
                GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="/usr/bin/false",
                SSH_ASKPASS="/usr/bin/false", GIT_NO_LAZY_FETCH="1")


def _git_arguments(*arguments):
    return [
        "git", "-c", "core.fsmonitor=", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
        "-c", "core.hooksPath=" + os.devnull, "-c", "credential.helper=", *arguments,
    ]


def _cargo_git_gateway(target, attempt):
    executable = shutil.which("git", path=os.defpath)
    if executable is None or not Path(executable).is_absolute():
        raise BuildError("Direct system Git executable required for the owned Cargo gateway")
    executable = str(Path(executable).resolve(strict=True))
    directory = target / ("git-posture-" + attempt)
    directory.mkdir(mode=0o700)
    path = directory / "git"
    root = str(target.parent)
    body = (
        f"#!{Path(sys.executable).resolve()} -B\n"
        "import os, sys\n"
        "from pathlib import Path\n"
        f"root = Path({root!r})\n"
        "if not (__debug__ and sys.dont_write_bytecode):\n"
        "    raise SystemExit('Unoptimized Python with -B required')\n"
        "if not Path.cwd().resolve().is_relative_to(root):\n"
        "    raise SystemExit('Git child escaped the owned source-CI generation')\n"
        "arguments = sys.argv[1:]\n"
        "if any(a.startswith('-c') or a.startswith('--config-env') or 'core.fsmonitor' in a.lower()\n"
        "       or 'core.hookspath' in a.lower() for a in arguments):\n"
        "    raise SystemExit('Git child configuration override refused')\n"
        "current = Path.cwd().resolve()\n"
        "for index, argument in enumerate(arguments):\n"
        "    value = None\n"
        "    if argument in ('--git-dir', '--work-tree', '-C'):\n"
        "        if index + 1 >= len(arguments):\n"
        "            raise SystemExit('Git child path argument missing')\n"
        "        value = arguments[index + 1]\n"
        "    elif argument.startswith(('--git-dir=', '--work-tree=')):\n"
        "        value = argument.split('=', 1)[1]\n"
        "    elif argument.startswith('-C') and argument != '-C':\n"
        "        value = argument[2:]\n"
        "    if value is not None:\n"
        "        resolved = (current / value).resolve()\n"
        "        if not resolved.is_relative_to(root):\n"
        "            raise SystemExit('Git child path escaped the owned generation')\n"
        "        if argument in ('--git-dir', '--work-tree', '-C'):\n"
        "            arguments[index + 1] = str(resolved)\n"
        "        elif argument.startswith(('--git-dir=', '--work-tree=')):\n"
        "            arguments[index] = argument.split('=', 1)[0] + '=' + str(resolved)\n"
        "        else:\n"
        "            arguments[index] = '-C' + str(resolved)\n"
        "        if argument == '-C' or argument.startswith('-C'):\n"
        "            current = resolved\n"
        "environment = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}\n"
        f"environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM={os.devnull!r},\n"
        f"    GIT_CONFIG_GLOBAL={os.devnull!r}, GIT_CONFIG_COUNT='0', GIT_OPTIONAL_LOCKS='0',\n"
        "    GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/usr/bin/false',\n"
        "    SSH_ASKPASS='/usr/bin/false', GIT_NO_LAZY_FETCH='1')\n"
        "git_dir = os.environ.get('GIT_DIR')\n"
        "prefix = []\n"
        "if git_dir:\n"
        "    owned_git_dir = (current / git_dir).resolve(strict=True)\n"
        "    if not owned_git_dir.is_relative_to(root):\n"
        "        raise SystemExit('Foreign Git directory refused')\n"
        "    prefix = ['--git-dir', str(owned_git_dir)]\n"
        f"executable = {executable!r}\n"
        "os.execve(executable, [executable, *prefix,\n"
        "    '-c', 'core.fsmonitor=', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',\n"
        f"    '-c', {'core.hooksPath=' + os.devnull!r}, '-c', 'credential.helper=',\n"
        "    *arguments], environment)\n"
    ).encode()
    with path.open("xb") as output:
        output.write(body)
    path.chmod(0o700)
    return directory, hashlib.sha256(body).hexdigest()


def _patch_paths(source, patch):
    if patch is None:
        return set()
    if not patch.is_absolute() or patch.is_symlink() or not patch.is_file():
        raise BuildError("Patch must be an explicit regular owned file")
    lines = patch.read_text().splitlines()
    headers = set()
    for index, line in enumerate(lines):
        if line.startswith(("new file mode ", "deleted file mode ", "old mode ", "new mode ",
                            "rename from ", "rename to ", "copy from ", "copy to ")):
            raise BuildError("Integration patches may only edit existing regular Rust sources")
        if line.startswith("--- "):
            old = line[4:].split("\t", 1)[0]
            following = lines[index + 1] if index + 1 < len(lines) else ""
            new = following[4:].split("\t", 1)[0] if following.startswith("+++ ") else ""
            name = old[2:] if old.startswith("a/") else ""
            if name not in PATCH_PATHS or new != "b/" + name or name in headers:
                raise BuildError("Patch requires matching approved existing old/new file headers")
            headers.add(name)
    result = subprocess.run(
        _git_arguments("apply", "--numstat", str(patch)), cwd=source,
        env=_git_environment(source), capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise BuildError("Cannot inspect integration patch: " + result.stderr)
    paths = set()
    for line in result.stdout.splitlines():
        added, removed, name = line.split("\t")
        if not added.isdigit() or not removed.isdigit() or name not in PATCH_PATHS or name in paths:
            raise BuildError(f"Patch changes an unapproved or repeated path: {name}")
        target = source / str(_safe_name(name))
        if target.is_symlink() or not target.is_file():
            raise BuildError(f"Patch target is not a regular pinned file: {name}")
        paths.add(name)
    if not paths or paths != headers:
        raise BuildError("Integration patch headers do not match its exact changed paths")
    _git_apply(source, patch, check=True)
    return paths


def _git_apply(root, patch, check=False):
    command = _git_arguments("apply", "--whitespace=error")
    if check:
        command.append("--check")
    result = subprocess.run(
        [*command, str(patch)], cwd=root, env=_git_environment(root),
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise BuildError("Exact integration patch failed: " + result.stderr)


def _cargo_args(args):
    if not args or args[0] not in ("test", "build", "check"):
        raise BuildError("Only locked build/check and bounded source tests are supported")
    package = None
    selector = None
    index = 1
    while index < len(args):
        value = args[index]
        if value in ("-p", "--package") and package is None and index + 1 < len(args):
            package = args[index + 1]
            index += 2
            continue
        if value == "--lib":
            index += 1
            continue
        if args[0] == "test" and selector is None and re.fullmatch(r"cmux_[A-Za-z0-9_]+", value):
            selector = value
            index += 1
            continue
        raise BuildError(f"Unapproved Cargo argument: {value}")
    if package not in {"codex-app-server", "codex-core", "codex-config", MEMBER}:
        raise BuildError("A single approved source package is required")
    if args[0] == "test" and selector is None and package != MEMBER:
        raise BuildError("Source tests require a bounded cmux_ selector")
    return package


def _free_bytes(path):
    return shutil.disk_usage(path).free


def _stop_owned_compiler(process):
    status = None
    error = None
    sent = []
    for value in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        try:
            if os.getpgid(process.pid) != process.pid:
                error = "Owned compiler group changed; no further signal sent"
                break
            os.killpg(process.pid, value)
            sent.append(int(value))
        except ProcessLookupError:
            break
        except OSError as failure:
            error = f"Cannot signal the owned compiler group: {failure}"
            break
        try:
            status = process.wait(timeout=30)
            break
        except subprocess.TimeoutExpired:
            error = f"Owned compiler did not exit after signal {int(value)}"
    if status is None:
        status = process.poll()
    group_gone = False
    for attempt in range(6):
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            group_gone = True
            break
        except OSError as failure:
            error = f"Cannot observe owned compiler group exit: {failure}"
            break
        if attempt < 5:
            time.sleep(0.05)
    confirmed = status is not None and group_gone
    return status, {
        "pid": process.pid, "pgid": process.pid, "signals": sent, "confirmed": confirmed,
        "live_work_uncertain": not confirmed,
        "error": None if confirmed else error or "Owned compiler group exit is unverified",
    }


def run_locked(stage: StageManifest, target: Path, rust_bin: Path, cargo_args: list[str]) -> BuildResult:
    package = _cargo_args(cargo_args)
    if _stage(stage.root) != stage:
        raise BuildError("Stale stage manifest")
    _source(stage.source)
    if package == MEMBER and f"codex-rs/{MEMBER}/Cargo.toml" not in stage.files:
        raise BuildError("Owned member is not staged")
    target, rust_bin = _root(target), _root(rust_bin)
    for first, second in [(target, stage.root), (target, stage.source), (target, rust_bin)]:
        _disjoint(first, second)
    owner = json.loads((stage.root / STAGE_OWNER).read_text())
    previous_target = None
    if target.exists():
        target_manifest = target / TARGET_OWNER
        if target_manifest.is_symlink() or not target_manifest.is_file():
            raise BuildError("Foreign build target is not owned")
        previous_target = json.loads(target_manifest.read_text())
        metadata = target.stat()
        if previous_target != {
            "schema": 1, "root": str(target), "device": metadata.st_dev, "inode": metadata.st_ino,
            "stage_token": owner["token"], "source_tree": UPSTREAM_TREE, "rust_bin": str(rust_bin),
        }:
            raise BuildError("Target belongs to another source/stage/toolchain generation")
    free = _free_bytes(target if target.exists() else target.parent)
    if free < 60 * 1024**3:
        raise BuildError("Heavy compilation held: an admitted 60GiB shared-volume buffer is required")
    for name in ("cargo", "rustc", "rustdoc"):
        executable = rust_bin / name
        if executable.is_symlink() or not executable.is_file() or not os.access(executable, os.X_OK):
            raise BuildError(f"Missing direct pinned compiler: {executable}")
        result = subprocess.run([str(executable), "--version"], capture_output=True, text=True, timeout=30)
        if result.returncode or not result.stdout.startswith(f"{name} 1.95.0 "):
            raise BuildError(f"Direct compiler is not Rust1.95.0: {executable}")
    if previous_target is None:
        target.mkdir()
        metadata = target.stat()
        with (target / TARGET_OWNER).open("x") as handle:
            json.dump({
                "schema": 1, "root": str(target), "device": metadata.st_dev, "inode": metadata.st_ino,
                "stage_token": owner["token"], "source_tree": UPSTREAM_TREE, "rust_bin": str(rust_bin),
            }, handle, sort_keys=True)
    attempt = uuid.uuid4().hex
    log, receipt = target / f"{attempt}.log", target / f"{attempt}.json"
    command = [str(rust_bin / "cargo"), cargo_args[0], "--locked", "--jobs", "2", *cargo_args[1:]]
    gateway, gateway_sha256 = _cargo_git_gateway(target, attempt)
    environment = dict(_git_environment(stage.root), CARGO_TARGET_DIR=str(target), RUSTC=str(rust_bin / "rustc"),
                       RUSTDOC=str(rust_bin / "rustdoc"),
                       PATH=str(gateway) + os.pathsep + str(rust_bin) + os.pathsep + os.defpath,
                       CARGO_NET_GIT_FETCH_WITH_CLI="true",
                       CARGO_INCREMENTAL="0", CARGO_PROFILE_DEV_DEBUG="0", CARGO_PROFILE_TEST_DEBUG="0")
    minimum = free
    failure = None
    cleanup = None
    status = None
    began = time.monotonic()
    with log.open("x") as output:
        process = subprocess.Popen(command, cwd=stage.root / "codex-rs", env=environment,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        while process.poll() is None:
            minimum = min(minimum, _free_bytes(target))
            if minimum < 50 * 1024**3 or time.monotonic() - began > 1200:
                failure = "shared_volume_reserve" if minimum < 50 * 1024**3 else "compiler_deadline"
                status, cleanup = _stop_owned_compiler(process)
                break
            time.sleep(1)
        if cleanup is None:
            status = process.wait()
    snapshot_error = None
    try:
        unchanged = _snapshot(stage.root, [STAGE_OWNER]) == stage.files
    except (BuildError, OSError) as error:
        unchanged = False
        snapshot_error = str(error)
    with receipt.open("x") as handle:
        json.dump({
            "command": command, "exit_code": status, "failure": failure,
            "git_posture": {"kind": "explicit-empty-fsmonitor-B",
                            "cargo_git_gateway": str(gateway / "git"),
                            "gateway_sha256": gateway_sha256,
                            "git_config_count": 0, "git_optional_locks": 0},
            "upstream_commit": UPSTREAM_COMMIT, "source_tree": UPSTREAM_TREE,
            "source_root": str(stage.source), "stage_root": str(stage.root), "target_root": str(target),
            "rust_bin": str(rust_bin), "stage_token": owner["token"],
            "patch_sha256": owner["patch_sha256"], "member_sha256": owner["member_sha256"],
            "stage_files_sha256": hashlib.sha256(json.dumps(stage.files, sort_keys=True).encode()).hexdigest(),
            "release_lock_projection": owner.get("release_lock_projection"),
            "compiler_preset": {
                key: environment[key] for key in (
                    "CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG", "CARGO_PROFILE_TEST_DEBUG"
                )
            },
            "stage_unchanged": unchanged, "minimum_free_bytes": minimum,
            "snapshot_error": snapshot_error, "cleanup": cleanup,
            "elapsed_seconds": time.monotonic() - began,
            "qualification": False,
        }, handle, indent=2)
    if status or failure or not unchanged:
        uncertainty = (
            f"; live work may remain at PID/group {cleanup['pid']}" if cleanup and cleanup["live_work_uncertain"] else ""
        )
        raise BuildError(f"Locked source build failed{uncertainty}; retained evidence: {receipt}")
    return BuildResult(tuple(command), log, receipt, minimum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    acquire = modes.add_parser("acquire")
    acquire.add_argument("--destination", type=Path, required=True)
    prepare = modes.add_parser("stage")
    prepare.add_argument("--source", type=Path, required=True)
    prepare.add_argument("--stage", type=Path, required=True)
    prepare.add_argument("--member", type=Path)
    prepare.add_argument("--patch", type=Path)
    cargo = modes.add_parser("cargo")
    cargo.add_argument("--stage", type=Path, required=True)
    cargo.add_argument("--target", type=Path, required=True)
    cargo.add_argument("--rust-bin", type=Path, required=True)
    cargo.add_argument("cargo_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.mode == "acquire":
            result = acquire_sdk(args.destination)
            output = {"source": str(result.root), "commit": result.commit, "files": len(result.files)}
        elif args.mode == "stage":
            result = prepare_stage(args.source, args.stage, args.member, args.patch)
            output = {"stage": str(result.root), "source_tree": result.source_tree, "files": len(result.files)}
        else:
            command = args.cargo_args[1:] if args.cargo_args[:1] == ["--"] else args.cargo_args
            result = run_locked(_stage(args.stage), args.target, args.rust_bin, command)
            output = {"command": result.command, "log": str(result.log), "receipt": str(result.receipt)}
    except BuildError as error:
        print(f"managed Codex source build refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps(dict(output, qualification=False), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
