// Drift gate: the security posture of the GitHub Actions layer. Invariants the .github/ files must
// hold, none of which the type system can enforce (GHA is YAML):
//
//   1. persist-credentials hygiene — every `actions/checkout` step sets `persist-credentials: false`
//      UNLESS it is one of the few jobs that later `git push`es (it needs the persisted job token).
//      The pushing checkouts are enumerated in CREDENTIALED_CHECKOUTS with provenance; the gate fails
//      both when a read-only checkout forgets the opt-out AND when a pushing checkout is in the
//      allowlist but no longer exists / no longer keeps its token (so the allowlist can't rot).
//   2. The ci-lint workflow actually runs the two linters at the agreed gate threshold — an actionlint
//      job and a zizmor job invoked with `--min-severity medium --min-confidence high`. A renamed job
//      or a loosened threshold (e.g. someone dropping --min-confidence) must fail this gate.
//   3. Privileged-environment gate — every job that reads a custom secret (anything other than
//      GITHUB_TOKEN / github.token) OR elevates to contents:write / packages:write must declare
//      `environment: privileged`, so secrets and releases stay behind Environment protection rules.
//      A reusable-workflow caller (`uses:` job) can't declare `environment:`; a LOCAL call defers the
//      gate to the called file (checked here in its own right), a REMOTE one is flagged (unverifiable).
//   4. Toolchain publish is dispatch-only — toolchain-image.yml must not fire a release on push/merge.
//   5. Toolchain PR ownership stays split — image inputs run the expensive docker smoke, while the
//      three setup/reporting composites run a lightweight smoke on the standard 2-vCPU runner.
//
// Bun.YAML.parse is built into bun >= 1.3 (no new dependency).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { findRepoRoot } from "./workspace.ts";

export const WORKFLOWS_DIR = ".github/workflows";
export const CI_LINT_WORKFLOW = ".github/workflows/ci-lint.yml";
export const TOOLCHAIN_WORKFLOW = "toolchain-image.yml";
export const TOOLCHAIN_ACTION_SMOKE_WORKFLOW = "toolchain-actions-smoke.yml";

/** Inputs that can alter the toolchain image and therefore own the expensive PR docker smoke. */
export const TOOLCHAIN_IMAGE_PR_PATHS = [
	"packages/templates/**",
	"packages/schema/src/toolchain.ts",
	".github/workflows/toolchain-image.yml",
] as const;

/** Local setup composites executed by the lightweight smoke, plus the smoke itself. */
export const TOOLCHAIN_ACTION_SMOKE_PR_PATHS = [
	".github/actions/setup-tama/**",
	".github/actions/setup-toolchain/**",
	".github/actions/setup-workspace/**",
	".github/actions/release-summary/**",
	".github/workflows/toolchain-actions-smoke.yml",
] as const;

/** GitHub Environment name that holds provider secrets and gates releases. See docs/ci-secrets.md. */
export const PRIVILEGED_ENVIRONMENT = "privileged";

/** Checkout steps that intentionally keep the persisted job token, keyed "<file>::<jobId>", with the
 *  reason they push. Every other `actions/checkout` must set persist-credentials: false. */
export const CREDENTIALED_CHECKOUTS: Readonly<Record<string, string>> = {
	// commit-dataset.yml's commit job aggregates + promotes the dataset and `git push`es it back to the
	// branch (it grants `contents: write` for exactly this), so it must keep the persisted token. It is
	// the reusable workflow bench-matrix.yml's publish job calls, and a maintainer dispatches to backfill.
	"commit-dataset.yml::commit": "commits + pushes the promoted dataset back to the branch",
	// update-leaderboard.yml's leaderboard job regenerates LEADERBOARD.md and `git push`es it back to the
	// branch (also `contents: write`), so it too must keep the persisted token. A maintainer dispatches it
	// to move the public comparison surface to a chosen committed dataset run.
	"update-leaderboard.yml::leaderboard":
		"commits + pushes the regenerated leaderboard back to the branch",
};

/** Built-in / non-environment tokens that may appear as `${{ secrets.* }}` without requiring the
 *  privileged Environment. Provider API keys and other org secrets must NOT be listed here. */
