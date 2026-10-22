#!/usr/bin/env python3
"""Bounded remote-only native-factory behavioral diagnostic."""

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


SUITES = {'cmux_bridge_': {'package': 'cmux-managed-codex-host', 'command': ['test', '--locked', '--jobs', '2', '-p', 'cmux-managed-codex-host', '--lib', 'cmux_bridge_'], 'names': ['bridge::tests::cmux_bridge_bootstrap_thread_started_before_ready_joins_unchanged_response', 'bridge::tests::cmux_bridge_bootstrap_thread_started_after_ready_joins_unchanged_response', 'bridge::tests::cmux_bridge_bootstrap_thread_started_foreign_id_is_rejected', 'bridge::tests::cmux_bridge_bootstrap_thread_started_duplicate_is_drained_and_rejected', 'bridge::tests::cmux_bridge_bootstrap_thread_started_critical_fields_must_match', 'bridge::tests::cmux_bridge_bootstrap_thread_started_oversized_noncritical_payload_is_rejected', 'bridge::tests::cmux_bridge_descriptor_precedes_factory_and_input', 'bridge::tests::cmux_bridge_matching_initialize_returns_actual_typed_readiness_once', 'bridge::tests::cmux_bridge_nonce_or_digest_mismatch_never_constructs_backend', 'bridge::tests::cmux_bridge_duplicate_initialize_and_foreign_thread_fail_before_dispatch', 'bridge::tests::cmux_bridge_reserved_integer_ids_fail_but_string_ids_preserve_literal', 'bridge::tests::cmux_bridge_registered_control_preserves_exact_tuple_nonce_and_result', 'bridge::tests::cmux_bridge_unregistered_or_typed_foreign_control_never_delivers', 'bridge::tests::cmux_bridge_publication_pending_retains_response_until_success', 'bridge::tests::cmux_bridge_publication_failure_never_delivers_retained_response', 'bridge::tests::cmux_bridge_blocked_work_and_queued_page_do_not_block_registered_control', 'bridge::tests::cmux_bridge_backend_terminal_wakes_blocked_publication', 'bridge::tests::cmux_bridge_actual_os_pipes_preserve_typed_request_and_literal', 'bridge::tests::cmux_bridge_pre_initialize_work_never_constructs_backend', 'bridge::tests::cmux_bridge_completed_request_id_cannot_dispatch_again', 'bridge::tests::cmux_bridge_unresolved_root_refuses_second_turn_before_dispatch', 'bridge::tests::cmux_bridge_duplicate_native_result_never_delivers_twice', 'bridge::tests::cmux_bridge_native_nonce_is_unique_across_registered_callbacks', 'bridge::tests::cmux_bridge_worker_panic_returns_terminal_uncertainty_and_cleans_backend', 'bridge::tests::cmux_bridge_retained_output_budget_exhaustion_never_claims_readiness', 'bridge::tests::cmux_bridge_invalid_native_command_never_reaches_output', 'bridge::tests::cmux_bridge_exact_echo_and_terminal_publish_before_next_helper_root', 'bridge::tests::cmux_bridge_early_echo_and_terminal_cannot_release_pending_control', 'bridge::tests::cmux_bridge_early_echo_join_releases_only_after_checked_control_returns', 'bridge::tests::cmux_bridge_foreign_or_mismatched_consumed_echo_never_reaches_output', 'bridge::tests::cmux_bridge_terminal_frontier_retains_next_root_until_full_flush', 'bridge::tests::cmux_bridge_terminal_frontier_failure_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_terminal_frontier_cancellation_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_work_response_frontier_retains_next_root_until_full_flush', 'bridge::tests::cmux_bridge_work_response_frontier_failure_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_zero_callback_root_requires_started_and_healthy_terminal', 'bridge::tests::cmux_bridge_orphan_started_item_never_releases_root', 'bridge::tests::cmux_bridge_duplicate_exact_echo_is_rejected_before_output', 'bridge::tests::cmux_bridge_failed_or_interrupted_terminal_never_reaches_output', 'bridge::tests::cmux_bridge_unstarted_terminal_never_reaches_output', 'bridge::tests::cmux_bridge_duplicate_terminal_cannot_erase_pending_control', 'bridge::tests::cmux_bridge_late_registered_item_callback_after_terminal_is_rejected', 'bridge::tests::cmux_bridge_late_echo_after_root_settlement_is_rejected', 'bridge::tests::cmux_bridge_prior_actual_turn_cannot_bind_next_unresolved_work_response', 'bridge::tests::cmux_bridge_exact_failed_native_result_can_join_healthy_turn', 'bridge::tests::cmux_bridge_only_one_next_root_can_be_retained_at_terminal_frontier', 'bridge::tests::cmux_bridge_native_result_payload_budget_exhaustion_delivers_zero_control', 'bridge::tests::cmux_bridge_request_lifetime_budget_is_not_reset_by_completed_pages', 'bridge::tests::cmux_bridge_prior_item_id_cannot_be_reused_in_new_actual_turn', 'bridge::tests::cmux_bridge_outer_cancellation_while_checked_control_pending_delivers_zero', 'bridge::tests::cmux_bridge_work_response_frontier_cancellation_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_truncated_result_eof_preserves_terminal_uncertainty', 'bridge::tests::cmux_bridge_full_output_and_event_queues_do_not_block_registered_control_or_terminal', 'bridge::tests::cmux_bridge_sdk_public_violation_waiter_typechecks', 'bridge::tests::cmux_bridge_healthy_thread_status_idle_is_internal_and_work_progresses', 'bridge::tests::cmux_bridge_healthy_thread_status_active_preserves_turn_lifecycle', 'bridge::tests::cmux_bridge_healthy_thread_status_foreign_thread_is_rejected', 'bridge::tests::cmux_bridge_healthy_thread_status_forbidden_variants_are_rejected', 'bridge::tests::cmux_bridge_healthy_thread_status_cannot_replace_bootstrap_witness', 'bridge::tests::cmux_bridge_healthy_thread_status_oversized_identifier_is_rejected', 'bridge::tests::cmux_bridge_native_factory_constructs_deferred_sdk_and_retains_catalog', 'bridge::tests::cmux_bridge_native_terminal_waits_for_owner_failure', 'bridge::tests::cmux_bridge_native_terminal_observes_already_failed_owner', 'bridge::tests::cmux_bridge_native_terminal_clones_observe_shared_failure']}}

