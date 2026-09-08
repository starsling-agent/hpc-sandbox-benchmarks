#!/opt/vllm/bin/python
"""Populate or validate the immutable inputs mounted by GPU benchmark sandboxes."""

import argparse
import hashlib
import importlib.metadata
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from huggingface_hub import snapshot_download


COMMIT_SHA = re.compile(r"[0-9a-f]{40}")


def pinned_revision(revision, subject):
    """Return the immutable commit a Hugging Face repository is pinned to.

    Branch and tag names are resolved at download time, so a repository pinned to one can serve
    different bytes on every run and every downstream check here would still pass (CWE-494). Only
    a full commit SHA names immutable content, so refuse anything else before a download starts —
    this script is the sandbox-side entry point and cannot assume its caller pinned correctly.
    """
    if not isinstance(revision, str) or not COMMIT_SHA.fullmatch(revision):
        raise RuntimeError(
            f"{subject} must pin a 40-character Hugging Face commit SHA, not {revision!r}"
        )
    return revision


parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=("download", "check"))
parser.add_argument("config", type=Path)
args = parser.parse_args()
config = json.loads(args.config.read_text())

model = config["model"]
speed_bench = config["speedBench"]
cache_dir = config["paths"]["modelCache"]
dataset_dir = Path(config["paths"]["speedBench"])
dataset_file = dataset_dir / "qualitative.jsonl"
manifest_file = Path(config["paths"]["modelMount"]) / "benchmark-assets.json"
model_repo_id = model["repoId"]
model_revision = pinned_revision(model.get("revision"), f"model {model_repo_id}")
dataset_pin = speed_bench["dataset"]
dataset_repo_id = dataset_pin["repoId"]
dataset_revision = pinned_revision(dataset_pin.get("revision"), f"dataset {dataset_repo_id}")

# Two source-level edits to the checksum-pinned upstream prepare.py, each anchored on an exact line
# so an upstream change fails loudly instead of silently preparing something else.
#   * The load pin closes the one unpinned Hugging Face download left on this path: upstream reads
#     the dataset from its default branch, so without it the benchmark's prompts could change
#     between runs while every local check still passed.
#   * The category filter keeps only the coding rows this benchmark serves, and runs before any
#     external row data is fetched.
dataset_load = f'        dataset = load_dataset("{dataset_repo_id}", config, split="test")\n'
pinned_dataset_load = (
    f'        dataset = load_dataset("{dataset_repo_id}", config, split="test", '
    f'revision="{dataset_revision}")\n'
)
resolve_external = "        dataset = _resolve_external_data(dataset, config)\n"
category_filter = '        dataset = dataset.filter(lambda example: example["category"] == "coding")\n'
prepare_transforms = (
    (dataset_load, pinned_dataset_load),
    (resolve_external, category_filter + resolve_external),
)

# Everything about the prepared dataset that is pinned rather than measured. The manifest nests
# this as one subtree — the shape the kernel snapshot pointer uses for its seed — so a cached
# dataset prepared under different pins is detected by comparing that subtree whole.
SPEED_BENCH_PIN = {
    "category": "coding",
    "config": "qualitative",
    "dataset": dataset_pin,
    "datasetPath": str(dataset_file),
    "prepare": speed_bench["prepare"],
    "prepareTransforms": [pinned_dataset_load.strip(), category_filter.strip()],
}

try:
    xet_version = importlib.metadata.version("hf-xet")
except importlib.metadata.PackageNotFoundError as error:
    raise RuntimeError("hf-xet is required for high-performance model downloads") from error


