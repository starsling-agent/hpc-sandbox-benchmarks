import { describe, expect, test } from "bun:test";
import { config } from "@sandbox-benchmarks/providers";
import { PROVIDERS } from "@sandbox-benchmarks/schema";
import {
	buildReleasePlan,
	planOutputs,
	RELEASE_REQUIRED_PROVIDERS,
	RELEASE_UNSCOPABLE_PROVIDERS,
} from "./release-plan.ts";

const base = { sourceRef: "abc123", forceRepublish: false, alreadyPublished: false };
const backfillBase = { ...base, build: "skip" as const };
const ALL_PROVIDERS = PROVIDERS.map((p) => p.id);

describe("buildReleasePlan mode + skip", () => {
	test("a fresh build of an unpublished version runs (mode build, skip false)", () => {
		const plan = buildReleasePlan(base);
		expect(plan.mode).toBe("build");
		expect(plan.skip).toBe(false);
	});

	test("a plain build skips once the immutable version already exists", () => {
		const plan = buildReleasePlan({ ...base, alreadyPublished: true });
		expect(plan.mode).toBe("build");
		expect(plan.skip).toBe(true);
	});

	test("force_republish regenerates in place even when already published (mode republish, skip false)", () => {
		const plan = buildReleasePlan({ ...base, forceRepublish: true, alreadyPublished: true });
		expect(plan.mode).toBe("republish");
		expect(plan.skip).toBe(false);
		expect(plan.gates.forceRepublish).toBe(true);
	});

	// The reason the scoped path exists: v7 was published for every provider except the one being added,
	// so the early skip would otherwise kill the run before it could backfill anything.
	test("a scoped release runs against an already-published version (mode backfill, skip false)", () => {
		const plan = buildReleasePlan({
			...backfillBase,
			alreadyPublished: true,
			providers: "vercel",
		});
		expect(plan.mode).toBe("backfill");
		expect(plan.partial).toBe(true);
		expect(plan.skip).toBe(false);
	});

	// The early skip spares a release that would only re-publish a version already in the registry. A
	// dispatch that is not publishing has nothing to spare — it asked to bake and verify against the
	// current version — so skipping it would turn the whole run into a silent no-op.
	test("promote: false still runs against an already-published version", () => {
		const plan = buildReleasePlan({ ...base, alreadyPublished: true, promote: false });
		expect(plan.partial).toBe(false);
		expect(plan.promote).toBe(false);
		expect(plan.skip).toBe(false);
	});

	test("...but a promoting full release of the same version still skips", () => {
		expect(buildReleasePlan({ ...base, alreadyPublished: true, promote: true }).skip).toBe(true);
	});
});

describe("buildReleasePlan matrix", () => {
	test("fans out over every provider in registry order", () => {
		const plan = buildReleasePlan(base);
		expect(plan.matrix.include.map((c) => c.provider)).toEqual([
			"e2b",
			"daytona-vm",
			"daytona-container",
			"blaxel",
			"microsandbox-cloud",
			"modal-gvisor",
			"modal-vm",
			"novita",
			"runloop",
			"namespace",
			"vercel",
			"runcloud",
			"tama",
		]);
	});

	test("marks exactly the required providers as gating cells", () => {
		const plan = buildReleasePlan(base);
		const required = plan.matrix.include.filter((c) => c.required).map((c) => c.provider);
		expect(required).toEqual([...RELEASE_REQUIRED_PROVIDERS]);
		expect(plan.required).toEqual([...RELEASE_REQUIRED_PROVIDERS]);
	});

	test("a scoped dispatch emits only its own cells", () => {
		const plan = buildReleasePlan({ ...backfillBase, providers: "vercel" });
		expect(plan.matrix.include).toEqual([{ provider: "vercel", required: true }]);
		expect(plan.providers.map((p) => p.provider)).toEqual(["vercel"]);
	});

	// A named provider that could still skip on a missing secret would report a green release that
	// published nothing — the exact failure the scoped path is meant to make impossible.
	test("every provider a partial dispatch names is required, even a normally best-effort one", () => {
		const plan = buildReleasePlan({
			...backfillBase,
			providers: "daytona-container,novita",
		});
		expect(plan.required).toEqual(["daytona-container", "novita"]);
		expect(plan.matrix.include.every((c) => c.required)).toBe(true);
	});

	// The flip side of "everything you name is required": validating a stock provider does not create
	// an artifact a scoped backfill can ship. The plan refuses that impossible request before approval.
	test("refuses a scope naming a provider the release lane cannot ship", () => {
		expect(() => buildReleasePlan({ ...base, providers: "blaxel" })).toThrow(/blaxel/);
		expect(() => buildReleasePlan({ ...base, providers: "e2b,blaxel" })).toThrow(
			/BL_API_KEY|cannot ship/,
		);
	});

	test("accepts a scoped Runloop release and makes it required", () => {
		const plan = buildReleasePlan({ ...backfillBase, providers: "runloop" });
		expect(plan.matrix.include).toEqual([{ provider: "runloop", required: true }]);
		expect(plan.required).toEqual(["runloop"]);
		expect(plan.providers[0]?.artifact).toBe(config.runloopBlueprintCandidate);
	});

	// Unscoped, the same providers are simply skipped — they are not in the required set, so a missing
	// credential is a skip and the release proceeds. Only a scope makes it a demand.
	test("the same provider is fine in an unscoped release", () => {
		const plan = buildReleasePlan(base);
		expect(plan.matrix.include.map((c) => c.provider)).toContain("blaxel");
		expect(plan.matrix.include.map((c) => c.provider)).toContain("runloop");
		expect(plan.required).not.toContain("blaxel");
		expect(plan.required).not.toContain("runloop");
		expect(Object.keys(RELEASE_UNSCOPABLE_PROVIDERS)).toEqual(["blaxel"]);
	});

	// Everything keys off `partial`, never "did the operator type a list" — otherwise spelling out the
	// registry would quietly make every best-effort provider gating, and force_republish (rejected only
	// for a partial release) would land on a release whose required set had silently grown.
	test("naming the whole registry is an ordinary full release", () => {
		const plan = buildReleasePlan({ ...base, providers: ALL_PROVIDERS.join(",") });
		expect(plan.partial).toBe(false);
		expect(plan.mode).toBe("build");
		expect(plan.required).toEqual([...RELEASE_REQUIRED_PROVIDERS]);
	});

	test("an unknown provider id throws instead of silently shrinking the release", () => {
		expect(() => buildReleasePlan({ ...base, providers: "vercelly" })).toThrow(/vercelly/);
	});
});

