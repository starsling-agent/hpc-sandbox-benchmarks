// Invariant: the GitHub Actions layer stays hardened. (1) every actions/checkout opts out of
// credential persistence unless it is an allowlisted pushing checkout, (2) ci-lint.yml runs
// actionlint + zizmor at the agreed gate threshold, (3) custom-secret / write jobs declare
// environment: privileged, (4) toolchain publish is workflow_dispatch-only, and (5) toolchain PR
// smoke keeps expensive image inputs separate from lightweight setup-action coverage. The
// runHardeningCheck() test against the real .github files IS the gate's CI enforcement point (same
// precedent as workflow-registry-sync.test.ts); the rest is unit coverage of the pure checks on
// synthetic drift so a regression names the offender. See ./lib/workflow-hardening.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckoutStep } from "./lib/workflow-hardening.ts";
import {
	CI_LINT_WORKFLOW,
	CREDENTIALED_CHECKOUTS,
	checkCiLintGate,
	checkoutSteps,
	checkPersistCredentials,
	checkPrivilegedEnvironment,
	checkToolchainDispatchOnly,
	checkToolchainPrScope,
	customSecretsIn,
	listWorkflowFiles,
	PRIVILEGED_ENVIRONMENT,
	readWorkflow,
	runHardeningCheck,
	TOOLCHAIN_ACTION_SMOKE_PR_PATHS,
	TOOLCHAIN_ACTION_SMOKE_WORKFLOW,
	TOOLCHAIN_IMAGE_PR_PATHS,
	TOOLCHAIN_WORKFLOW,
	WORKFLOWS_DIR,
} from "./lib/workflow-hardening.ts";
import { asRecord, stepByName, stepEnv } from "./lib/workflow-yaml.ts";
import { findRepoRoot } from "./lib/workspace.ts";

/** A no-op step — the body for fixtures whose step content is irrelevant to what they assert. */
const NOOP_STEP = { run: "true" };
/** Build a single-job workflow doc: `{ ...root, jobs: { [id]: job } }`. */
const oneJob = (id: string, job: object, root: object = {}) => ({ ...root, jobs: { [id]: job } });
const SCOPED_RUNCLOUD_KEY =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
	"${{ contains(fromJSON(needs.plan.outputs.matrix).include.*.provider, 'runcloud') && secrets.RUN_CLOUD_API_KEY || '' }}";
const SCOPED_RUNLOOP_KEY =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
	"${{ contains(fromJSON(needs.plan.outputs.matrix).include.*.provider, 'runloop') && secrets.RUNLOOP_API_KEY || '' }}";
const SELECTED_BASE_IMAGE =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
	"${{ needs.build.outputs.base-digest-ref || needs.plan.outputs.image-source }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion under test
const BASE_IMAGE_ARG = '--base-image "${BASE_IMAGE_REF}"';

function workflowJob(doc: unknown, jobId: string, label: string): Record<string, unknown> {
	const root = asRecord(doc, `${label}: not a YAML mapping`);
	const jobs = asRecord(root.jobs, `${label}: no jobs mapping`);
	return asRecord(jobs[jobId], `${label}: job "${jobId}" not found`);
}

/** Every value assigned to a named key below one parsed YAML node, including job- and step-level env. */
function valuesForKey(value: unknown, key: string): unknown[] {
	if (Array.isArray(value)) return value.flatMap((item) => valuesForKey(item, key));
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([name, child]) =>
		name === key ? [child] : valuesForKey(child, key),
	);
}

describe("checkoutSteps against the real workflows", () => {
	test("every workflow's checkouts are extracted with a persist-credentials reading", () => {
		const files = listWorkflowFiles();
		expect(files).toContain("ci.yml");
		expect(files).toContain("ci-lint.yml");
		const steps = files.flatMap((file) =>
			checkoutSteps(readWorkflow(`${WORKFLOWS_DIR}/${file}`, undefined), file),
		);
		// Sanity: there are several checkouts and ci.yml's reads false.
		expect(steps.length).toBeGreaterThanOrEqual(5);
		const ci = steps.find((s) => s.file === "ci.yml");
		expect(ci?.persistCredentials).toBe(false);
	});

	test("reads persist-credentials whether YAML types it as a boolean or a quoted string", () => {
		const doc = {
			jobs: {
				j: {
					steps: [
						{ uses: "actions/checkout@v4", with: { "persist-credentials": false } },
						{ uses: "actions/checkout@v4", with: { "persist-credentials": "false" } },
						{ uses: "actions/checkout@v4", with: { "persist-credentials": "true" } },
					],
				},
			},
		};
		expect(checkoutSteps(doc, "synthetic.yml").map((s) => s.persistCredentials)).toEqual([
			false,
			false,
			true,
		]);
	});
});