def resolve_model():
    """Resolve and validate the pinned model snapshot for the requested mode."""
    options = {
        "repo_id": model_repo_id,
        "cache_dir": cache_dir,
    }
    # `# nosec B615` below is a false-positive suppression, not an exemption. Bandit's B615
    # (Hugging Face download without revision pinning) in releases before 1.9.4 only accepts a
    # revision written as a hex string literal at the call site; a variable is reported as
    # unpinned even though every call here passes `revision=model_revision`. That variable has
    # already been through pinned_revision(), which refuses anything but a full 40-character
    # commit SHA before any download starts. validate_model_snapshot() then checks that the
    # resolved snapshot directory is named for that SHA and that the required files and every
    # weight shard the index names are present and non-empty. Both controls are stricter than
    # the linter's 7-hex-character heuristic. Bandit >= 1.9.4 trusts a non-literal revision
    # and reports nothing here; the markers exist for scanners still on older releases.
    try:
        path = snapshot_download(  # nosec B615
            **options, revision=model_revision, local_files_only=True
        )
        validate_model_snapshot(path)
        disposition = "cached"
    except Exception as cache_error:
        if args.mode == "check":
            raise RuntimeError(
                f"model snapshot is absent or incomplete: {model_repo_id}@{model_revision}"
            ) from cache_error
        print(f"Downloading {model_repo_id}@{model_revision}", flush=True)
        snapshot_download(**options, revision=model_revision, max_workers=4)  # nosec B615
        path = snapshot_download(  # nosec B615
            **options, revision=model_revision, local_files_only=True
        )
        validate_model_snapshot(path)
        disposition = "downloaded"
    resolved = {**model, "path": path, "disposition": disposition}
    print(json.dumps(resolved, sort_keys=True), flush=True)
    return resolved


def validate_model_snapshot(snapshot):
    """Reject a model snapshot that is not the pinned, complete safetensors snapshot."""
    root = Path(snapshot)
    # The hub stores each snapshot under the commit it came from, so this is the one check that
    # ties the bytes on disk to the pinned revision rather than to whatever the cache happened to
    # hold. Everything below only proves the snapshot is complete.
    if root.name != model_revision:
        raise RuntimeError(f"model snapshot is not the pinned commit {model_revision}: {snapshot}")
    for relative in ("config.json", "tokenizer.json", "model.safetensors.index.json"):
        file = root / relative
        if not file.is_file() or file.stat().st_size == 0:
            raise RuntimeError(f"model snapshot is missing {relative}: {file}")
    try:
        index = json.loads((root / "model.safetensors.index.json").read_text())
    except json.JSONDecodeError as error:
        raise RuntimeError("model safetensors index is invalid JSON") from error
    weight_map = index.get("weight_map")
    if not isinstance(weight_map, dict) or not weight_map:
        raise RuntimeError("model safetensors index has no weight_map")
    shards = set(weight_map.values())
    if not all(isinstance(shard, str) and shard for shard in shards):
        raise RuntimeError("model safetensors index contains an invalid shard path")
    for shard in shards:
        relative = Path(shard)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"model safetensors index contains an unsafe shard path: {shard}")
        file = root / relative
        if not file.is_file() or file.stat().st_size == 0:
            raise RuntimeError(f"model snapshot is missing weight shard: {file}")


def validate_dataset():
    """Validate and return the exact number of coding samples in the prepared dataset."""
    try:
        if not dataset_file.is_file() or dataset_file.stat().st_size == 0:
            raise RuntimeError(f"prepared SPEED-Bench dataset is absent: {dataset_file}")
        rows = []
        with dataset_file.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RuntimeError(
                        f"invalid SPEED-Bench JSONL at line {line_number}"
                    ) from error
                if not isinstance(row, dict):
                    raise RuntimeError(
                        f"invalid SPEED-Bench JSONL object at line {line_number}"
                    )
                rows.append(row)
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"prepared SPEED-Bench dataset is unreadable: {dataset_file}") from error
    coding_samples = sum(row.get("category") == "coding" for row in rows)
    expected = speed_bench["codingSamples"]
    if coding_samples != expected or len(rows) != expected:
        raise RuntimeError(
            f"prepared SPEED-Bench dataset has {coding_samples} coding / {len(rows)} total "
            f"samples; expected {expected} / {expected}"
        )
    return coding_samples