const BUILTIN_SECRET_NAMES = new Set(["GITHUB_TOKEN"]);

/** The only top-level triggers toolchain-image.yml may declare: manual dispatch (the sole path to
 *  the publish job) plus the secret-free PR docker smoke gate. Anything else can fire a release. */
const ALLOWED_TOOLCHAIN_TRIGGERS = new Set(["workflow_dispatch", "pull_request"]);

/** Each `${{ … }}` expression block (inner text captured). A secret access can sit anywhere inside —
 *  `${{ inputs.provider == 'daytona' && secrets.DAYTONA_API_KEY || '' }}` is the scoped form the
 *  bench workflows use — so we scan the whole block for accesses rather than anchoring on `${{ secrets`.
 *  The `s` flag lets a block span newlines. */
const EXPR_BLOCK = /\$\{\{(.*?)\}\}/gs;

/** A `secrets.NAME`, `secrets['NAME']`, or `secrets["NAME"]` access anywhere within an expression
 *  block. GHA allows whitespace around the `.` accessor (`secrets . NAME`), so the dot form tolerates
 *  it too — otherwise the spaced form is a silent bypass. Bracket form is rarer but just as real. */
const SECRET_ACCESS = /secrets(?:\s*\.\s*([A-Za-z0-9_]+)|\s*\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/g;

function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}

/** Parse a workflow YAML file under `root` (Bun.YAML — built-in, no dependency). */
export function readWorkflow(relPath: string, root: string = findRepoRoot()): unknown {
	return Bun.YAML.parse(readFileSync(join(root, relPath), "utf8"));
}

/** The workflow file names (e.g. "ci.yml") under .github/workflows, sorted. */
export function listWorkflowFiles(root: string = findRepoRoot()): string[] {
	const glob = new Glob("*.{yml,yaml}");
	return [...glob.scanSync({ cwd: join(root, WORKFLOWS_DIR), onlyFiles: true })].sort();
}

/** One `actions/checkout` step found while walking a workflow's jobs. */
export interface CheckoutStep {
	/** Workflow file name, e.g. "ci.yml". */
	file: string;
	/** The job the step lives in. */
	jobId: string;
	/** The step's `with.persist-credentials` value (undefined if no `with`/key). */
	persistCredentials: boolean | undefined;
}

/** Every `actions/checkout` step in a parsed workflow, with its persist-credentials setting. */
export function checkoutSteps(doc: unknown, file: string): CheckoutStep[] {
	const root = asRecord(doc, `${file}: not a YAML mapping`);
	const jobs = asRecord(root.jobs, `${file}: no jobs mapping`);
	const found: CheckoutStep[] = [];
	for (const [jobId, jobValue] of Object.entries(jobs)) {
		const job = asRecord(jobValue, `${file}: job "${jobId}" is not a mapping`);
		const steps = job.steps;
		if (!Array.isArray(steps)) continue;
		for (const stepValue of steps) {
			const step = asRecord(stepValue, `${file}: job "${jobId}" has a malformed step`);
			const uses = step.uses;
			if (typeof uses !== "string" || !uses.startsWith("actions/checkout@")) continue;
			// An empty `with:` block parses as null (not undefined); treat both as "no inputs" so a
			// valid workflow with a bare `with:` doesn't crash the gate in asRecord.
			const withBlock =
				step.with === undefined || step.with === null
					? {}
					: asRecord(step.with, `${file}: malformed with`);
			// YAML may carry the value as a boolean (`false`) or a quoted string (`"false"`); accept both
			// so a string-typed opt-out isn't misread as "unset" and wrongly flagged by the gate.
			const pc = withBlock["persist-credentials"];
			const persistCredentials =
				typeof pc === "boolean" ? pc : pc === "true" ? true : pc === "false" ? false : undefined;
			found.push({ file, jobId, persistCredentials });
		}
	}
	return found;
}

/**
 * Invariant 1: read-only checkouts opt out of credential persistence; pushing checkouts (the
 * allowlist) keep it. `steps` is the flattened list across all workflows; `allowlist` maps
 * "<file>::<jobId>" to the reason it pushes.
 */