describe("checkPersistCredentials", () => {
	const allowlist = { "bench-matrix.yml::publish": "pushes the dataset" };

	test("passes when read-only checkouts opt out and the pushing one keeps its token", () => {
		const steps: CheckoutStep[] = [
			{ file: "ci.yml", jobId: "check", persistCredentials: false },
			{ file: "bench-matrix.yml", jobId: "plan", persistCredentials: false },
			{ file: "bench-matrix.yml", jobId: "publish", persistCredentials: undefined },
		];
		expect(checkPersistCredentials(steps, allowlist)).toEqual([]);
	});

	test("flags a read-only checkout that forgot persist-credentials: false", () => {
		const steps: CheckoutStep[] = [
			{ file: "ci.yml", jobId: "check", persistCredentials: undefined },
		];
		const errors = checkPersistCredentials(steps, {});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("ci.yml::check");
		expect(errors[0]).toContain("persist-credentials: false");
	});

	test("flags a checkout that sets persist-credentials: true explicitly", () => {
		const steps: CheckoutStep[] = [{ file: "ci.yml", jobId: "check", persistCredentials: true }];
		expect(checkPersistCredentials(steps, {})).toHaveLength(1);
	});

	test("flags an allowlisted pushing checkout that opted out (its push would break)", () => {
		const steps: CheckoutStep[] = [
			{ file: "bench-matrix.yml", jobId: "publish", persistCredentials: false },
		];
		const errors = checkPersistCredentials(steps, allowlist);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("allowlisted as a pushing checkout");
	});

	test("flags a stale allowlist entry with no matching checkout", () => {
		const errors = checkPersistCredentials([], allowlist);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("no such checkout step exists");
	});
});

describe("checkCiLintGate", () => {
	const good = {
		jobs: {
			actionlint: { steps: [{ run: "mise exec -- actionlint -no-color" }] },
			zizmor: {
				steps: [
					{
						run: "mise exec -- zizmor --min-severity medium --min-confidence high .github/workflows/",
					},
				],
			},
		},
	};

	test("passes the real ci-lint.yml", () => {
		expect(checkCiLintGate(readWorkflow(CI_LINT_WORKFLOW, undefined))).toEqual([]);
	});

	test("passes a well-formed synthetic gate", () => {
		expect(checkCiLintGate(good)).toEqual([]);
	});

	test("flags a missing zizmor job", () => {
		const errors = checkCiLintGate({ jobs: { actionlint: good.jobs.actionlint } });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('missing the "zizmor" job');
	});

	test("flags a loosened zizmor threshold (dropped --min-confidence)", () => {
		const loosened = {
			jobs: {
				actionlint: good.jobs.actionlint,
				zizmor: {
					steps: [{ run: "mise exec -- zizmor --min-severity medium .github/workflows/" }],
				},
			},
		};
		const errors = checkCiLintGate(loosened);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("--min-confidence high");
	});
});