"""Require an exact controlled source test suite and a clean pinned receipt."""
import re

PUBLIC_WAITER_PATCH_SHA256 = "fe327838f4e4c909d41eb36ec9d34b702ab87bec7ff7cb8c488064cc84ab8922"
PUBLIC_WAITER_STOP_BYTES = 50 * 1024**3

FACTORY_FAILURES = {
    "bridge::tests::cmux_bridge_native_factory_constructs_deferred_sdk_and_retains_catalog":
        "CMUX_NATIVE_FACTORY_START_UNSUPPORTED",
    "bridge::tests::cmux_bridge_native_terminal_waits_for_owner_failure":
        "CMUX_NATIVE_TERMINAL_EARLY_UNSUPPORTED",
    "bridge::tests::cmux_bridge_native_terminal_observes_already_failed_owner":
        "CMUX_NATIVE_TERMINAL_OWNER_FAILURE_KIND",
    "bridge::tests::cmux_bridge_native_terminal_clones_observe_shared_failure":
        "CMUX_NATIVE_TERMINAL_CLONE_EARLY",
}


def is_exact_factory_red(receipt, log, *, command, names):
    actual_command = receipt.get("command")
    if (not isinstance(actual_command, list) or len(actual_command) != len(command) + 1
            or actual_command[1:] != command
            or receipt.get("exit_code") != 101 or receipt.get("failure") is not None
            or receipt.get("cleanup") is not None or receipt.get("snapshot_error") is not None
            or receipt.get("stage_unchanged") is not True
            or receipt.get("qualification") is not False
            or receipt.get("patch_sha256") != PUBLIC_WAITER_PATCH_SHA256
            or receipt.get("minimum_free_bytes", 0) < PUBLIC_WAITER_STOP_BYTES):
        return False
    if (len(names) != 64 or len(names) != len(set(names))
            or not set(FACTORY_FAILURES) <= set(names)
            or not all(marker in log for marker in FACTORY_FAILURES.values())
            or any(marker in log for marker in (
                "CMUX_BRIDGE_FIXTURE_TIMEOUT",
                "CMUX_BRIDGE_SETTLEMENT_NOT_IMPLEMENTED", "CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED",
                "could not compile", "\x1b",
            ))
            or re.search(r"(?m)^error", log)):
        return False
    count = len(names)
    tests = re.findall(r"(?m)^test ([A-Za-z0-9_:]+) \.\.\. (ok|FAILED)$", log)
    results = re.findall(r"(?m)^test result: ([^\n]*)", log)
    return (
        len(tests) == count and dict(tests) == {
            name: "FAILED" if name in FACTORY_FAILURES else "ok" for name in names
        }
        and re.findall(r"(?m)^running (\d+) tests?$", log) == [str(count)]
        and len(results) == 1
        and re.fullmatch(
            r"FAILED\. 60 passed; 4 failed; 0 ignored; 0 measured; "
            r"[0-9]+ filtered out; finished in [0-9]+(?:\.[0-9]+)?s",
            results[0],
        ) is not None
    )


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
            != "60095780144a87f46c44809993ce374e3a591a1dcaa6806d23b3fa9087de6697"):
        raise RunnerError("Exact reviewed release-local lock projection not established")


def verify_ci_identity():
    if (os.environ.get('GITHUB_REPOSITORY') != 'ourostack/ouroboros'
            or os.environ.get('GITHUB_REPOSITORY_ID') != '1169669354'
            or re.fullmatch(r'[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')) is None):
        raise RunnerError('Exact primary project source-CI identity not established')


