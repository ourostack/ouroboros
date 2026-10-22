"""Bounded, exact-source native Swift tests on an ephemeral macOS CI host only."""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import unittest


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode_sources(compressed, expected):
    if len(compressed) > 131072 or not isinstance(expected, dict) or not 1 <= len(expected) <= 64:
        raise ValueError("Selected source bundle exceeds its fixed bound")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        raw = stream.read(1048577)
    if len(raw) > 1048576:
        raise ValueError("Selected source expansion exceeds one MiB")
    records = json.loads(raw)
    if not isinstance(records, dict) or set(records) != set(expected):
        raise ValueError("Selected source membership differs")
    result = {}
    total = 0
    for name, record in records.items():
        path = PurePosixPath(name)
        if (not name or "\0" in name or "\\" in name or path.is_absolute()
                or ".." in path.parts or path.as_posix() != name):
            raise ValueError("Noncanonical source path")
        metadata = expected[name]
        if (not isinstance(record, dict) or set(record) != {"bytes", "sha256", "mode", "base64"}
                or set(metadata) != {"bytes", "sha256", "mode"}
                or metadata["mode"] != "100644"
                or type(metadata["bytes"]) is not int or not 0 <= metadata["bytes"] <= 131072
                or not re.fullmatch(r"[a-f0-9]{64}", metadata["sha256"])
                or {key: record[key] for key in metadata} != metadata):
            raise ValueError("Source record identity differs")
        data = base64.b64decode(record["base64"], validate=True)
        if len(data) != metadata["bytes"] or sha(data) != metadata["sha256"]:
            raise ValueError("Source bytes differ")
        total += len(data)
        if total > 1048576:
            raise ValueError("Selected source bytes exceed one MiB")
        result[name] = data
    return result


def exact_result(result, expected):
    names, failures = expected["names"], expected["failures"]
    successes, actual_failures = result["successes"], result["failures"]
    return (
        len(names) == len(set(names))
        and set(failures) <= set(names)
        and result["testsRun"] == len(names)
        and len(successes) == len(set(successes))
        and set(successes) == set(names) - set(failures)
        and set(actual_failures) == set(failures)
        and all(marker in actual_failures[name] for name, marker in failures.items())
        and not result["errors"] and not result["skipped"]
        and not result["unexpectedSuccesses"] and not result["expectedFailures"]
    )


class BoundedLog(io.StringIO):
    def write(self, text):
        if self.tell() + len(text.encode("utf-8")) > 1048576:
            raise ValueError("Complete source-test log exceeds one MiB")
        return super().write(text)


def test_name(test):
    return test.id().split(".", 1)[-1]


