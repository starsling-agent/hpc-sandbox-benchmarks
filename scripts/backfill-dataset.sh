#!/usr/bin/env bash
# Backfill the committed dataset from a previous Bench matrix run by dispatching commit-dataset.yml.
#
# When a matrix run's dataset commit fails (or was never reached), a codeowner re-runs the aggregate +
# promote + commit step standalone against that run's still-retained experiment plan and attempt artifacts — no
# re-benching. This is a thin wrapper over `gh workflow run` so the dispatch is one command instead of
# a hand-assembled API call; the same thing is doable from the Actions UI (Actions → Commit dataset →
# Run workflow). See docs/ci-secrets.md rule 6.
#
# Requires `gh` authenticated with rights to dispatch workflows on this repo. The dispatch is gated by
# Environment `privileged` (main-only + required reviewer), so it parks for maintainer approval — being
# a codeowner is necessary but the environment's reviewer still has to approve the run.
#
# Usage: scripts/backfill-dataset.sh <run-id>
#   <run-id>   The Bench matrix run id whose experiment plan and attempt artifacts to aggregate + commit.
set -euo pipefail

# commit-dataset.yml only runs on main (its job `if:` pins to refs/heads/main), and workflow_dispatch is
# only offered for workflows present on the default branch — so always dispatch the main copy.
WORKFLOW="commit-dataset.yml"
REF="main"
REPO="starslingdev/hpc-sandbox-benchmarks"

usage() {
  echo "Usage: scripts/backfill-dataset.sh <run-id>" >&2
  echo "  Dispatch ${WORKFLOW} on ${REF} to backfill the dataset from a previous run's shard artifacts." >&2
  exit 2
}

RUN_ID="${1:-}"
[ -n "$RUN_ID" ] || usage
# A GitHub run id is all digits; reject anything else before spending an API call (and so a stray flag
# or path can't be sent as the run id).
if ! printf '%s' "$RUN_ID" | grep -qE '^[0-9]+$'; then
  echo "run-id must be a numeric GitHub run id (got '${RUN_ID}')" >&2
  usage
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required (https://cli.github.com/)" >&2
  exit 1
fi

# The workflow intentionally skips its only job outside the canonical repository. Always dispatch the
# upstream copy so invoking this helper from a fork cannot report success for a run that immediately skips.

# Best-effort heads-up: backfill only works while the run's experiment plan and attempt artifacts are still inside the
# repo's retention window. A missing set isn't fatal here (the workflow fails loudly with the same
# diagnosis), but warning now saves a round-trip through the approval gate for a run whose shards expired.
# The lookup must stay non-fatal under `set -euo pipefail`: a transient gh error (5xx, 404 on a bad run
# id, missing artifact-read scope) makes the pipeline exit non-zero via pipefail, which would otherwise
# abort the script before dispatch. Guard the assignment with `if !` so a failed lookup only warns.
if ! artifact_count="$(gh api --paginate \
  "repos/${REPO}/actions/runs/${RUN_ID}/artifacts" \
  -q "[.artifacts[] | select(.expired == false and .name == \"experiment-plan-${RUN_ID}\")] | length" \
  2>/dev/null | awk '{ sum += $1 } END { print sum + 0 }')"; then
  echo "⚠️  Could not inspect retained artifacts for run ${RUN_ID}; continuing to dispatch anyway." >&2
elif [ "$artifact_count" -eq 0 ]; then
  echo "⚠️  No retained frozen experiment plan found on run ${RUN_ID} of ${REPO}." >&2
  echo "    Backfill requires the frozen plan and original attempts; legacy bench-* shards are insufficient." >&2
  echo "    Continuing anyway — dispatch the workflow to see its own diagnosis." >&2
fi

echo "Dispatching ${WORKFLOW} on ${REF} of ${REPO} to backfill run ${RUN_ID}…"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$REF" -f "run_id=${RUN_ID}"

echo
echo "Dispatched. The run is gated by Environment 'privileged' — it waits for a required reviewer to"
echo "approve before the commit job runs. Watch it:"
echo "  gh run list --repo ${REPO} --workflow ${WORKFLOW}"
echo "On success it opens (or re-arms) the dataset/publish-${RUN_ID} pull request. If run ${RUN_ID} is"
echo "already committed, the job is a clean no-op ('dataset unchanged; nothing to commit')."
echo
echo "The public LEADERBOARD.md is updated separately — see scripts/update-leaderboard.sh."