describe("buildReleasePlan phases", () => {
	test("defaults to a full build that promotes", () => {
		const plan = buildReleasePlan(base);
		expect(plan.build).toBe("full");
		expect(plan.promote).toBe(true);
	});

	test("carries the build mode and promote toggle through to the plan", () => {
		const plan = buildReleasePlan({ ...base, build: "skip", promote: false });
		expect(plan.build).toBe("skip");
		expect(plan.promote).toBe(false);
	});

	test("refuses to rebuild an unrelated candidate during a scoped backfill", () => {
		expect(() => buildReleasePlan({ ...base, providers: "runcloud" })).toThrow(
			/scoped release.*requires `build: skip`/,
		);
		expect(() =>
			buildReleasePlan({ ...base, providers: "runcloud", build: "full", promote: false }),
		).toThrow(/scoped release.*requires `build: skip`/);
	});
});

describe("buildReleasePlan packages", () => {
	// Every provider derives from the one shared toolchain base — including vercel, which mirrors it
	// into VCR rather than pulling a GHCR image of its own. So the guard covers exactly one package,
	// whatever the scope: a per-provider GHCR package would be another one-time Public bootstrap with
	// no API to automate it, for bytes that are already published.
	test("lists the shared base package, whatever the scope", () => {
		expect(buildReleasePlan(base).packages).toEqual([buildReleasePlan(base).image.name]);
		const scoped = buildReleasePlan({ ...backfillBase, providers: "vercel" });
		expect(scoped.packages).toEqual([scoped.image.name]);
	});
});

describe("buildReleasePlan image source", () => {
	// The ref a vendor-registry mirror pulls. A backfill attaches to the version already live, so it
	// must name THAT — the mutable candidate may already point at the next version's bytes, and
	// mirroring those would verify one image and publish another.
	test("a full release mirrors the mutable candidate", () => {
		const plan = buildReleasePlan(base);
		expect(plan.image.source).toBe(plan.image.candidate);
	});

	test("a scoped backfill mirrors the published version instead", () => {
		const plan = buildReleasePlan({ ...backfillBase, providers: "vercel" });
		expect(plan.partial).toBe(true);
		expect(plan.image.source).toBe(plan.image.version);
	});

	// Naming every provider is an ordinary full release, not a backfill — so it pins the candidate.
	test("naming the whole registry stays on the candidate", () => {
		const plan = buildReleasePlan({ ...base, providers: ALL_PROVIDERS.join(",") });
		expect(plan.partial).toBe(false);
		expect(plan.image.source).toBe(plan.image.candidate);
	});
});

describe("planOutputs", () => {
	test("emits one key=value per line with a single-line matrix json", () => {
		const lines = planOutputs(buildReleasePlan(base)).split("\n");
		expect(lines).toContain("mode=build");
		expect(lines).toContain("skip=false");
		expect(lines).toContain(`required=${RELEASE_REQUIRED_PROVIDERS.join(",")}`);
		const matrixLine = lines.find((l) => l.startsWith("matrix="));
		expect(matrixLine).toBeDefined();
		// The matrix value must be valid, single-line JSON (the fromJSON contract).
		const parsed = JSON.parse((matrixLine as string).slice("matrix=".length));
		expect(parsed.include).toHaveLength(PROVIDERS.length);
		expect((matrixLine as string).includes("\n")).toBe(false);
	});

	// The workflow's `if:` conditions compare against these literal strings, so the booleans have to
	// render as `true`/`false` — not `True`, not empty.
	test("emits the job-skipping gates as the strings the workflow compares against", () => {
		const lines = planOutputs(buildReleasePlan({ ...base, build: "skip", promote: false })).split(
			"\n",
		);
		expect(lines).toContain("build-mode=skip");
		expect(lines).toContain("run-build=false");
		expect(lines).toContain("run-publish=false");
	});

	test("emits the RESOLVED provider scope, so a blank input becomes the whole registry", () => {
		expect(planOutputs(buildReleasePlan(base)).split("\n")).toContain(
			`providers=${ALL_PROVIDERS.join(",")}`,
		);
		expect(
			planOutputs(buildReleasePlan({ ...backfillBase, providers: "vercel" })).split("\n"),
		).toContain("providers=vercel");
	});

	test("emits every package the visibility guard must check, comma-separated", () => {
		const plan = buildReleasePlan(base);
		expect(planOutputs(plan).split("\n")).toContain(`packages=${plan.packages.join(",")}`);
	});
});
