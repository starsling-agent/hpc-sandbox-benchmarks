// Offline (no creds, no network) verification that the Daytona region pin actually reaches the
// wire. The native SDK ignores createParams.target and sends only its CLIENT-level target, which a
// `new Daytona({ apiKey })` client resolves solely from the DAYTONA_TARGET env fallback — so these
// tests drive the REAL wrapper + REAL SDK create path with the axios transport stubbed to capture
// the createSandbox POST body, the same seam the run-29850811070 replay proved the bug and fix on.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { daytona } from "@computesdk/daytona";
import type { SandboxMethods } from "@computesdk/provider";
import { Daytona } from "@daytonaio/sdk";
import { config } from "../config.ts";
import { adapters } from "./adapters.ts";
import { daytonaClientTarget } from "./daytona-target.ts";

interface CapturedRequest {
	url?: string;
	method?: string;
	data?: unknown;
}

const captured: CapturedRequest[] = [];

// The stub records then aborts every request, so each create attempt REJECTS — the after-create env
// assertions below therefore all exercise restore on the rejected-create path, the harder finally
// case. The wrapper wraps the abort into its generic create-failure message.
function stubAxios() {
	return {
		interceptors: { request: { use: () => 0 }, response: { use: () => 0 } },
		defaults: { headers: {} },
		request: async (requestConfig: CapturedRequest) => {
			captured.push(requestConfig);
			throw new Error("transport stubbed: request captured");
		},
	};
}

// createAxiosInstance is the SDK's static transport factory, called per client construction —
// replacing it intercepts every request without touching the client-side create logic under test.
const sdkClass = Daytona as unknown as { createAxiosInstance: () => unknown };
const stockAxiosFactory = sdkClass.createAxiosInstance;

// Test files share one process, so every env mutation is snapshotted and restored per test. Note
// `config` froze at module load — assertions compare the wire body against that same frozen config,
// so runtime env mutations here only shape the SDK's fallback, never the expected pin value.
const ENV_KEYS = ["DAYTONA_API_KEY", "DAYTONA_TARGET", "DAYTONA_CONTAINER_TARGET"] as const;
let savedEnv: Record<string, string | undefined> = {};

async function attemptCreate(
	providerId: "daytona-container",
	createOptions?: Record<string, unknown>,
) {
	const adapter = adapters[providerId];
	const compute = adapter.createCompute();
	await expect(
		compute.sandbox.create({ ...adapter.createOptions, ...createOptions }),
	).rejects.toThrow(/Failed to create Daytona sandbox/);
	const request = captured.find((c) => (c.url ?? "").includes("sandbox"));
	expect(request).toBeDefined();
	const body = typeof request?.data === "string" ? JSON.parse(request.data) : request?.data;
	return body as { target?: string; snapshot?: string };
}

