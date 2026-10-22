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


SUITES = {'cmux_entry_': {'package': 'cmux-managed-codex-host', 'libraryOnly': False, 'command': ['test', '--locked', '--jobs', '2', '-p', 'cmux-managed-codex-host', 'cmux_entry_'], 'names': ['cmux_entry_describe_profile_is_pure_and_matches_library', 'cmux_entry_unknown_or_extra_arguments_never_emit_profile', 'cmux_entry_profile_output_failure_never_claims_success'], 'positive_counts': [3], 'running_counts': [0, 0, 0, 3, 0]}, '': {'package': 'cmux-managed-codex-host', 'libraryOnly': False, 'command': ['test', '--locked', '--jobs', '2', '-p', 'cmux-managed-codex-host'], 'names': ['bridge::tests::cmux_bridge_bootstrap_thread_started_before_ready_joins_unchanged_response', 'bridge::tests::cmux_bridge_bootstrap_thread_started_after_ready_joins_unchanged_response', 'bridge::tests::cmux_bridge_bootstrap_thread_started_foreign_id_is_rejected', 'bridge::tests::cmux_bridge_bootstrap_thread_started_duplicate_is_drained_and_rejected', 'bridge::tests::cmux_bridge_bootstrap_thread_started_critical_fields_must_match', 'bridge::tests::cmux_bridge_bootstrap_thread_started_oversized_noncritical_payload_is_rejected', 'bridge::tests::cmux_bridge_descriptor_precedes_factory_and_input', 'bridge::tests::cmux_bridge_matching_initialize_returns_actual_typed_readiness_once', 'bridge::tests::cmux_bridge_nonce_or_digest_mismatch_never_constructs_backend', 'bridge::tests::cmux_bridge_duplicate_initialize_and_foreign_thread_fail_before_dispatch', 'bridge::tests::cmux_bridge_reserved_integer_ids_fail_but_string_ids_preserve_literal', 'bridge::tests::cmux_bridge_registered_control_preserves_exact_tuple_nonce_and_result', 'bridge::tests::cmux_bridge_unregistered_or_typed_foreign_control_never_delivers', 'bridge::tests::cmux_bridge_publication_pending_retains_response_until_success', 'bridge::tests::cmux_bridge_publication_failure_never_delivers_retained_response', 'bridge::tests::cmux_bridge_blocked_work_and_queued_page_do_not_block_registered_control', 'bridge::tests::cmux_bridge_backend_terminal_wakes_blocked_publication', 'bridge::tests::cmux_bridge_actual_os_pipes_preserve_typed_request_and_literal', 'bridge::tests::cmux_bridge_pre_initialize_work_never_constructs_backend', 'bridge::tests::cmux_bridge_completed_request_id_cannot_dispatch_again', 'bridge::tests::cmux_bridge_unresolved_root_refuses_second_turn_before_dispatch', 'bridge::tests::cmux_bridge_duplicate_native_result_never_delivers_twice', 'bridge::tests::cmux_bridge_native_nonce_is_unique_across_registered_callbacks', 'bridge::tests::cmux_bridge_worker_panic_returns_terminal_uncertainty_and_cleans_backend', 'bridge::tests::cmux_bridge_retained_output_budget_exhaustion_never_claims_readiness', 'bridge::tests::cmux_bridge_invalid_native_command_never_reaches_output', 'bridge::tests::cmux_bridge_exact_echo_and_terminal_publish_before_next_helper_root', 'bridge::tests::cmux_bridge_early_echo_and_terminal_cannot_release_pending_control', 'bridge::tests::cmux_bridge_early_echo_join_releases_only_after_checked_control_returns', 'bridge::tests::cmux_bridge_foreign_or_mismatched_consumed_echo_never_reaches_output', 'bridge::tests::cmux_bridge_terminal_frontier_retains_next_root_until_full_flush', 'bridge::tests::cmux_bridge_terminal_frontier_failure_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_terminal_frontier_cancellation_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_work_response_frontier_retains_next_root_until_full_flush', 'bridge::tests::cmux_bridge_work_response_frontier_failure_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_zero_callback_root_requires_started_and_healthy_terminal', 'bridge::tests::cmux_bridge_orphan_started_item_never_releases_root', 'bridge::tests::cmux_bridge_duplicate_exact_echo_is_rejected_before_output', 'bridge::tests::cmux_bridge_failed_or_interrupted_terminal_never_reaches_output', 'bridge::tests::cmux_bridge_unstarted_terminal_never_reaches_output', 'bridge::tests::cmux_bridge_duplicate_terminal_cannot_erase_pending_control', 'bridge::tests::cmux_bridge_late_registered_item_callback_after_terminal_is_rejected', 'bridge::tests::cmux_bridge_late_echo_after_root_settlement_is_rejected', 'bridge::tests::cmux_bridge_prior_actual_turn_cannot_bind_next_unresolved_work_response', 'bridge::tests::cmux_bridge_exact_failed_native_result_can_join_healthy_turn', 'bridge::tests::cmux_bridge_only_one_next_root_can_be_retained_at_terminal_frontier', 'bridge::tests::cmux_bridge_native_result_payload_budget_exhaustion_delivers_zero_control', 'bridge::tests::cmux_bridge_request_lifetime_budget_is_not_reset_by_completed_pages', 'bridge::tests::cmux_bridge_prior_item_id_cannot_be_reused_in_new_actual_turn', 'bridge::tests::cmux_bridge_outer_cancellation_while_checked_control_pending_delivers_zero', 'bridge::tests::cmux_bridge_work_response_frontier_cancellation_never_dispatches_retained_root', 'bridge::tests::cmux_bridge_truncated_result_eof_preserves_terminal_uncertainty', 'bridge::tests::cmux_bridge_full_output_and_event_queues_do_not_block_registered_control_or_terminal', 'bridge::tests::cmux_bridge_sdk_public_violation_waiter_typechecks', 'bridge::tests::cmux_bridge_healthy_thread_status_idle_is_internal_and_work_progresses', 'bridge::tests::cmux_bridge_healthy_thread_status_active_preserves_turn_lifecycle', 'bridge::tests::cmux_bridge_healthy_thread_status_foreign_thread_is_rejected', 'bridge::tests::cmux_bridge_healthy_thread_status_forbidden_variants_are_rejected', 'bridge::tests::cmux_bridge_healthy_thread_status_cannot_replace_bootstrap_witness', 'bridge::tests::cmux_bridge_healthy_thread_status_oversized_identifier_is_rejected', 'bridge::tests::cmux_bridge_native_factory_constructs_deferred_sdk_and_retains_catalog', 'bridge::tests::cmux_bridge_native_terminal_waits_for_owner_failure', 'bridge::tests::cmux_bridge_native_terminal_observes_already_failed_owner', 'bridge::tests::cmux_bridge_native_terminal_clones_observe_shared_failure', 'bridge::tests::cmux_bridge_native_catalog_survives_backend_drop', 'bridge::tests::cmux_bridge_native_catalog_survives_unpolled_shutdown', 'bridge::tests::cmux_bridge_native_catalog_survives_failed_cleanup', 'bridge::tests::cmux_bridge_native_catalog_survives_polled_shutdown_cancellation', 'bridge::tests::cmux_bridge_native_catalog_survives_unwind', 'capture::tests::capture_fixture_actual_builder_positive_control', 'capture::tests::capture_preserves_actual_config_and_all_runtime_bindings', 'capture::tests::capture_preserves_compatible_cloud_requirements_and_provenance', 'capture::tests::capture_rejects_actual_cloud_goals_requirement_without_fallback', 'capture::tests::capture_rejects_actual_cloud_approval_requirement_without_fallback', 'capture::tests::capture_rejects_actual_cloud_catalog_requirement_without_fallback', 'capture::tests::capture_propagates_cloud_error_instead_of_sealing_local_config', 'capture::tests::capture_propagates_factory_construction_error', 'capture::tests::capture_preliminary_build_failure_never_calls_cloud_factory', 'capture::tests::capture_rejects_nil_nonce_before_cloud', 'capture::tests::capture_rejects_relative_cwd_before_cloud', 'capture::tests::capture_rejects_noncanonical_cwd_before_cloud', 'capture::tests::capture_rejects_runtime_path_drift_before_sealing', 'capture::tests::capture_rejects_store_not_bound_to_nonce', 'capture::tests::capture_discards_reload_inputs_and_retains_same_snapshot', 'capture::tests::cmux_descriptor_native_tool_matches_existing_native_registry', 'capture::tests::cmux_descriptor_thread_options_are_typed_and_have_no_semantic_overrides', 'capture::tests::cmux_descriptor_turn_options_preserve_literal_and_disable_environments', 'capture::tests::cmux_descriptor_static_manifest_binds_exact_source_catalog_schema_and_options', 'capture::tests::cmux_descriptor_reports_actual_sealed_values_and_exact_runtime_bindings', 'capture::tests::cmux_descriptor_never_exports_raw_config_loaded_strings_or_runtime_paths', 'capture::tests::cmux_descriptor_is_snapshot_only_after_files_and_cloud_sources_change', 'capture::tests::cmux_descriptor_separates_birth_binding_from_static_profile_identity', 'capture::tests::cmux_descriptor_refuses_synthetic_critical_policy_drift_before_export', 'capture::tests::cmux_descriptor_startup_initialize_matches_closed_sdk_contract', 'capture::tests::cmux_descriptor_startup_session_source_is_native_owned', 'capture::tests::cmux_descriptor_startup_disables_api_key_env', 'capture::tests::cmux_descriptor_startup_sdk_channel_capacity_is_one', 'capture::tests::cmux_descriptor_startup_options_have_only_four_source_owned_fields', 'capture::tests::cmux_descriptor_startup_shared_typed_producer_matches_manifest', 'capture::tests::cmux_descriptor_startup_native_tool_uses_actual_sdk_registry_type', 'capture::preparation_tests::cmux_preparation_fixed_native_inputs_are_actual_derived_policy', 'capture::preparation_tests::cmux_preparation_retains_managed_requirements_and_loaded_strings', 'capture::preparation_tests::cmux_preparation_managed_approval_normalization_is_rejected_before_seal', 'capture::preparation_tests::cmux_preparation_unoverridden_notify_is_rejected_before_seal', 'capture::preparation_tests::cmux_preparation_invalid_birth_never_prepares_a_profile', 'capture::preparation_tests::cmux_preparation_distinct_births_have_distinct_actual_memory_stores', 'policy_accepts_actual_builder_positive_control_without_mutation', 'policy_rejects_foreign_cwd', 'policy_rejects_effective_mcp_map_even_with_empty_cli_override', 'policy_rejects_actual_managed_feature_conflict_before_start', 'policy_rejects_actual_managed_catalog_override', 'policy_rejects_actual_managed_approval_requirements', 'policy_preserves_requirements_and_full_catalog_after_files_change', 'policy_catalog_is_one_complete_compiled_entry_with_exact_direct_mode', 'policy_rejects_multi_agent_v2', 'policy_rejects_goals', 'policy_rejects_memories', 'policy_rejects_guardian_approval', 'policy_rejects_sleep', 'policy_rejects_code_mode', 'policy_rejects_code_mode_only', 'policy_rejects_code_mode_prewarm', 'policy_rejects_hooks', 'policy_rejects_live_web_feature', 'policy_rejects_cached_web_feature', 'policy_rejects_image_generation', 'policy_rejects_apps', 'policy_rejects_plugins', 'policy_rejects_skill_mcp_install', 'policy_rejects_skill_search', 'policy_rejects_agents', 'policy_rejects_persistent_state', 'policy_rejects_memory_generation', 'policy_rejects_memory_use', 'policy_rejects_memory_tools', 'policy_rejects_legacy_notify', 'policy_rejects_history_notes', 'policy_rejects_orchestrator_skills', 'policy_rejects_orchestrator_mcp', 'policy_rejects_approval_policy', 'policy_rejects_live_web_mode', 'policy_rejects_wrong_model', 'policy_rejects_missing_model', 'policy_rejects_wrong_provider', 'policy_rejects_provider_redefinition', 'policy_rejects_local_store', 'policy_rejects_foreign_store', 'policy_rejects_missing_catalog', 'policy_rejects_empty_catalog', 'policy_rejects_extra_catalog_entry', 'policy_rejects_async_catalog_tool', 'policy_rejects_model_delegation', 'policy_rejects_implicit_tool_mode', 'policy_rejects_code_mode_metadata', 'policy_rejects_changed_full_metadata', 'cmux_wire_initialize_preserves_exact_nonce_digest_and_typed_id', 'cmux_wire_preserves_string_and_i64_extremes_without_coercion', 'cmux_wire_os_pipe_fragments_preserve_literal_text_and_frame_order', 'cmux_wire_prompt_limit_counts_utf8_bytes_at_65536_and_65537', 'cmux_wire_frame_limit_includes_lf_delimiter_and_all_whitespace', 'cmux_wire_refuses_unterminated_frame_at_reserved_delimiter_bound', 'cmux_wire_fragmented_multibyte_utf8_is_accepted_only_after_complete_frame', 'cmux_wire_rejects_bool_float_null_overflow_and_unbounded_ids', 'cmux_wire_rejects_duplicate_and_escaped_duplicate_keys_at_every_depth', 'cmux_wire_rejects_envelope_extras_traces_notifications_errors_and_nonobjects', 'cmux_wire_rejects_all_nonprivate_mutation_and_execution_routes', 'cmux_wire_initialize_rejects_noncanonical_nil_missing_or_invalid_bindings', 'cmux_wire_turn_rejects_input_variants_text_elements_and_semantic_overrides', 'cmux_wire_shell_page_matches_exact_native_pager_shape', 'cmux_wire_shell_page_rejects_limit_cursor_and_extra_field_drift', 'cmux_wire_tool_response_uses_actual_sdk_envelope_and_retains_nonce_text', 'cmux_wire_tool_response_rejects_extra_media_items_nonce_drift_and_success_coercion', 'cmux_wire_rejects_invalid_utf8_json_empty_lines_and_trailing_documents', 'cmux_wire_partial_json_utf8_and_even_clean_eof_permanently_fail', 'cmux_entry_describe_profile_is_pure_and_matches_library', 'cmux_entry_unknown_or_extra_arguments_never_emit_profile', 'cmux_entry_profile_output_failure_never_claims_success'], 'positive_counts': [106, 49, 22], 'running_counts': [106, 0, 49, 22, 0]}}