export function checkPersistCredentials(
	steps: CheckoutStep[],
	allowlist: Readonly<Record<string, string>> = CREDENTIALED_CHECKOUTS,
): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const step of steps) {
		const key = `${step.file}::${step.jobId}`;
		seen.add(key);
		if (key in allowlist) {
			// A pushing checkout must NOT opt out, or its later `git push` loses its credentials.
			if (step.persistCredentials === false) {
				errors.push(
					`${key}: sets persist-credentials: false but is allowlisted as a pushing checkout ` +
						`(${allowlist[key]}) — the push would lose its token; remove it from the allowlist or the opt-out`,
				);
			}
			continue;
		}
		if (step.persistCredentials !== false) {
			errors.push(
				`${key}: actions/checkout must set persist-credentials: false (it does not push) — ` +
					`add it under \`with:\`, or list "${key}" in CREDENTIALED_CHECKOUTS if it pushes`,
			);
		}
	}
	// The allowlist can't rot: every entry must name a checkout that still exists.
	for (const key of Object.keys(allowlist)) {
		if (!seen.has(key)) {
			errors.push(
				`${key}: listed in CREDENTIALED_CHECKOUTS but no such checkout step exists — remove the stale entry`,
			);
		}
	}
	return errors;
}

/** Invariant 2: ci-lint.yml runs actionlint + zizmor, and zizmor at the agreed gate threshold. */
export function checkCiLintGate(doc: unknown, label: string = CI_LINT_WORKFLOW): string[] {
	const errors: string[] = [];
	const root = asRecord(doc, `${label}: not a YAML mapping`);
	const jobs = asRecord(root.jobs, `${label}: no jobs mapping`);
	// The joined `run:` text of a job's steps — used to confirm the job actually invokes its tool.
	const jobRun = (jobId: string): string => {
		const job = asRecord(jobs[jobId], `${label}: "${jobId}" job is not a mapping`);
		const steps = Array.isArray(job.steps) ? job.steps : [];
		return steps
			.map((s) => asRecord(s, `${label}: malformed "${jobId}" step`).run)
			.filter((r): r is string => typeof r === "string")
			.join("\n");
	};
	for (const tool of ["actionlint", "zizmor"]) {
		if (!(tool in jobs)) {
			errors.push(`${label}: missing the "${tool}" job — the ${tool} linter is the gate`);
			continue;
		}
		// Job existence isn't enough: it must actually invoke the tool, or the gate false-passes if
		// the real invocation is renamed/removed while an empty job shell survives.
		const run = jobRun(tool);
		const queueCompatibleActionlint =
			tool === "actionlint" &&
			run.split("\n").some((line) => line.trim() === "bun run lint:workflows");
		if (!run.includes(tool) && !queueCompatibleActionlint) {
			errors.push(
				`${label}: the "${tool}" job must actually run \`${tool}\` — the gate must not pass on a job that no longer invokes it`,
			);
		}
	}
	if ("zizmor" in jobs) {
		const run = jobRun("zizmor");
		for (const flag of ["--min-severity medium", "--min-confidence high"]) {
			if (!run.includes(flag)) {
				errors.push(
					`${label}: the zizmor job must invoke zizmor with \`${flag}\` — the gate threshold can't be loosened`,
				);
			}
		}
	}
	return errors;
}

/** Collect string leaves from an `env:` mapping (job- or step-level). */
function envStrings(envValue: unknown): string[] {
	if (envValue === undefined || envValue === null) return [];
	const env = asRecord(envValue, "env is not a mapping");
	return Object.values(env).filter((v): v is string => typeof v === "string");
}

/** String values of a `with:` block (job- or step-level) — only string inputs can carry a secret
 *  expression. Shared by the step scan and the job-level (`uses:` job) scan below. */
function withStrings(withValue: unknown, file: string): string[] {
	if (withValue === undefined || withValue === null) return [];
	const withBlock = asRecord(withValue, `${file}: malformed with`);
	return Object.values(withBlock).filter((v): v is string => typeof v === "string");
}

/** Custom secret names referenced in a string (excludes GITHUB_TOKEN). Scans every `${{ … }}` block
 *  for secret accesses, so a secret guarded behind a condition (`… && secrets.NAME || ''`) or paired
 *  with others in one block is caught, not just a block that opens with `secrets`. */