describe("daytonaClientTarget", () => {
	beforeAll(() => {
		sdkClass.createAxiosInstance = stubAxios;
	});
	afterAll(() => {
		sdkClass.createAxiosInstance = stockAxiosFactory;
	});
	beforeEach(() => {
		savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		// The wrapper's create resolves its API key at call time (config first, env fallback), so a
		// fake key here lets the create path reach the transport instead of the credential guard.
		process.env.DAYTONA_API_KEY = "fake-key-offline-test";
		delete process.env.DAYTONA_CONTAINER_TARGET;
		captured.length = 0;
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("pins the container create's wire target from config, not the job's empty DAYTONA_TARGET", async () => {
		// A container CI job materializes DAYTONA_TARGET as SET-but-empty (the vm-only secret is blank
		// for its matrix cell); unpinned, the SDK's env fallback POSTs target:'' and the API falls back
		// to the org default region, where no container snapshot exists — run 29850811070's failure
		// mode across all 9 suites.
		process.env.DAYTONA_TARGET = "";
		expect(config.daytonaContainer.target).toBeTruthy();
		const body = await attemptCreate("daytona-container");
		expect(body.target).toBe(config.daytonaContainer.target);
		expect(body.snapshot).toBe(config.daytonaContainer.snapshot);
		// Restore semantics on the rejected create: the set-but-empty value comes back exactly.
		expect(process.env.DAYTONA_TARGET).toBe("");
	});

	it("deletes DAYTONA_TARGET after create when it was previously unset", async () => {
		delete process.env.DAYTONA_TARGET;
		const body = await attemptCreate("daytona-container");
		expect(body.target).toBe(config.daytonaContainer.target);
		// Deleted, not set to "" — a leaked empty string would flip the config gatekeeper's
		// set-but-empty handling for anything loaded after this create.
		expect("DAYTONA_TARGET" in process.env).toBe(false);
	});

	it("honors candidate validation's per-create target override on the wire", async () => {
		// validate.ts returns a target alongside the candidate snapshot. The native SDK ignores that
		// createParams field, so daytonaClientTarget must promote it to the client-level env channel;
		// otherwise the helper's advertised override silently boots in the adapter's default region.
		process.env.DAYTONA_TARGET = "pre-existing-region";
		const body = await attemptCreate("daytona-container", { target: "candidate-region" });
		expect(body.target).toBe("candidate-region");
		// Even the override path must restore the caller's environment after a rejected create.
		expect(process.env.DAYTONA_TARGET).toBe("pre-existing-region");
	});

	it("patches only the instance's methods table, leaving the wrapper's shared table stock", () => {
		const methodsOf = (p: unknown) =>
			(p as { sandbox: { methods: Record<string, unknown> } }).sandbox.methods;
		const stock = methodsOf(daytona({ apiKey: "fake-key-offline-test" }));
		// Precondition that makes the inequality meaningful: defineProvider hands every instance the
		// SAME module-level methods object by reference. If an upgrade switches to per-instance
		// closures, this fails loudly instead of the patch check passing vacuously.
		expect(methodsOf(daytona({ apiKey: "fake-key-offline-test" })).create).toBe(stock.create);
		const patched = methodsOf(
			daytonaClientTarget(daytona({ apiKey: "fake-key-offline-test" }), "us-west-2"),
		);
		// Every client-constructing method is replaced, not just create — the getById/list/destroy
		// teardown path builds a fresh `new Daytona({ apiKey })` too and must run under the pin.
		for (const name of ["create", "getById", "list", "destroy"] as const) {
			expect(typeof stock[name]).toBe("function");
			expect(patched[name]).not.toBe(stock[name]);
			// The shared table was not mutated — a fresh unpatched instance still gets the stock method.
			expect(methodsOf(daytona({ apiKey: "fake-key-offline-test" }))[name]).toBe(stock[name]);
		}
	});

	it("fails loudly when the wrapper's internals change shape", () => {
		const noCreate = { sandbox: { methods: { create: "not-a-function" } } };
		expect(() => daytonaClientTarget(noCreate as never, "us-west-2")).toThrow(/changed shape/);
	});
});

// getById/list/destroy don't hit the createSandbox POST the wire tests capture — their region is
// baked into `new Daytona({ apiKey })` at construction from the DAYTONA_TARGET fallback. So drive the
// wrapper against a provider whose stock methods record the env they observe, proving each runs under
// the same client-level pin as create (the teardown leak cosmic-emerald flagged) and restores after.
describe("daytonaClientTarget pins the teardown/lookup path, not just create", () => {
	let savedTarget: string | undefined;
	beforeEach(() => {
		savedTarget = process.env.DAYTONA_TARGET;
	});
	afterEach(() => {
		if (savedTarget === undefined) delete process.env.DAYTONA_TARGET;
		else process.env.DAYTONA_TARGET = savedTarget;
	});

	// A fake DirectProvider whose create/getById/list/destroy each record process.env.DAYTONA_TARGET at
	// call time, so the assertions can prove the pin is live while the fresh client would be built.
	function recordingProvider(seen: Record<string, string | undefined>) {
		const record = (name: string, result: unknown) => () => {
			seen[name] = process.env.DAYTONA_TARGET;
			return Promise.resolve(result);
		};
		return {
			sandbox: {
				methods: {
					create: record("create", { sandbox: {}, sandboxId: "sbx" }),
					getById: record("getById", null),
					list: record("list", []),
					destroy: record("destroy", undefined),
				},
			},
		} as never;
	}

	function patchedMethods(seen: Record<string, string | undefined>, target: string | undefined) {
		return (
			daytonaClientTarget(recordingProvider(seen), target) as unknown as {
				sandbox: { methods: SandboxMethods<unknown, unknown> };
			}
		).sandbox.methods;
	}

	it("pins the configured target while destroy/getById/list run", async () => {
		// The container job's set-but-empty env: unpinned, destroy would build its client in the account
		// default region and never find the us-west-2 sandbox create just made.
		process.env.DAYTONA_TARGET = "";
		const seen: Record<string, string | undefined> = {};
		const methods = patchedMethods(seen, "us-west-2");
		await methods.destroy({}, "sbx-1");
		await methods.getById({}, "sbx-1");
		await methods.list({});
		expect(seen.destroy).toBe("us-west-2");
		expect(seen.getById).toBe("us-west-2");
		expect(seen.list).toBe("us-west-2");
		// Each wrapped call restores the caller's set-but-empty env after it returns.
		expect(process.env.DAYTONA_TARGET).toBe("");
	});

	it("restores a pre-existing env value after destroy, beating a conflicting fallback", async () => {
		process.env.DAYTONA_TARGET = "decoy-region";
		const seen: Record<string, string | undefined> = {};
		const methods = patchedMethods(seen, "us-west-2");
		await methods.destroy({}, "sbx-1");
		// The pin beats the env decoy during the call, then leaves the caller's value untouched.
		expect(seen.destroy).toBe("us-west-2");
		expect(process.env.DAYTONA_TARGET).toBe("decoy-region");
	});

	it("deletes DAYTONA_TARGET after destroy when it was previously unset", async () => {
		delete process.env.DAYTONA_TARGET;
		const seen: Record<string, string | undefined> = {};
		const methods = patchedMethods(seen, "us-west-2");
		await methods.destroy({}, "sbx-1");
		expect(seen.destroy).toBe("us-west-2");
		// Deleted, not set to "" — a leaked empty string would flip the config gatekeeper's
		// set-but-empty handling for anything loaded after teardown.
		expect("DAYTONA_TARGET" in process.env).toBe(false);
	});

	it("leaves the env unpinned when the adapter has no configured target", async () => {
		process.env.DAYTONA_TARGET = "job-region";
		const seen: Record<string, string | undefined> = {};
		const methods = patchedMethods(seen, undefined);
		await methods.destroy({}, "sbx-1");
		// No target to pin: the stock method sees the caller's env fallback, unchanged.
		expect(seen.destroy).toBe("job-region");
		expect(process.env.DAYTONA_TARGET).toBe("job-region");
	});
});