import re


PUBLIC_WAITER_PATCH_SHA256 = "fe327838f4e4c909d41eb36ec9d34b702ab87bec7ff7cb8c488064cc84ab8922"

PUBLIC_WAITER_STOP_BYTES = 50 * 1024**3

def is_exact_factory_green(
        receipt, log, *, command, names, positive_counts, running_counts=None):
    actual_command = receipt.get("command")
    if (not isinstance(actual_command, list) or len(actual_command) != len(command) + 1
            or actual_command[1:] != command
            or receipt.get("exit_code") != 0 or receipt.get("failure") is not None
            or receipt.get("cleanup") is not None or receipt.get("snapshot_error") is not None
            or receipt.get("stage_unchanged") is not True
            or receipt.get("qualification") is not False
            or receipt.get("patch_sha256") != PUBLIC_WAITER_PATCH_SHA256
            or receipt.get("minimum_free_bytes", 0) < PUBLIC_WAITER_STOP_BYTES):
        return False
    if (not names or len(names) != len(set(names)) or not positive_counts
            or any(type(value) is not int or value <= 0 for value in positive_counts)
            or sum(positive_counts) != len(names)
            or any(marker in log for marker in (
                "panicked at", "CMUX_BRIDGE_FIXTURE_TIMEOUT",
                "CMUX_BRIDGE_SETTLEMENT_NOT_IMPLEMENTED", "CMUX_BRIDGE_BEHAVIOR_NOT_IMPLEMENTED",
                "could not compile", "\x1b",
            ))
            or re.search(r"(?m)^error", log)):
        return False
    count = len(names)
    tests = re.findall(r"(?m)^test ([A-Za-z0-9_:]+) \.\.\. (ok|FAILED)$", log)
    results = re.findall(r"(?m)^test result: ([^\n]*)", log)
    running = [int(value) for value in re.findall(r"(?m)^running (\d+) tests?$", log)]
    return (
        len(tests) == count and dict(tests) == {name: "ok" for name in names}
        and [value for value in running if value] == positive_counts
        and ((running_counts is None and running.count(0) <= 2)
             or (running_counts is not None and running == running_counts))
        and len(results) == len(running)
        and all(re.fullmatch(
            rf"ok\. {value} passed; 0 failed; 0 ignored; 0 measured; "
            r"[0-9]+ filtered out; finished in [0-9]+(?:\.[0-9]+)?s",
            result,
        ) is not None for value, result in zip(running, results))
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
        source_suite_failures = []
        for selector, group in SUITES.items():
            package, library_only = group["package"], group["libraryOnly"]
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
            if failure is not None or not is_exact_factory_green(
                    receipt, log, command=group["command"], names=group["names"],
                    positive_counts=group["positive_counts"],
                    running_counts=group["running_counts"]):
                source_suite_failures.append(selector or "all-member")

        if source_suite_failures:
            raise RunnerError(f"Complete pure-profile source suites failed: {source_suite_failures}")
        binary = target / "debug/cmux-managed-codex-host"
        if not binary.is_file() or binary.is_symlink():
            raise RunnerError("Actual helper executable missing")
        binary_sha = hashlib.sha256()
        with binary.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                binary_sha.update(chunk)
        forbidden_home = root / "pure-profile-must-not-create"
        pure = subprocess.run(
            [str(binary), "--describe-profile"], cwd=root, stdin=subprocess.DEVNULL,
            capture_output=True, timeout=5,
            env={"PATH": "/usr/bin:/bin", "HOME": str(forbidden_home),
                 "CODEX_HOME": str(forbidden_home)})
        if (pure.returncode != 0 or pure.stderr or len(pure.stdout) > 65536
                or not pure.stdout.endswith(b"\n") or pure.stdout.count(b"\n") != 1
                or forbidden_home.exists()):
            raise RunnerError("Actual helper pure-profile execution failed")
        profile = json.loads(pure.stdout)
        if (profile["profileId"] != "codex-0.154-frozen-native-foreground-v1"
                or profile["privateBridgeVersion"] != 1
                or profile["upstreamCommit"] != summary["upstream_commit"]
                or profile["integrationPatchSha256"] !=
                "fe327838f4e4c909d41eb36ec9d34b702ab87bec7ff7cb8c488064cc84ab8922"
                or profile["nativeTool"]["name"] != "cmux_run_foreground"):
            raise RunnerError("Actual helper static profile differs")
        artifact = {
            "kind": "actual-linux-source-helper-pure-profile-not-native-qualification",
            "binary": {"path": str(binary.relative_to(root)),
                       "bytes": binary.stat().st_size, "sha256": binary_sha.hexdigest()},
            "memberSourceSHA256": json.loads((payload / "provenance.json").read_text())[
                "memberSourceSHA256"],
            "profile": profile, "profileSHA256": hashlib.sha256(pure.stdout[:-1]).hexdigest(),
            "profileOutputSHA256": hashlib.sha256(pure.stdout).hexdigest(),
            "codingEntryAvailable": False, "configurationPrepared": False,
            "modelOrProviderBootstrapExecuted": False, "qualification": False}
        with (root / "pure-helper-manifest.json").open("x") as stream:
            json.dump(artifact, stream, indent=2)
            stream.write("\n")
        summary["pureHelperManifest"] = "pure-helper-manifest.json"

        summary["outcome"] = "pure-profile-entry-3-and-package177-green"
        summary["notCompletion"] = 'Actual three executable entry and full177 package tests; actual Linux helper built and only pure profile mode executed. Coding startup disabled, no account/model/provider bootstrap, native parity, app installation or runtime qualification.'
        return 0
    except Exception as error:
        summary["error"] = repr(error)
        print("Pure-profile entry complete GREEN NOT established: " + repr(error), file=sys.stderr, flush=True)
        return 1
    finally:
        with (root / "run-summary.json").open("x") as stream:
            json.dump(summary, stream, indent=2)
            stream.write("\n")
        evidence = [root / "run-summary.json", payload / "snapshot.json"]
        if (root / "pure-helper-manifest.json").exists():
            evidence.append(root / "pure-helper-manifest.json")
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
            or root.name != f"shepherd-native-factory-entry-green-b-source-{run_id}" or root.is_symlink()):
        raise RunnerError("Runner root ownership mismatch")
    marker = json.loads((root / "owner.json").read_text())
    if marker != {"repository": "ourostack/ouroboros", "repository_id": 1169669354,
                  "run": run_id, "commit": commit}:
        raise RunnerError("Runner root generation mismatch")
    return run_source(root)


if __name__ == "__main__":
    raise SystemExit(main())