export function customSecretsIn(text: string): string[] {
	const found: string[] = [];
	for (const block of text.matchAll(EXPR_BLOCK)) {
		const inner = block[1] ?? "";
		for (const match of inner.matchAll(SECRET_ACCESS)) {
			const name = match[1] || match[2];
			if (name && !BUILTIN_SECRET_NAMES.has(name)) found.push(name);
		}
	}
	return found;
}

/** Normalize GHA `permissions:` to a scope mapping. It may be a mapping, `undefined`, or the string
 *  shorthand `write-all` (every scope → write) / `read-all` (no scope → write); the shorthand is
 *  expanded here so every downstream reader sees one shape and never re-decodes the string form. */
type Permissions = Record<string, unknown> | undefined;
function parsePermissions(value: unknown, message: string): Permissions {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string")
		return value === "write-all" ? { contents: "write", packages: "write" } : {};
	return asRecord(value, message);
}

/** Effective write scopes for a job: job permissions override top-level when the job sets any (a job
 *  that declares `read-all` normalizes to `{}` — defined, so it still overrides). */
function effectiveWriteScopes(
	workflowPerms: Permissions,
	jobPerms: Permissions,
): { contentsWrite: boolean; packagesWrite: boolean } {
	const scopes = jobPerms ?? workflowPerms ?? {};
	return {
		contentsWrite: scopes.contents === "write",
		packagesWrite: scopes.packages === "write",
	};
}

/** Resolve a job's `environment` name (string form or `{ name: … }` mapping). */
export function jobEnvironmentName(job: Record<string, unknown>): string | undefined {
	const env = job.environment;
	if (typeof env === "string") return env;
	if (env !== null && typeof env === "object" && !Array.isArray(env)) {
		const name = (env as Record<string, unknown>).name;
		return typeof name === "string" ? name : undefined;
	}
	return undefined;
}

/** Every string on a job that could embed a `${{ secrets.* }}` reference: the job's `if`, env leaves,
 *  and job-level `with:` values, plus each step's `if`, env leaves, `with:` values, and `run`.
 *  Gathering them in one place means the secret scan is a single pass, and a new secret-bearing
 *  surface is one more push here. */
function jobSecretStrings(job: Record<string, unknown>, file: string, jobId: string): string[] {
	const strings: string[] = [];
	if (typeof job.if === "string") strings.push(job.if);
	strings.push(...envStrings(job.env));
	// A reusable-workflow call (`uses:` on the job) has no steps: its inputs ride a JOB-LEVEL `with:`.
	// A caller can pass `${{ secrets.* }}` as an input there (instead of via the `secrets:` block), so
	// scan it too — otherwise that path is a silent bypass of the privileged-environment gate.
	strings.push(...withStrings(job.with, file));
	const steps = Array.isArray(job.steps) ? job.steps : [];
	for (const stepValue of steps) {
		const step = asRecord(stepValue, `${file}: job "${jobId}" has a malformed step`);
		if (typeof step.if === "string") strings.push(step.if);
		strings.push(...envStrings(step.env));
		// Inline secrets in `with:` (e.g. docker/login-action password) — only string values can carry one.
		strings.push(...withStrings(step.with, file));
		if (typeof step.run === "string") strings.push(step.run);
	}
	return strings;
}

/** Human-readable list of why a job needs the privileged Environment (secrets it reads/forwards and
 *  the write scopes it grants), used in both the normal-job and reusable-call error messages. */
function privilegeReasons(f: {
	secrets: Set<string>;
	forwardsSecrets: boolean;
	contentsWrite: boolean;
	packagesWrite: boolean;
}): string[] {
	const reasons: string[] = [];
	if (f.secrets.size > 0) reasons.push(`custom secrets (${[...f.secrets].sort().join(", ")})`);
	if (f.forwardsSecrets) reasons.push("secrets forwarded to a reusable workflow");
	if (f.contentsWrite) reasons.push("contents: write");
	if (f.packagesWrite) reasons.push("packages: write");
	return reasons;
}