describe("Vercel CLI authentication", () => {
	test("all Vercel jobs use the shared action without raw token minting", () => {
		const root = findRepoRoot();
		const workflowText = ["bench-smoke.yml", "bench-suite.yml", "toolchain-image.yml"]
			.map((file) => readFileSync(join(root, WORKFLOWS_DIR, file), "utf8"))
			.join("\n");
		// Three call sites: the reusable benchmark cell (bench-suite.yml) plus toolchain-image.yml's two.
		// bench-smoke.yml is still read here — not because it authenticates (it reaches Vercel only
		// through the reusable cell now) but so the "no hand-minted token" assertions below still cover
		// it if a lane ever grows its own credential handling again.
		expect(workflowText.match(/uses: \.\/\.github\/actions\/vercel-auth/g)).toHaveLength(3);
		expect(workflowText).not.toContain("api.vercel.com/v1/projects");
		expect(workflowText).not.toContain("VERCEL_OIDC_TOKEN_FILE");
		expect(workflowText).not.toContain("docker login vcr.vercel.com");
		// Two best-effort `always()` fallbacks remain; the immediate post-mirror logout is fail-closed.
		expect(workflowText.match(/docker logout vcr\.vercel\.com \|\| true/g)).toHaveLength(2);
		expect(workflowText).toContain('vercel vcr push docker "$target_name"');
		const toolchain = readFileSync(join(root, WORKFLOWS_DIR, "toolchain-image.yml"), "utf8");
		expect(toolchain.indexOf("- name: Log out of VCR after mirror")).toBeGreaterThan(
			toolchain.indexOf("- name: Mirror candidate into VCR"),
		);
		expect(toolchain.indexOf("- name: Log out of VCR after mirror")).toBeLessThan(
			toolchain.indexOf("- name: Bake + verify candidate"),
		);
		expect(toolchain).toContain(
			"- name: Log out of VCR after mirror\n        if: matrix.provider == 'vercel' && steps.vercel-vcr.outcome == 'success'\n        run: docker logout vcr.vercel.com\n",
		);
		expect(toolchain).not.toContain(
			"- name: Log out of VCR after mirror\n        if: matrix.provider == 'vercel' && steps.vercel-vcr.outcome == 'success'\n        run: docker logout vcr.vercel.com || true",
		);
		expect(toolchain).toContain("- name: Ensure VCR logout\n        if: always()");
	});

	test("the composite masks the OIDC token and deletes its temporary env file before export", () => {
		const root = join(findRepoRoot(), ".github/actions/vercel-auth");
		const action = readFileSync(join(root, "action.yml"), "utf8");
		const script = readFileSync(join(root, "auth.sh"), "utf8");
		expect(action).toContain(`run: "\${GITHUB_ACTION_PATH}/auth.sh"`);
		expect(script).toContain("pull --yes --non-interactive");
		expect(script).toContain('env pull "$env_file" --yes --non-interactive');
		expect(script).toContain("vcr login docker");
		expect(script.indexOf('rm -f "$env_file" "$pull_env_file"')).toBeLessThan(
			script.indexOf("printf '::add-mask::%s\\n'"),
		);
		expect(script.indexOf("printf '::add-mask::%s\\n'")).toBeLessThan(script.indexOf("GITHUB_ENV"));
	});
});

describe("Namespace token authentication", () => {
	test("all managed lanes share one producer id and output contract", () => {
		const root = findRepoRoot();
		const workflowText = ["bench-suite.yml", "toolchain-image.yml"]
			.map((file) => readFileSync(join(root, WORKFLOWS_DIR, file), "utf8"))
			.join("\n");
		expect(workflowText.match(/uses: \.\/\.github\/actions\/namespace-token/g)).toHaveLength(3);
		expect(workflowText.match(/id: namespace/g)).toHaveLength(3);
		expect(
			workflowText.match(/NSC_TOKEN_FILE: \$\{\{ steps\.namespace\.outputs\.token-file \}\}/g),
		).toHaveLength(4);
		expect(workflowText).not.toContain("id: nsc-token");
		expect(workflowText).not.toContain("id: nsc-setup");
		expect(workflowText).not.toMatch(/run: \|\s*\n\s*nsc token create/);
	});

	test("the composite explicitly bounds each minted token to the benchmark cell window", () => {
		const action = readFileSync(
			join(findRepoRoot(), ".github/actions/namespace-token/action.yml"),
			"utf8",
		);
		expect(action).toContain("--expires_in 4h");
		expect(action).not.toContain("--no_expiry");
	});
});

describe("run.cloud credential scoping", () => {
	test("the promote step exposes the key only when the resolved plan contains runcloud", () => {
		const doc = readWorkflow(`${WORKFLOWS_DIR}/${TOOLCHAIN_WORKFLOW}`);
		const publish = workflowJob(doc, "publish", TOOLCHAIN_WORKFLOW);
		// Exactly one assignment anywhere in the publish job, and its entire value is the plan gate. This
		// rejects every unscoped spelling (including `secrets.RUN_CLOUD_API_KEY || ''`) rather than one
		// fragile literal while ignoring a second assignment in another step or at job scope.
		expect(valuesForKey(publish, "RUN_CLOUD_API_KEY")).toEqual([SCOPED_RUNCLOUD_KEY]);
	});
});

describe("Runloop credential scoping", () => {
	test("the promote step exposes the key only when the resolved plan contains runloop", () => {
		const doc = readWorkflow(`${WORKFLOWS_DIR}/${TOOLCHAIN_WORKFLOW}`);
		const publish = workflowJob(doc, "publish", TOOLCHAIN_WORKFLOW);
		expect(valuesForKey(publish, "RUNLOOP_API_KEY")).toEqual([SCOPED_RUNLOOP_KEY]);
	});
});

