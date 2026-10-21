#!/usr/bin/env python3
"""Verify only15 synthetic-cloud actual-Builder capture source tests; never bootstrap or qualify a backend."""

import argparse
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request


MAX_ARCHIVE = 128 * 1024**2
MAX_EXPANDED = 1024**3
ADMIT_BYTES = 60 * 1024**3
STOP_BYTES = 50 * 1024**3
PROJECTED_LOCK_SHA256 = "34726731e842976085e3c122f62ddd5c8d6555bdcb32f5e9361c8e27fb0795bf"
TARGET = "x86_64-unknown-linux-gnu"
COMPONENTS = {
    "rustc": "8426a3d170a5879f5682f5fbdd024a1779b3951e7baba685af2d6dc32a6dfc15",
    "cargo": "e74edd2cf7d0f1f1383b4f00eb90c843750bc489e2ccf7214e6476678a907425",
    "rust-std": "047ea7098803d3500fa1072e9cee5392697e21525559e4458128a2bf874aa382",
}
MISSING = {
    "E0599": ("`new_frozen`",),
    "E0425": ("`start_frozen`", "`FrozenInProcessStartArgs`", "`FrozenInProcessHandle`"),
    "E0412": ("`FrozenInProcessStartArgs`", "`FrozenInProcessHandle`"),
}


class RunnerError(RuntimeError):
    pass


def safe_name(value, package):
    path = PurePosixPath(value)
    if (path.is_absolute() or path.as_posix() != value or not path.parts
            or path.parts[0] != package or ".." in path.parts or "\\" in value):
        raise RunnerError(f"Unsafe compiler archive path: {value!r}")
    return path


def extract_component(data, expected, destination, package, *, max_expanded=MAX_EXPANDED):
    if len(data) > MAX_ARCHIVE:
        raise RunnerError("Compiler archive exceeds compressed bound")
    if hashlib.sha256(data).hexdigest() != expected:
        raise RunnerError("Compiler archive checksum mismatch")
    if destination.exists():
        raise RunnerError("Compiler extraction requires a fresh destination")
    files, directories, links, names = {}, set(), {}, set()
    expanded = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r|xz") as archive:
        for index, member in enumerate(archive):
            if index > 100000:
                raise RunnerError("Compiler archive entry bound exceeded")
            name = member.name.rstrip("/") if member.isdir() else member.name
            path = safe_name(name, package)
            if name in names:
                raise RunnerError(f"Duplicate compiler archive entry: {name}")
            names.add(name)
            if member.isdir():
                directories.add(name)
            elif member.isfile():
                expanded += member.size
                if member.size < 0 or expanded > max_expanded:
                    raise RunnerError("Compiler archive expanded bound exceeded")
                content = archive.extractfile(member).read(member.size + 1)
                if len(content) != member.size:
                    raise RunnerError("Compiler archive member size mismatch")
                files[name] = (content, 0o755 if member.mode & 0o111 else 0o644)
            elif member.issym():
                target = member.linkname
                if PurePosixPath(target).is_absolute() or "\\" in target or "\0" in target:
                    raise RunnerError("Escaping compiler archive symlink")
                resolved = posixpath.normpath(posixpath.join(str(path.parent), target))
                safe_name(resolved, package)
                links[name] = target
            else:
                raise RunnerError(f"Unsupported compiler archive member: {name}")
    for name in names:
        for parent in PurePosixPath(name).parents:
            if str(parent) in links or str(parent) in files:
                raise RunnerError("Compiler archive has a linked/file parent")
    for name, target in links.items():
        resolved = posixpath.normpath(posixpath.join(str(PurePosixPath(name).parent), target))
        if resolved not in files and resolved not in directories:
            raise RunnerError("Compiler link must target a regular archived file/directory")
        # Do not allow lexical '..' to hide traversal through another symlink.
        raw = PurePosixPath(name).parent / target
        partial = PurePosixPath()
        for part in raw.parts:
            partial = partial / part
            if str(partial) in links:
                raise RunnerError("Compiler archive has an indirect symlink target")
    destination.mkdir()
    for name in directories:
        (destination / name).mkdir(parents=True, exist_ok=True)
    for name, (content, mode) in files.items():
        output = destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(content)
        output.chmod(mode)
    for name, target in links.items():
        output = destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.symlink_to(target)