/** True if any job in a parsed workflow declares `environment: <privileged>`. Used to confirm a local
 *  reusable workflow carries its own approval gate (the caller can't declare one for it). */
function hasPrivilegedJob(
	doc: unknown,
	privileged: string,
	resolveLocal: (path: string) => unknown,
	visited = new Set<string>(),
): boolean {
	const root = asRecord(doc, "reusable workflow");
	const jobs = Object.values(asRecord(root.jobs, "reusable jobs")).map((job) =>
		asRecord(job, "reusable job"),
	);
	const nested = jobs.filter((job) => typeof job.uses === "string");
	const directGate = jobs.some((job) => jobEnvironmentName(job) === privileged);
	if (nested.length === 0) return directGate;
	return nested.every((job) => {
		if (
			typeof job.uses !== "string" ||
			!job.uses.startsWith("./.github/workflows/") ||
			visited.has(job.uses)
		)
			return false;
		try {
			return hasPrivilegedJob(
				resolveLocal(job.uses.slice(2)),
				privileged,
				resolveLocal,
				new Set([...visited, job.uses]),
			);
		} catch {
			return false;
		}
	});
}

/**
 * Invariant 3: jobs that touch custom secrets or elevate write permissions must sit behind the
 * `privileged` GitHub Environment so Environment secrets + required reviewers apply.
 *
 * A job that calls a reusable workflow (`uses:` at the job level) is special: GHA forbids
 * `environment:` on such a job, so the gate can't live on the caller. A LOCAL call
 * (`./.github/workflows/*`) hands the gate to the called file — but the caller's grant of write /
 * secrets does NOT show up in that file's own YAML (the callee may inherit it), so the callee's
 * per-file check can miss it. To close that bypass, a privileged local caller must point at a callee
 * that gates at least one job on `environment: privileged` — verified by resolving the callee here.
 * (`resolveLocalWorkflow` maps a repo-relative workflow path to its parsed doc; it defaults to reading
 * from disk, and {@link runHardeningCheck} passes the already-parsed docs. An unresolvable callee is
 * skipped — actionlint separately fails a `uses:` pointing at a missing local workflow.) A REMOTE call
 * can't be verified at all, so a remote caller that forwards secrets or write access is flagged.
 */