describe("toolchain bake base-image selection", () => {
	test("threads one immutable source through every bake cell and the Vercel mirror", () => {
		const doc = readWorkflow(`${WORKFLOWS_DIR}/${TOOLCHAIN_WORKFLOW}`);
		const env = stepEnv(doc, "bake", "Bake + verify candidate", TOOLCHAIN_WORKFLOW);
		expect(env.BASE_IMAGE_REF).toBe(SELECTED_BASE_IMAGE);
		const mirrorEnv = stepEnv(
			doc,
			"bake",
			"Mirror the toolchain base into VCR",
			TOOLCHAIN_WORKFLOW,
		);
		expect(mirrorEnv.SOURCE_REF).toBe(SELECTED_BASE_IMAGE);
		const step = stepByName(
			workflowJob(doc, "bake", TOOLCHAIN_WORKFLOW),
			"Bake + verify candidate",
			TOOLCHAIN_WORKFLOW,
		);
		expect(step?.run).toContain(BASE_IMAGE_ARG);
	});
});

describe("customSecretsIn", () => {
	test("ignores GITHUB_TOKEN and extracts provider secrets in dot and bracket notation", () => {
		expect(
			customSecretsIn(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
				"${{ secrets.GITHUB_TOKEN }} ${{ secrets.E2B_API_KEY }} ${{ secrets.DAYTONA_TARGET || 'us-west-2' }} ${{ secrets['NOVITA_API_KEY'] }} ${{ secrets[\"BL_API_KEY\"] }}",
			),
		).toEqual(["E2B_API_KEY", "DAYTONA_TARGET", "NOVITA_API_KEY", "BL_API_KEY"]);
	});

	test("matches the dot accessor even with GHA-legal whitespace around it", () => {
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			customSecretsIn("${{ secrets . E2B_API_KEY }} ${{ secrets. DAYTONA_API_KEY }}"),
		).toEqual(["E2B_API_KEY", "DAYTONA_API_KEY"]);
	});

	test("detects a secret guarded behind a condition (the scoped `&& secrets.X || ''` form)", () => {
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			customSecretsIn("${{ inputs.provider == 'daytona' && secrets.DAYTONA_API_KEY || '' }}"),
		).toEqual(["DAYTONA_API_KEY"]);
	});

	test("finds every secret access within a single expression block", () => {
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			customSecretsIn("${{ secrets.A || secrets.B }}"),
		).toEqual(["A", "B"]);
	});
});