def fetch(url, limit):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RunnerError("Download exceeds its explicit bound")
    return data


def install_compiler(root):
    downloads = root / "compiler-downloads"
    downloads.mkdir()
    toolchain = root / "toolchain"
    toolchain.mkdir()
    for component, expected in COMPONENTS.items():
        package = f"{component}-1.95.0-{TARGET}"
        url = f"https://static.rust-lang.org/dist/2026-04-16/{package}.tar.xz"
        data = fetch(url, MAX_ARCHIVE)
        archive = downloads / f"{package}.tar.xz"
        with archive.open("xb") as stream:
            stream.write(data)
        extracted = downloads / f"{component}-expanded"
        extract_component(data, expected, extracted, package)
        directory = f"rust-std-{TARGET}" if component == "rust-std" else component
        content = extracted / package / directory
        if not content.is_dir() or content.is_symlink():
            raise RunnerError("Missing exact compiler component directory")
        for section in ("bin", "lib", "libexec"):
            source = content / section
            if not source.exists():
                continue
            if not source.is_dir() or source.is_symlink():
                raise RunnerError("Compiler section must be a real directory")
            for path in source.rglob("*"):
                output = toolchain / section / path.relative_to(source)
                if output.exists() or output.is_symlink():
                    if not path.is_dir() or not output.is_dir() or output.is_symlink():
                        raise RunnerError(f"Compiler components overlap: {output}")
            shutil.copytree(source, toolchain / section, symlinks=True, dirs_exist_ok=True)
    for name in ("rustc", "cargo", "rustdoc"):
        executable = toolchain / "bin" / name
        if executable.is_symlink() or not executable.is_file():
            raise RunnerError(f"Missing direct compiler: {name}")
        result = subprocess.run([str(executable), "--version"], capture_output=True,
                                text=True, timeout=30)
        print(result.stdout, end="", flush=True)
        if result.returncode or not result.stdout.startswith(f"{name} 1.95.0 "):
            raise RunnerError("Explicit compiler version pin failed")
    return toolchain / "bin"


def is_capture_green(receipt, log):
    if (receipt.get("exit_code") != 0 or receipt.get("failure") is not None
            or receipt.get("stage_unchanged") is not True or receipt.get("cleanup") is not None
            or receipt.get("minimum_free_bytes", 0) < STOP_BYTES
            or re.search(r"(?m)^error(?:\[|:)", log) or "panicked at" in log):
        return False
    expected = {'capture::tests::capture_discards_reload_inputs_and_retains_same_snapshot': 'ok', 'capture::tests::capture_fixture_actual_builder_positive_control': 'ok', 'capture::tests::capture_preliminary_build_failure_never_calls_cloud_factory': 'ok', 'capture::tests::capture_preserves_actual_config_and_all_runtime_bindings': 'ok', 'capture::tests::capture_preserves_compatible_cloud_requirements_and_provenance': 'ok', 'capture::tests::capture_propagates_cloud_error_instead_of_sealing_local_config': 'ok', 'capture::tests::capture_propagates_factory_construction_error': 'ok', 'capture::tests::capture_rejects_actual_cloud_approval_requirement_without_fallback': 'ok', 'capture::tests::capture_rejects_actual_cloud_catalog_requirement_without_fallback': 'ok', 'capture::tests::capture_rejects_actual_cloud_goals_requirement_without_fallback': 'ok', 'capture::tests::capture_rejects_nil_nonce_before_cloud': 'ok', 'capture::tests::capture_rejects_noncanonical_cwd_before_cloud': 'ok', 'capture::tests::capture_rejects_relative_cwd_before_cloud': 'ok', 'capture::tests::capture_rejects_runtime_path_drift_before_sealing': 'ok', 'capture::tests::capture_rejects_store_not_bound_to_nonce': 'ok'}
    tests = re.findall(r"(?m)^test ([A-Za-z0-9_:]+) \.\.\. (ok|FAILED)$", log)
    results = re.findall(r"(?m)^test result: ([^\n]*)", log)
    return (len(tests) == 15 and dict(tests) == expected
            and re.findall(r"(?m)^running (\d+) tests$", log) == ["15"]
            and len(results) == 1 and results[0].startswith("ok. 15 passed; 0 failed;"))