export function checkPrivilegedEnvironment(
	doc: unknown,
	file: string,
	privileged: string = PRIVILEGED_ENVIRONMENT,
	resolveLocalWorkflow: (relPath: string) => unknown = (relPath) => readWorkflow(relPath),
): string[] {
	const errors: string[] = [];
	const root = asRecord(doc, `${file}: not a YAML mapping`);
	const workflowPerms = parsePermissions(root.permissions, `${file}: malformed permissions`);
	// Workflow-level `env` is inherited by every job/step — secrets there must not bypass the gate.
	const workflowSecrets = envStrings(root.env).flatMap(customSecretsIn);
	const jobs = asRecord(root.jobs, `${file}: no jobs mapping`);

	for (const [jobId, jobValue] of Object.entries(jobs)) {
		const job = asRecord(jobValue, `${file}: job "${jobId}" is not a mapping`);
		const key = `${file}::${jobId}`;
		const secrets = new Set([
			...workflowSecrets,
			...jobSecretStrings(job, file, jobId).flatMap(customSecretsIn),
		]);

		// A reusable-workflow call (`uses:` on the job) with a `secrets:` block forwards secrets to the
		// callee with no `${{ secrets.* }}` appearing here — `secrets: inherit` forwards ALL of them.
		// A non-null secrets block on a uses-job is therefore a custom-secret exposure the gate must see.
		const forwardsSecrets =
			typeof job.uses === "string" && job.secrets !== undefined && job.secrets !== null;

		const jobPerms = parsePermissions(
			job.permissions,
			`${file}: job "${jobId}" malformed permissions`,
		);
		const { contentsWrite, packagesWrite } = effectiveWriteScopes(workflowPerms, jobPerms);
		const needsPrivileged = secrets.size > 0 || forwardsSecrets || contentsWrite || packagesWrite;
		if (!needsPrivileged) continue;

		// Reusable-workflow caller: can't declare `environment:`, so gating moves into the called file.
		if (typeof job.uses === "string") {
			const reasons = privilegeReasons({ secrets, forwardsSecrets, contentsWrite, packagesWrite });
			if (!job.uses.startsWith("./")) {
				errors.push(
					`${key}: calls a remote reusable workflow (${job.uses}) with ${reasons.join(" and ")} — ` +
						`it can't be verified to gate on \`environment: ${privileged}\`; call a local ` +
						`./.github/workflows reusable workflow (which this gate checks) instead — see docs/ci-secrets.md`,
				);
				continue;
			}
			// Local call: verify the callee actually carries an approval gate. The caller's grant of
			// write/secrets is invisible in the callee's own YAML, so its per-file check can't be relied
			// on to catch an ungated callee — check it here. Skip only if the callee can't be resolved
			// (actionlint fails a `uses:` at a missing local workflow).
			let calledDoc: unknown;
			try {
				calledDoc = resolveLocalWorkflow(job.uses.replace(/^\.\//, ""));
			} catch {
				calledDoc = undefined;
			}
			if (
				calledDoc !== undefined &&
				!hasPrivilegedJob(calledDoc, privileged, resolveLocalWorkflow)
			) {
				errors.push(
					`${key}: calls local reusable workflow ${job.uses} with ${reasons.join(" and ")} but no ` +
						`job in it sets \`environment: ${privileged}\` — a \`uses:\` caller can't gate itself, so ` +
						`the called workflow must — see docs/ci-secrets.md`,
				);
			}
			continue;
		}

		const envName = jobEnvironmentName(job);
		if (envName !== privileged) {
			const reasons = privilegeReasons({ secrets, forwardsSecrets, contentsWrite, packagesWrite });
			errors.push(
				`${key}: must set \`environment: ${privileged}\` because it uses ${reasons.join(" and ")} — ` +
					`see docs/ci-secrets.md`,
			);
		}
	}
	return errors;
}

/**
 * Invariant 4: toolchain-image.yml publishes only via workflow_dispatch — a push/merge must never
 * start a GHCR release. Allowed top-level triggers are exactly `workflow_dispatch` + `pull_request`
 * (the secret-free PR gate). Call only with that workflow's document; {@link runHardeningCheck}
 * does the file selection.
 */
export function checkToolchainDispatchOnly(
	doc: unknown,
	file: string = TOOLCHAIN_WORKFLOW,
): string[] {
	const errors: string[] = [];
	const root = asRecord(doc, `${file}: not a YAML mapping`);
	// Bun.YAML keeps the GHA `on:` key as the string "on" (see workflow-sync.ts). `on:` may be a
	// mapping, a single string (`on: workflow_dispatch`), or an array (`on: [dispatch, pull_request]`).
	// Normalize all three to a trigger-name set so a shorthand form can't slip past the check.
	const on = root.on;
	let triggers: Record<string, unknown>;
	if (typeof on === "string") {
		triggers = { [on]: {} };
	} else if (Array.isArray(on)) {
		triggers = Object.fromEntries(
			on.filter((t): t is string => typeof t === "string").map((t) => [t, {}]),
		);
	} else if (on !== null && typeof on === "object") {
		triggers = on as Record<string, unknown>;
	} else {
		errors.push(`${file}: missing or malformed \`on:\` trigger map`);
		return errors;
	}
	for (const key of Object.keys(triggers)) {
		if (!ALLOWED_TOOLCHAIN_TRIGGERS.has(key)) {
			errors.push(
				`${file}: trigger \`${key}\` is not allowed — toolchain publish is workflow_dispatch-only ` +
					`(plus pull_request for the secret-free PR gate); see docs/ci-secrets.md`,
			);
		}
	}
	if (!("workflow_dispatch" in triggers)) {
		errors.push(
			`${file}: must declare \`workflow_dispatch\` — that is the only path that reaches the publish job`,
		);
	}
	if (!("pull_request" in triggers)) {
		errors.push(
			`${file}: must declare \`pull_request\` — the secret-free PR docker smoke gate must stay on the PR path`,
		);
	}

	const jobs = asRecord(root.jobs, `${file}: no jobs mapping`);
	if (!("publish" in jobs)) {
		errors.push(`${file}: missing the "publish" job — that is the GHCR release lane`);
		return errors;
	}
	const publish = asRecord(jobs.publish, `${file}: publish job is not a mapping`);
	if (jobEnvironmentName(publish) !== PRIVILEGED_ENVIRONMENT) {
		errors.push(
			`${file}::publish: must set \`environment: ${PRIVILEGED_ENVIRONMENT}\` — GHCR promote is a release`,
		);
	}
	const publishIf = typeof publish.if === "string" ? publish.if : "";
	for (const needle of [
		"workflow_dispatch",
		"refs/heads/main",
		"starslingdev/hpc-sandbox-benchmarks",
	] as const) {
		if (!publishIf.includes(needle)) {
			errors.push(
				`${file}::publish: \`if:\` must confine the release to workflow_dispatch on main of ` +
					`starslingdev/hpc-sandbox-benchmarks (missing "${needle}")`,
			);
		}
	}
	return errors;
}

function pullRequestPaths(doc: unknown, file: string): string[] {
	const root = asRecord(doc, `${file}: not a YAML mapping`);
	const triggers = asRecord(root.on, `${file}: missing or malformed \`on:\` trigger map`);
	const pullRequest = asRecord(
		triggers.pull_request,
		`${file}: missing or malformed \`pull_request:\` trigger`,
	);
	if (
		!Array.isArray(pullRequest.paths) ||
		!pullRequest.paths.every((path) => typeof path === "string")
	) {
		throw new Error(`${file}: \`pull_request.paths\` must be a string list`);
	}
	return pullRequest.paths;
}

function exactSetError(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): string | undefined {
	const sortedActual = [...actual].sort();
	const sortedExpected = [...expected].sort();
	if (JSON.stringify(sortedActual) === JSON.stringify(sortedExpected)) return undefined;
	return `${label} must be exactly [${expected.join(", ")}], got [${actual.join(", ")}]`;
}

/**
 * Invariant 5: image inputs own the expensive toolchain PR smoke; the CLI/setup/reporting composites
 * own a bounded smoke on the standard runner. This prevents a broad action glob from turning every
 * later push in an action-touching PR into another PTS-heavy image build.
 */
export function checkToolchainPrScope(
	toolchainDoc: unknown,
	actionSmokeDoc: unknown,
	toolchainFile: string = TOOLCHAIN_WORKFLOW,
	actionSmokeFile: string = TOOLCHAIN_ACTION_SMOKE_WORKFLOW,
): string[] {
	const errors: string[] = [];
	const imagePathError = exactSetError(
		pullRequestPaths(toolchainDoc, toolchainFile),
		TOOLCHAIN_IMAGE_PR_PATHS,
		`${toolchainFile}: \`pull_request.paths\``,
	);
	if (imagePathError !== undefined) errors.push(imagePathError);

	const actionPathError = exactSetError(
		pullRequestPaths(actionSmokeDoc, actionSmokeFile),
		TOOLCHAIN_ACTION_SMOKE_PR_PATHS,
		`${actionSmokeFile}: \`pull_request.paths\``,
	);
	if (actionPathError !== undefined) errors.push(actionPathError);

	const root = asRecord(actionSmokeDoc, `${actionSmokeFile}: not a YAML mapping`);
	const jobs = asRecord(root.jobs, `${actionSmokeFile}: no jobs mapping`);
	const smoke = asRecord(jobs.smoke, `${actionSmokeFile}: missing or malformed "smoke" job`);
	const jobLabel = `${actionSmokeFile}::smoke`;
	if (smoke["runs-on"] !== "starsling-ubuntu-24.04-2") {
		errors.push(`${jobLabel}: must use the standard 2-vCPU runner \`starsling-ubuntu-24.04-2\``);
	}
	if (smoke["timeout-minutes"] !== 5) {
		errors.push(`${jobLabel}: must keep \`timeout-minutes: 5\` to bound runner spend`);
	}
	if (smoke.if !== "github.event.pull_request.head.repo.full_name == github.repository") {
		errors.push(`${jobLabel}: must keep the same-repository guard before executing PR code`);
	}

	if (!Array.isArray(smoke.steps)) {
		throw new Error(`${jobLabel}: steps must be a list`);
	}
	const steps = smoke.steps.map((step) => asRecord(step, `${jobLabel}: malformed step`));
	const setup = steps.find((step) => step.uses === "./.github/actions/setup-toolchain");
	if (setup === undefined) {
		errors.push(`${jobLabel}: must execute ./.github/actions/setup-toolchain`);
	} else {
		const withBlock = asRecord(setup.with, `${jobLabel}: setup-toolchain has malformed \`with:\``);
		if (withBlock.buildx !== "true") {
			errors.push(`${jobLabel}: setup-toolchain must pass \`buildx: "true"\``);
		}
	}
	if (!steps.some((step) => step.uses === "./.github/actions/setup-tama")) {
		errors.push(`${jobLabel}: must execute ./.github/actions/setup-tama`);
	}
	const summary = steps.find((step) => step.uses === "./.github/actions/release-summary");
	if (summary === undefined) {
		errors.push(`${jobLabel}: must execute ./.github/actions/release-summary`);
	} else if (summary.if !== "always()") {
		errors.push(`${jobLabel}: release-summary must use \`if: always()\` so failures are reported`);
	}

	const runText = steps
		.map((step) => step.run)
		.filter((run): run is string => typeof run === "string")
		.join("\n");
	for (const probe of [
		"bun --version",
		"1.4.0",
		"tama --version",
		"0.1.17",
		"bun packages/templates/src/pins.ts",
		"docker buildx inspect --bootstrap",
	] as const) {
		if (!runText.includes(probe)) {
			errors.push(`${jobLabel}: runtime probe is missing \`${probe}\``);
		}
	}
	return errors;
}

/** The whole gate against the real .github files under `root`. */
export function runHardeningCheck(root: string = findRepoRoot()): string[] {
	const files = listWorkflowFiles(root);
	const docs = new Map(
		files.map((file) => [file, readWorkflow(`${WORKFLOWS_DIR}/${file}`, root)] as const),
	);
	const steps = files.flatMap((file) => checkoutSteps(docs.get(file), file));
	const ciLintFile = CI_LINT_WORKFLOW.slice(`${WORKFLOWS_DIR}/`.length);
	const ciLintDoc = docs.get(ciLintFile);
	const errors = [
		...checkPersistCredentials(steps),
		...(ciLintDoc === undefined
			? [`${CI_LINT_WORKFLOW}: missing from ${WORKFLOWS_DIR}`]
			: checkCiLintGate(ciLintDoc)),
	];
	// Resolve a local `uses: ./.github/workflows/<f>` to its already-parsed doc so the privileged-env
	// check can verify a reusable callee gates itself; throw on a miss so it's treated as unresolvable.
	const resolveLocalWorkflow = (relPath: string): unknown => {
		const doc = docs.get(relPath.slice(`${WORKFLOWS_DIR}/`.length));
		if (doc === undefined) throw new Error(`no such local workflow: ${relPath}`);
		return doc;
	};
	for (const file of files) {
		errors.push(
			...checkPrivilegedEnvironment(
				docs.get(file),
				file,
				PRIVILEGED_ENVIRONMENT,
				resolveLocalWorkflow,
			),
		);
	}
	const toolchainDoc = docs.get(TOOLCHAIN_WORKFLOW);
	if (toolchainDoc === undefined) {
		errors.push(`${TOOLCHAIN_WORKFLOW}: missing from ${WORKFLOWS_DIR}`);
	} else {
		errors.push(...checkToolchainDispatchOnly(toolchainDoc, TOOLCHAIN_WORKFLOW));
		const actionSmokeDoc = docs.get(TOOLCHAIN_ACTION_SMOKE_WORKFLOW);
		if (actionSmokeDoc === undefined) {
			errors.push(`${TOOLCHAIN_ACTION_SMOKE_WORKFLOW}: missing from ${WORKFLOWS_DIR}`);
		} else {
			errors.push(
				...checkToolchainPrScope(
					toolchainDoc,
					actionSmokeDoc,
					TOOLCHAIN_WORKFLOW,
					TOOLCHAIN_ACTION_SMOKE_WORKFLOW,
				),
			);
		}
	}
	return errors;
}