describe("checkPrivilegedEnvironment", () => {
	test("passes the real privileged workflows", () => {
		for (const file of [
			"bench-matrix.yml",
			"bench-smoke.yml",
			"toolchain-image.yml",
			"commit-dataset.yml",
			"update-leaderboard.yml",
		]) {
			expect(checkPrivilegedEnvironment(readWorkflow(`${WORKFLOWS_DIR}/${file}`), file)).toEqual(
				[],
			);
		}
	});

	test("passes jobs that only use GITHUB_TOKEN without an environment", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
		const env = { TOKEN: "${{ secrets.GITHUB_TOKEN }}" };
		const doc = oneJob("clone", { steps: [{ env, run: "true" }] });
		expect(checkPrivilegedEnvironment(doc, "safe.yml")).toEqual([]);
	});

	test("flags a custom secret without environment: privileged", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
		const env = { E2B_API_KEY: "${{ secrets.E2B_API_KEY }}" };
		const doc = oneJob("bench", { steps: [{ env, run: "true" }] });
		const errors = checkPrivilegedEnvironment(doc, "leak.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("leak.yml::bench");
		expect(errors[0]).toContain(`environment: ${PRIVILEGED_ENVIRONMENT}`);
		expect(errors[0]).toContain("E2B_API_KEY");
	});

	test("flags a provider-scoped secret env value (condition && secrets.X || '') without privileged", () => {
		// The bench/smoke lanes scope each secret behind a condition; the gate must still require
		// `environment: privileged` for such a job, or removing it would silently pass the drift gate.
		const env = {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			DAYTONA_API_KEY: "${{ matrix.provider == 'daytona' && secrets.DAYTONA_API_KEY || '' }}",
		};
		const doc = oneJob("bench", { steps: [{ env, run: "true" }] });
		const errors = checkPrivilegedEnvironment(doc, "scoped-leak.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("scoped-leak.yml::bench");
		expect(errors[0]).toContain("DAYTONA_API_KEY");
		expect(errors[0]).toContain(`environment: ${PRIVILEGED_ENVIRONMENT}`);
	});

	test("flags custom secrets in job or step if conditions without environment: privileged", () => {
		const doc = oneJob("bench", {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			if: "${{ secrets.JOB_SECRET != '' }}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			steps: [{ if: "${{ secrets.STEP_SECRET != '' }}", run: "true" }],
		});
		const errors = checkPrivilegedEnvironment(doc, "leak-if.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("leak-if.yml::bench");
		expect(errors[0]).toContain("JOB_SECRET");
		expect(errors[0]).toContain("STEP_SECRET");
	});

	test("flags custom secrets in workflow-level env inherited by every job", () => {
		const doc = oneJob(
			"plan",
			{ steps: [NOOP_STEP] },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			{ env: { E2B_API_KEY: "${{ secrets.E2B_API_KEY }}" } },
		);
		const errors = checkPrivilegedEnvironment(doc, "leak-root-env.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("leak-root-env.yml::plan");
		expect(errors[0]).toContain("E2B_API_KEY");
	});

	test("flags packages: write without the privileged environment", () => {
		const doc = oneJob("publish", { permissions: { packages: "write" }, steps: [NOOP_STEP] });
		const errors = checkPrivilegedEnvironment(doc, "ghcr.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("packages: write");
	});

	test("accepts a write job that declares environment: privileged", () => {
		const doc = oneJob("publish", {
			environment: PRIVILEGED_ENVIRONMENT,
			permissions: { contents: "write" },
			steps: [NOOP_STEP],
		});
		expect(checkPrivilegedEnvironment(doc, "ok.yml")).toEqual([]);
	});

	test("handles the string permissions shorthand (write-all elevates, read-all does not)", () => {
		// `permissions: write-all` grants contents+packages write — must be flagged; the string form
		// must not throw (it once crashed asRecord). `read-all` grants no write, so it is clean.
		const errors = checkPrivilegedEnvironment(
			oneJob("publish", { permissions: "write-all", steps: [NOOP_STEP] }),
			"write-all.yml",
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("contents: write");
		expect(errors[0]).toContain("packages: write");

		expect(
			checkPrivilegedEnvironment(
				oneJob("publish", { permissions: "read-all", steps: [NOOP_STEP] }),
				"read-all.yml",
			),
		).toEqual([]);
	});

	test("flags secrets forwarded to a REMOTE reusable workflow (secrets: inherit) — unverifiable", () => {
		// `secrets: inherit` on a `uses:` job forwards every repo secret with no ${{ secrets.* }} here.
		// A remote callee can't be checked to gate on the privileged Environment, so it is flagged.
		const doc = oneJob("call", {
			uses: "org/repo/.github/workflows/release.yml@main",
			secrets: "inherit",
		});
		const errors = checkPrivilegedEnvironment(doc, "reusable.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("remote reusable workflow");
		expect(errors[0]).toContain(`environment: ${PRIVILEGED_ENVIRONMENT}`);
	});

	// A local callee that gates a job on the privileged Environment, and one that gates nothing —
	// injected via the resolver so these stay pure unit tests independent of on-disk workflow files.
	const gatedCallee = oneJob("run", {
		environment: PRIVILEGED_ENVIRONMENT,
		permissions: { contents: "write" },
		steps: [NOOP_STEP],
	});
	const ungatedCallee = oneJob("run", { permissions: { contents: "write" }, steps: [NOOP_STEP] });

	test("accepts a local reusable-workflow call that forwards secrets when the callee gates a job", () => {
		// GHA forbids `environment:` on a `uses:` job, so a local call can't gate on the caller — but the
		// caller's grant is invisible in the callee's YAML, so the gate resolves the callee and requires
		// it to gate a job itself.
		const doc = oneJob("call", {
			uses: "./.github/workflows/commit-dataset.yml",
			secrets: "inherit",
		});
		expect(
			checkPrivilegedEnvironment(doc, "reusable-ok.yml", PRIVILEGED_ENVIRONMENT, () => gatedCallee),
		).toEqual([]);
	});

	test("flags a local reusable call whose callee gates no job (caller can't gate itself)", () => {
		const doc = oneJob("publish", {
			uses: "./.github/workflows/ungated.yml",
			permissions: { contents: "write" },
		});
		const errors = checkPrivilegedEnvironment(
			doc,
			"caller.yml",
			PRIVILEGED_ENVIRONMENT,
			() => ungatedCallee,
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("caller.yml::publish");
		expect(errors[0]).toContain("no job in it sets");
		expect(errors[0]).toContain(`environment: ${PRIVILEGED_ENVIRONMENT}`);
	});

	test("skips a local reusable call whose callee can't be resolved (actionlint covers a missing file)", () => {
		const doc = oneJob("publish", {
			uses: "./.github/workflows/missing.yml",
			permissions: { contents: "write" },
		});
		const errors = checkPrivilegedEnvironment(doc, "caller.yml", PRIVILEGED_ENVIRONMENT, () => {
			throw new Error("ENOENT");
		});
		expect(errors).toEqual([]);
	});

	test("flags a secret passed to a REMOTE reusable workflow via a JOB-LEVEL with: input", () => {
		// A `uses:` job has no steps: its inputs ride a job-level `with:`. Passing a secret as an input
		// there (instead of the `secrets:` block) to an unverifiable remote callee must not slip past.
		const doc = oneJob("call", {
			uses: "org/repo/.github/workflows/deploy.yml@main",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			with: { api_key: "${{ secrets.DEPLOY_KEY }}" },
		});
		const errors = checkPrivilegedEnvironment(doc, "with-leak.yml");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("DEPLOY_KEY");
		expect(errors[0]).toContain(`environment: ${PRIVILEGED_ENVIRONMENT}`);
	});

	test("accepts a local reusable call that passes a secret via a job-level with: input", () => {
		// A local call defers the privileged gate to the called file, which must gate a job itself.
		const doc = oneJob("call", {
			uses: "./.github/workflows/deploy.yml",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test
			with: { api_key: "${{ secrets.DEPLOY_KEY }}" },
		});
		expect(
			checkPrivilegedEnvironment(doc, "with-ok.yml", PRIVILEGED_ENVIRONMENT, () => gatedCallee),
		).toEqual([]);
	});

	test("accepts a local reusable call that grants write perms (bench-matrix.yml::publish shape)", () => {
		// The real case: bench-matrix's publish job grants contents/pull-requests write to the local
		// commit-dataset.yml. A `uses:` job can't set `environment:`; the called file gates a job.
		const doc = oneJob("publish", {
			uses: "./.github/workflows/commit-dataset.yml",
			permissions: { contents: "write", "pull-requests": "write", actions: "read" },
			with: { run_id: "123" },
		});
		expect(
			checkPrivilegedEnvironment(
				doc,
				"bench-matrix.yml",
				PRIVILEGED_ENVIRONMENT,
				() => gatedCallee,
			),
		).toEqual([]);
	});
});

describe("checkToolchainDispatchOnly", () => {
	// The main-only dispatch guard the publish job's `if:` must carry, and a publish job that passes.
	const DISPATCH_GATE_IF =
		"github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'starslingdev/hpc-sandbox-benchmarks'";
	const gatedPublish = {
		environment: PRIVILEGED_ENVIRONMENT,
		if: DISPATCH_GATE_IF,
		steps: [NOOP_STEP],
	};

	test("passes the real toolchain-image.yml", () => {
		expect(
			checkToolchainDispatchOnly(
				readWorkflow(`${WORKFLOWS_DIR}/${TOOLCHAIN_WORKFLOW}`),
				TOOLCHAIN_WORKFLOW,
			),
		).toEqual([]);
	});

	test("flags a push trigger on the toolchain workflow", () => {
		const doc = {
			on: { workflow_dispatch: {}, pull_request: {}, push: { branches: ["main"] } },
			jobs: { publish: gatedPublish },
		};
		const errors = checkToolchainDispatchOnly(doc, TOOLCHAIN_WORKFLOW);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("trigger `push` is not allowed");
	});

	test("flags a publish job missing the main-only dispatch gate", () => {
		const doc = {
			on: { workflow_dispatch: {}, pull_request: {} },
			jobs: { publish: { ...gatedPublish, if: "true" } },
		};
		const errors = checkToolchainDispatchOnly(doc, TOOLCHAIN_WORKFLOW);
		expect(errors.some((e) => e.includes('missing "workflow_dispatch"'))).toBe(true);
		expect(errors.some((e) => e.includes('missing "refs/heads/main"'))).toBe(true);
	});

	test("normalizes the string and array `on:` shorthand forms", () => {
		// `on: workflow_dispatch` (string) has no pull_request → the PR-gate requirement fires.
		const stringForm = { on: "workflow_dispatch", jobs: { publish: gatedPublish } };
		const stringErrors = checkToolchainDispatchOnly(stringForm, TOOLCHAIN_WORKFLOW);
		expect(stringErrors.some((e) => e.includes("must declare `pull_request`"))).toBe(true);
		// `on: [workflow_dispatch, pull_request]` (array) is the allowed pair → clean.
		const arrayForm = {
			on: ["workflow_dispatch", "pull_request"],
			jobs: { publish: gatedPublish },
		};
		expect(checkToolchainDispatchOnly(arrayForm, TOOLCHAIN_WORKFLOW)).toEqual([]);
	});
});

describe("checkToolchainPrScope", () => {
	const imageDoc = (paths: readonly string[] = TOOLCHAIN_IMAGE_PR_PATHS) => ({
		on: { pull_request: { paths: [...paths] } },
	});
	const actionSmokeDoc = ({
		paths = TOOLCHAIN_ACTION_SMOKE_PR_PATHS,
		buildx = "true",
		summaryIf = "always()",
		run = `test "$(bun --version)" = "1.4.0"
test "$(tama --version | awk '{print $2}')" = "0.1.17"
bun packages/templates/src/pins.ts >/dev/null
docker buildx inspect --bootstrap`,
		tama = true,
	}: {
		paths?: readonly string[];
		buildx?: string;
		summaryIf?: string;
		run?: string;
		tama?: boolean;
	} = {}) => ({
		on: { pull_request: { paths: [...paths] } },
		jobs: {
			smoke: {
				if: "github.event.pull_request.head.repo.full_name == github.repository",
				"runs-on": "starsling-ubuntu-24.04-2",
				"timeout-minutes": 5,
				steps: [
					{ uses: "./.github/actions/setup-toolchain", with: { buildx } },
					...(tama ? [{ uses: "./.github/actions/setup-tama" }] : []),
					{ run },
					{ uses: "./.github/actions/release-summary", if: summaryIf },
				],
			},
		},
	});

	test("passes the real expensive and lightweight toolchain workflows", () => {
		expect(
			checkToolchainPrScope(
				readWorkflow(`${WORKFLOWS_DIR}/${TOOLCHAIN_WORKFLOW}`),
				readWorkflow(`${WORKFLOWS_DIR}/${TOOLCHAIN_ACTION_SMOKE_WORKFLOW}`),
			),
		).toEqual([]);
	});

	test("rejects a broad action glob on the expensive image workflow", () => {
		const errors = checkToolchainPrScope(
			imageDoc([...TOOLCHAIN_IMAGE_PR_PATHS, ".github/actions/**"]),
			actionSmokeDoc(),
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(".github/actions/**");
	});

	test("rejects missing transitive action ownership and weakened runtime coverage", () => {
		const paths = TOOLCHAIN_ACTION_SMOKE_PR_PATHS.filter(
			(path) => path !== ".github/actions/setup-workspace/**",
		);
		const errors = checkToolchainPrScope(
			imageDoc(),
			actionSmokeDoc({
				paths,
				buildx: "false",
				summaryIf: "success()",
				run: "bun --version",
				tama: false,
			}),
		);
		expect(errors.some((error) => error.includes("setup-workspace/**"))).toBe(true);
		expect(errors.some((error) => error.includes('buildx: "true"'))).toBe(true);
		expect(errors.some((error) => error.includes("if: always()"))).toBe(true);
		expect(errors.some((error) => error.includes("setup-tama"))).toBe(true);
		expect(errors.some((error) => error.includes("tama --version"))).toBe(true);
		expect(errors.some((error) => error.includes("packages/templates/src/pins.ts"))).toBe(true);
		expect(errors.some((error) => error.includes("docker buildx inspect --bootstrap"))).toBe(true);
	});
});

describe("the gate itself", () => {
	test("the real .github layer is hardened", () => {
		expect(runHardeningCheck()).toEqual([]);
	});

	test("the allowlist documents a reason for every entry", () => {
		for (const [key, reason] of Object.entries(CREDENTIALED_CHECKOUTS)) {
			expect(key).toContain("::");
			expect(reason.length).toBeGreaterThan(0);
		}
	});
});