class Result(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.passed_names = []
        self.failed_names = {}
        self.error_names = {}

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed_names.append(test_name(test))

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.failed_names[test_name(test)] = "".join(traceback.format_exception(*err))

    def addError(self, test, err):
        super().addError(test, err)
        self.error_names[test_name(test)] = "".join(traceback.format_exception(*err))

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            destination = self.failed_names if issubclass(err[0], test.failureException) else self.error_names
            name = test_name(test)
            destination[name] = destination.get(name, "") + "".join(traceback.format_exception(*err))


def write_json(path, value):
    with path.open("xb") as stream:
        stream.write(json.dumps(value, sort_keys=True, indent=2).encode() + b"\n")


def emit(path, root):
    data = path.read_bytes()
    if len(data) > 1048576:
        raise ValueError("Source proof record exceeds one MiB")
    print("SHEPHERD_EVIDENCE_BEGIN " + json.dumps({
        "name": path.relative_to(root).as_posix(), "bytes": len(data),
        "sha256": sha(data), "encoding": "gzip+base64"}), flush=True)
    encoded = base64.b64encode(gzip.compress(data, mtime=0)).decode()
    for offset in range(0, len(encoded), 2048):
        print("SHEPHERD_EVIDENCE_DATA " + encoded[offset:offset + 2048], flush=True)
    print("SHEPHERD_EVIDENCE_END", flush=True)


def main(root):
    run_id, commit = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_SHA", "")
    if (not __debug__ or not sys.dont_write_bytecode
            or sys.platform != "darwin" or os.environ.get("RUNNER_OS") != "macOS"
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != "ourostack/ouroboros"
            or os.environ.get("GITHUB_REPOSITORY_ID") != "1169669354"
            or not run_id.isdecimal() or not re.fullmatch(r"[a-f0-9]{40}", commit)
            or root.parent != Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
            or root.name != f"shepherd-native-factory-native-session-api-source-{run_id}"
            or root.resolve(strict=True) != root):
        raise ValueError("Exact owned ephemeral macOS CI identity required")
    if json.loads((root / "owner.json").read_bytes()) != {
            "repository": "ourostack/ouroboros", "repository_id": 1169669354,
            "run": run_id, "commit": commit}:
        raise ValueError("Exact native source ownership marker required")
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN",
                 "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "SSH_AUTH_SOCK"):
        os.environ.pop(name, None)
    payload = root / "payload"
    config = json.loads((payload / "provenance.json").read_bytes())
    source = root / "source"
    records = [payload / "snapshot.json", payload / "provenance.json"]
    summary = {
        "qualification": False, "ci_commit": commit, "ci_run": int(run_id),
        "ci_repository": "ourostack/ouroboros", "ci_repository_id": 1169669354,
        "outcome": "infrastructure-failure", "suites": [],
        "actualProviderModelAppOrProfileLaunched": False,
    }
    try:
        minimum_free = shutil.disk_usage(root).free
        if minimum_free < 1024**3:
            raise ValueError("Existing one-GiB source-build floor unavailable")
        compressed = (payload / "sources.json.gz").read_bytes()
        data = decode_sources(compressed, config["sources"])
        source.mkdir()
        for name, value in data.items():
            destination = source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as stream:
                stream.write(value)
        source_manifest = root / "source-manifest.json"
        write_json(source_manifest, config["sources"])
        records.append(source_manifest)
        identity = {}
        for name, command in (
            ("swift", ["swiftc", "--version"]), ("os", ["sw_vers"]),
            ("architecture", ["uname", "-m"]),
        ):
            result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
            identity[name] = result.stdout.strip()
        if "Swift version 6." not in identity["swift"] or "15." not in identity["os"]:
            raise ValueError("Expected Swift6/macOS15 source test host unavailable")
        identity["minimumFreeBytes"] = minimum_free
        compiler_path = root / "compiler-identity.json"
        write_json(compiler_path, identity)
        records.append(compiler_path)
        build = root / "build"
        build.mkdir()
        tempfile.tempdir = str(build)
        sys.path.insert(0, str(source / "scripts/tests"))
        failures = []
        for index, (filename, expected) in enumerate(config["suites"].items()):
            if shutil.disk_usage(root).free < 1024**3:
                raise ValueError("Existing source-build floor lost")
            path = source / filename
            spec = importlib.util.spec_from_file_location("_shepherd_" + path.stem, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            module.MODULE_CACHE = build / "swift-module-cache"
            suite = unittest.defaultTestLoader.loadTestsFromModule(module)
            log = BoundedLog()
            saved_out, saved_error = sys.stdout, sys.stderr
            try:
                sys.stdout = sys.stderr = log
                result = unittest.TextTestRunner(
                    stream=log, verbosity=2, resultclass=Result).run(suite)
            finally:
                sys.stdout, sys.stderr = saved_out, saved_error
            receipt = {
                "source": filename, "testsRun": result.testsRun,
                "successes": result.passed_names, "failures": result.failed_names,
                "errors": result.error_names,
                "skipped": [test_name(test) for test, _ in result.skipped],
                "unexpectedSuccesses": [test_name(test) for test in result.unexpectedSuccesses],
                "expectedFailures": [test_name(test) for test, _ in result.expectedFailures],
            }
            receipt_path, log_path = root / f"suite-{index}.json", root / f"suite-{index}.log"
            write_json(receipt_path, receipt)
            with log_path.open("xb") as stream:
                stream.write(log.getvalue().encode())
            records.extend((receipt_path, log_path))
            exact = exact_result(receipt, expected)
            summary["suites"].append({
                "source": filename, "receipt": receipt_path.name, "log": log_path.name,
                "exactExpectedBehavior": exact})
            if not exact:
                failures.append(filename)
        if any((source / name).read_bytes() != value for name, value in data.items()):
            raise ValueError("A selected source file changed during testing")
        if failures:
            raise ValueError("Exact native source results unavailable: " + repr(failures))
        summary["outcome"] = "native-session-api"
        return 0
    except Exception as error:
        summary["error"] = repr(error)
        print("Native source diagnostic not established: " + repr(error), file=sys.stderr, flush=True)
        return 1
    finally:
        summary_path = root / "run-summary.json"
        write_json(summary_path, summary)
        records.append(summary_path)
        if sum(path.stat().st_size for path in records) > 16 * 1024**2:
            raise ValueError("Complete native proof exceeds its unchanged expansion bound")
        for path in records:
            emit(path, root)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    raise SystemExit(main(parser.parse_args().root))