def emit_file(path, root):
    if not path.is_file() or path.is_symlink() or not path.is_relative_to(root):
        raise RunnerError("Invalid evidence file")
    data = path.read_bytes()
    if len(data) > 32 * 1024**2:
        raise RunnerError(f"Evidence exceeds complete-log retention bound: {path.name}")
    print("SHEPHERD_EVIDENCE_BEGIN " + json.dumps({
        "name": str(path.relative_to(root)), "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(), "encoding": "gzip+base64"}), flush=True)
    encoded = base64.b64encode(gzip.compress(data, mtime=0)).decode()
    for offset in range(0, len(encoded), 2048):
        print("SHEPHERD_EVIDENCE_DATA " + encoded[offset:offset + 2048], flush=True)
    print("SHEPHERD_EVIDENCE_END", flush=True)


def capacity(root, phase, summary):
    free = shutil.disk_usage(root).free
    summary["capacity"].append({"phase": phase, "free_bytes": free})
    print(json.dumps({"phase": phase, "free_bytes": free}), flush=True)
    if free < ADMIT_BYTES:
        raise RunnerError(f"{phase}: fresh 60GiB admission failed")


def load_utility(path):
    spec = importlib.util.spec_from_file_location("managed_codex_build", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def verify_release_projection(stage_root):
    owner = json.loads((stage_root / ".cmux-managed-codex-stage.json").read_text())
    proof = owner["release_lock_projection"]
    if (proof["kind"] != "pinned-release-local-version-projection"
            or proof["manifest_git_blob"] != "3cf0d009a8ecede0fb207cc9ec40ebef30f59b09"
            or proof["original_lock_git_blob"] != "45fca1b150822ec5f09689acef48c346b61a7afd"
            or proof["original_lock_sha256"] != "29b37678141ef79e8548a8f135161e5360cd5c2c775cf497589bcfdfe9efc1a0"
            or proof["projected_lock_sha256"] != PROJECTED_LOCK_SHA256
            or proof["external_package_count"] != 1331
            or proof["qualification"] is not False
            or len(proof["local_packages"]) != 150
            or any(value != {"from": "0.0.0", "to": "0.154.0"}
                   for value in proof["local_packages"].values())
            or hashlib.sha256((stage_root / "codex-rs/Cargo.lock").read_bytes()).hexdigest()
            != "d16eb0a731cfe13d5f63d4a82cac1c02ef765a0786adb6d87aa9a7d99872a5e6"):
        raise RunnerError("Exact reviewed release-local lock projection not established")


def verify_ci_identity():
    if (os.environ.get('GITHUB_REPOSITORY') != 'ourostack/ouroboros'
            or os.environ.get('GITHUB_REPOSITORY_ID') != '1169669354'
            or re.fullmatch(r'[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')) is None):
        raise RunnerError('Exact primary project source-CI identity not established')


def run_source(root):
    verify_ci_identity()
    payload = root / "payload"
    summary = {"qualification": False, "outcome": "infrastructure-failure", "capacity": [],
               "upstream_commit": "6b9826e3aa83b1a5947db50f4332cb9c65f1b340",
               "upstream_tree": "74ba48a4b6b086beb9226a79ffe0f3d9f6d40f52",
               "compiler_components": COMPONENTS, "ci_commit": os.environ["GITHUB_SHA"], "ci_repository": "ourostack/ouroboros",
               "ci_repository_id": 1169669354}
    source, stage_root, target = root / "source", root / "stage", root / "target"
    try:
        for name in ("GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_RUNTIME_TOKEN",
                     "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "SSH_AUTH_SOCK"):
            os.environ.pop(name, None)
        capacity(root, "before-acquisition", summary)
        for tool in ("git", "cc", "pkg-config"):
            result = subprocess.run([tool, "--version"], capture_output=True, text=True, timeout=30)
            if result.returncode:
                raise RunnerError(f"Missing compiler-support prerequisite: {tool}")
            print(result.stdout.splitlines()[0], flush=True)
        rust_bin = install_compiler(root)
        os.environ.update(CARGO_HOME=str(root / "cargo-home"), CARGO_NET_RETRY="1",
                          GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="/usr/bin/false",
                          SSH_ASKPASS="/usr/bin/false", GIT_SSH_COMMAND="ssh -oBatchMode=yes",
                          RUSTUP_AUTO_INSTALL="0")
        utility = load_utility(payload / "build-managed-codex-host.py")
        acquired = utility.acquire_sdk(source)
        summary["source_files"] = len(acquired.files)
        member = root / "member"
        member.mkdir()
        for name, relative in {'member-Cargo.toml': 'Cargo.toml', 'member-src-lib.rs': 'src/lib.rs', 'member-src-main.rs': 'src/main.rs', 'member-src-profile.rs': 'src/profile.rs', 'member-src-policy.rs': 'src/policy.rs', 'member-tests-policy.rs': 'tests/policy.rs', 'member-src-capture.rs': 'src/capture.rs'}.items():
            destination = member / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as output:
                output.write((payload / name).read_bytes())
        stage = utility.prepare_stage(source, stage_root, member,
                                      payload / "managed-codex-frozen-host.patch")
        verify_release_projection(stage_root)
        capacity(root, "before-cargo", summary)
        failure = None
        try:
            utility.run_locked(stage, target, rust_bin,
                               ["test", "-p", "cmux-managed-codex-host", "--lib"])
        except utility.BuildError as error:
            failure = str(error)
        attempts = [path for path in target.glob("*.json") if not path.name.startswith(".")]
        if len(attempts) != 1:
            raise RunnerError(f"Expected one actual Cargo receipt, found {len(attempts)}; {failure}")
        receipt_path = attempts[0]
        receipt = json.loads(receipt_path.read_text())
        log = receipt_path.with_suffix(".log").read_text()
        summary["attempt"] = str(receipt_path.relative_to(root))
        summary["build_error"] = failure
        if failure is None and is_capture_green(receipt, log):
            summary["outcome"] = "closed-capture-15tests-green"
            summary["notCompletion"] = "All15 unchanged capture source tests passed through the production private pipeline with synthetic cloud factories. Normal preparation is source-reviewed, not real-account executed. Existing49 policy test bytes remain unchanged and are not reexecuted in this unit. Descriptor/bridge/native/runtime/V1 remain open; main startup disabled; no qualification."
            return 0
        raise RunnerError("Exact15 unchanged capture tests did not pass cleanly")
    except Exception as error:
        summary["error"] = repr(error)
        print("Capture source GREEN NOT established: " + repr(error), file=sys.stderr, flush=True)
        return 1
    finally:
        with (root / "run-summary.json").open("x") as stream:
            json.dump(summary, stream, indent=2)
            stream.write("\n")
        evidence = [root / "run-summary.json", payload / "snapshot.json"]
        for name in (source / ".cmux-managed-codex-source.json",
                     stage_root / ".cmux-managed-codex-stage.json"):
            if name.exists():
                evidence.append(name)
        if target.exists():
            evidence.extend(sorted(target.glob("*.json")))
            evidence.extend(sorted(target.glob("*.log")))
        for path in evidence:
            emit_file(path, root)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_OS") != "Linux"):
        raise RunnerError("This candidate is for the exact reviewed ephemeral Linux CI run only")
    verify_ci_identity()
    run_id, commit = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_SHA"]
    if not run_id.isdecimal() or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise RunnerError("Invalid exact CI identity")
    base = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    if (not root.is_absolute() or root.resolve(strict=True) != root or root.parent != base
            or root.name != f"shepherd-capture-green-source-{run_id}" or root.is_symlink()):
        raise RunnerError("Runner root ownership mismatch")
    marker = json.loads((root / "owner.json").read_text())
    if marker != {"repository": "ourostack/ouroboros", "repository_id": 1169669354,
                  "run": run_id, "commit": commit}:
        raise RunnerError("Runner root generation mismatch")
    return run_source(root)


if __name__ == "__main__":
    raise SystemExit(main())