def recorded_manifest():
    """Return the object manifest on the volume, or None for every unreadable state."""
    try:
        recorded = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return recorded if isinstance(recorded, dict) else None


def validate_cached_dataset():
    """Validate that cached dataset bytes and their manifest match the pinned inputs."""
    recorded = (recorded_manifest() or {}).get("speedBench")
    if not isinstance(recorded, dict) or recorded.get("pin") != SPEED_BENCH_PIN:
        raise RuntimeError("prepared SPEED-Bench dataset does not come from the pinned inputs")
    coding_samples = validate_dataset()
    try:
        actual_sha256 = hashlib.sha256(dataset_file.read_bytes()).hexdigest()
    except OSError as error:
        raise RuntimeError(f"prepared SPEED-Bench dataset is unreadable: {dataset_file}") from error
    if recorded.get("contentSha256") != actual_sha256:
        raise RuntimeError("prepared SPEED-Bench dataset does not match its recorded checksum")
    return coding_samples


def prepare_dataset():
    """Reuse a verified cache or derive the dataset from its pinned, checksum-verified source."""
    # A dataset prepared before these pins changed is stale even when it parses and counts
    # correctly: its rows came from a different dataset revision or a different transform. Re-derive
    # it rather than republish those bytes under the new pins.
    try:
        return validate_cached_dataset(), "cached"
    except RuntimeError:
        if args.mode == "check":
            raise
        # The cached copy is absent, stale, or unusable, so re-derive it below.

    dataset_dir.mkdir(parents=True, exist_ok=True)
    dataset_file.unlink(missing_ok=True)
    prepare = speed_bench["prepare"]
    print("Preparing revision-pinned SPEED-Bench coding data", flush=True)
    with urllib.request.urlopen(prepare["url"], timeout=60) as response:
        payload = response.read()
    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if actual_sha256 != prepare["sha256"]:
        raise RuntimeError(f"SPEED-Bench prepare.py checksum mismatch: {actual_sha256}")
    source = payload.decode("utf-8")
    for anchor, replacement in prepare_transforms:
        if source.count(anchor) != 1:
            raise RuntimeError(
                f"SPEED-Bench prepare.py insertion anchor changed: {anchor.strip()}"
            )
        source = source.replace(anchor, replacement)
    # Keep the checksum-verified executable private until it has finished. A predictable shared
    # /tmp path could otherwise be replaced between verification and execution.
    with tempfile.TemporaryDirectory(prefix="speed-bench-") as temporary_directory:
        script = Path(temporary_directory) / "prepare.py"
        script.write_text(source, encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                str(script),
                "--config",
                "qualitative",
                "--output_dir",
                str(dataset_dir),
            ],
            check=True,
        )
    return validate_dataset(), "prepared"


resolved_model = resolve_model()
coding_samples, dataset_disposition = prepare_dataset()
dataset_sha256 = hashlib.sha256(dataset_file.read_bytes()).hexdigest()
manifest = {
    "schemaVersion": "1.1",
    "models": [model],
    "speedBench": {"contentSha256": dataset_sha256, "pin": SPEED_BENCH_PIN},
}
if args.mode == "download":
    encoded = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if recorded_manifest() != manifest:
        temporary = manifest_file.with_suffix(".tmp")
        temporary.write_text(encoded, encoding="utf-8")
        temporary.replace(manifest_file)
elif recorded_manifest() != manifest:
    raise RuntimeError("benchmark asset manifest is absent or does not match the pinned inputs")

print(
    "MODEL_CACHE_SUMMARY="
    + json.dumps(
        {
            "mode": args.mode,
            "cacheDir": cache_dir,
            "hfXetVersion": xet_version,
            "models": [resolved_model],
            "speedBench": {
                "codingSamples": coding_samples,
                "contentSha256": dataset_sha256,
                "disposition": dataset_disposition,
                "path": str(dataset_file),
            },
        },
        sort_keys=True,
    ),
    flush=True,
)