def run_source(root):
    if not (__debug__ and sys.dont_write_bytecode):
        raise RunnerError("Unoptimized Python with -B required before source execution")
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
        for name in tuple(os.environ):
            if name.startswith("GIT_"):
                os.environ.pop(name)
        utility = load_utility(payload / "build-managed-codex-host.py")
        os.environ.update({
            key: value for key, value in utility._git_environment(root).items()
            if key.startswith("GIT_") or key == "SSH_ASKPASS"
        })
        capacity(root, "before-acquisition", summary)
        for tool in ("git", "cc", "pkg-config"):
            arguments = utility._git_arguments("--version") if tool == "git" else [tool, "--version"]
            result = subprocess.run(arguments, capture_output=True, text=True, timeout=30,
                                    env=utility._git_environment(root))
            if result.returncode:
                raise RunnerError(f"Missing compiler-support prerequisite: {tool}")
            print(result.stdout.splitlines()[0], flush=True)
        rust_bin = install_compiler(root)
        os.environ.update(CARGO_HOME=str(root / "cargo-home"), CARGO_NET_RETRY="1", RUST_BACKTRACE="0",
                          GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="/usr/bin/false",
                          SSH_ASKPASS="/usr/bin/false", GIT_SSH_COMMAND="ssh -oBatchMode=yes",
                          RUSTUP_AUTO_INSTALL="0")
        acquired = utility.acquire_sdk(source)
        summary["source_files"] = len(acquired.files)
        member = root / "member"
        member.mkdir()
        for name, relative in {'member-Cargo.toml': 'Cargo.toml', 'member-src-lib.rs': 'src/lib.rs', 'member-src-main.rs': 'src/main.rs', 'member-src-profile.rs': 'src/profile.rs', 'member-src-policy.rs': 'src/policy.rs', 'member-tests-policy.rs': 'tests/policy.rs', 'member-src-preparation-tests.rs': 'src/preparation_tests.rs', 'member-src-capture.rs': 'src/capture.rs', 'member-src-descriptor.rs': 'src/descriptor.rs', 'member-src-descriptor-tests.rs': 'src/descriptor_tests.rs', 'member-src-wire.rs': 'src/wire.rs', 'member-tests-wire.rs': 'tests/wire.rs', 'member-src-bridge.rs': 'src/bridge.rs', 'member-src-bridge-tests.rs': 'src/bridge_tests.rs'}.items():
            destination = member / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as output:
                output.write((payload / name).read_bytes())
        stage = utility.prepare_stage(source, stage_root, member,
                                      payload / "managed-codex-frozen-host.patch")
        verify_release_projection(stage_root)
        capacity(root, "before-cargo", summary)
        summary["attempts"] = []
        for selector, group in SUITES.items():
            package, library_only = group["package"], True
            prior = {path for path in target.glob("*.json") if not path.name.startswith(".")}
            capacity(root, "before-" + (selector or "all-member"), summary)
            arguments = ["test", "-p", package] + (["--lib"] if library_only else []) + ([selector] if selector else [])
            failure = None
            try:
                utility.run_locked(stage, target, rust_bin, arguments)
            except utility.BuildError as error:
                failure = str(error)
            current = {path for path in target.glob("*.json") if not path.name.startswith(".")}
            fresh = current - prior
            if len(fresh) != 1:
                raise RunnerError(f"Expected one new receipt for {selector}, found {len(fresh)}; {failure}")
            receipt_path, = fresh
            receipt = json.loads(receipt_path.read_text())
            log = receipt_path.with_suffix(".log").read_text()
            summary["attempts"].append({
                "selector": selector, "receipt": str(receipt_path.relative_to(root)),
                "build_error": failure,
            })
            if (failure is not None or not is_exact_factory_red(
                    receipt, log, command=group["command"], names=group["names"])):
                raise RunnerError(f"Exact64 native-factory behavioral RED not established for {selector}")
        summary["outcome"] = "native-factory-64-behavioral-red"
        summary["notCompletion"] = 'Exactly64 source cases: original60 controls plus four expected native-factory/terminal failures. Real isolated Config capture and deferred SDK constructor/guard only; no wait_ready, thread/model/provider bootstrap, native UI, lease/watch integration or runtime qualification. Factory start and terminal remain Unsupported in this RED candidate.'
        return 0
    except Exception as error:
        summary["error"] = repr(error)
        print("Native factory behavioral RED NOT established: " + repr(error), file=sys.stderr, flush=True)
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
            evidence.extend(sorted(target.glob("git-posture-*/git")))
        for path in evidence:
            emit_file(path, root)


def main():
    if not (__debug__ and sys.dont_write_bytecode):
        raise RunnerError("Unoptimized Python with -B required")
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
            or root.name != f"shepherd-native-factory-red-source-{run_id}" or root.is_symlink()):
        raise RunnerError("Runner root ownership mismatch")
    marker = json.loads((root / "owner.json").read_text())
    if marker != {"repository": "ourostack/ouroboros", "repository_id": 1169669354,
                  "run": run_id, "commit": commit}:
        raise RunnerError("Runner root generation mismatch")
    return run_source(root)


if __name__ == "__main__":
    raise SystemExit(main())
