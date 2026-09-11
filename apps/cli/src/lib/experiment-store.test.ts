import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubExperimentStore, scanArtifactPages } from "./experiment-store.ts";

const root = mkdtempSync(join(tmpdir(), "plan-lookup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("an upload outside the artifact runtime names the step that provides it", async () => {
	const store = githubExperimentStore("1", { GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "token" });
	await expect(store.upload("experiment-plan-1", ".")).rejects.toThrow(
		"run .github/actions/artifact-runtime before this step",
	);
});

const artifact = (id: number) => ({
	id,
	name: `artifact-${id}`,
	expired: false,
	workflow_run: { id: 1 },
});

test("unrelated workflow uploads cannot invalidate a frozen-plan inventory", async () => {
	const requests: string[] = [];
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				requests.push(url);
				if (url.includes("/actions/runs/123/artifacts"))
					return Response.json({
						total_count: 1,
						artifacts: [{ ...artifact(1), name: "experiment-plan-123", workflow_run: { id: 123 } }],
					});
				const page = Number(new URL(url).searchParams.get("page"));
				return Response.json({ total_count: page + 1, artifacts: [artifact(page)] });
			},
			{ preconnect: fetch.preconnect },
		),
	);
	try {
		const store = githubExperimentStore("123", {
			// Backfill executes in a different run; artifact reads must use the explicit source id.
			GITHUB_REPOSITORY: "owner/repo",
			GH_TOKEN: "token",
			GITHUB_RUN_ID: "999",
		});
		expect((await store.list({ name: "experiment-plan-123" })).map((item) => item.id)).toEqual([1]);
		expect(requests).toHaveLength(1);
	} finally {
		fetchMock.mockRestore();
	}
});

test("artifact run identity rejects malformed paths before making requests", () => {
	for (const id of ["", "0", "../artifacts", "123?page=2"])
		expect(() =>
			githubExperimentStore(id, { GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "token" }),
		).toThrow();
});
test("artifact scans require complete stable pagination", async () => {
	expect(
		(
			await scanArtifactPages(async (page) => ({ total_count: 2, artifacts: [artifact(page)] }))
		).map((entry) => entry.id),
	).toEqual([1, 2]);
	await expect(
		scanArtifactPages(async (page) => ({ total_count: page + 1, artifacts: [artifact(page)] })),
	).rejects.toThrow("changed");
	await expect(
		scanArtifactPages(async () => ({ total_count: 2, artifacts: [artifact(1)] })),
	).rejects.toThrow("repeated");
	await expect(scanArtifactPages(async () => ({ total_count: 1, artifacts: [] }))).rejects.toThrow(
		"incomplete",
	);
});

test("same-run attempt uploads do not disturb exact frozen-plan lookup", async () => {
	const requests: string[] = [];
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = new URL(String(input));
				requests.push(url.toString());
				if (url.searchParams.get("name") === "experiment-plan-123")
					return Response.json({
						total_count: 1,
						artifacts: [{ ...artifact(1), name: "experiment-plan-123", workflow_run: { id: 123 } }],
					});
				const page = Number(url.searchParams.get("page"));
				return Response.json({ total_count: 101 + page, artifacts: [artifact(page)] });
			},
			{ preconnect: fetch.preconnect },
		),
	);
	try {
		const store = githubExperimentStore("123", {
			GITHUB_REPOSITORY: "owner/repo",
			GH_TOKEN: "token",
		});
		// Exercise the real transfer caller, which must ask for an exact name.
		const { downloadExperimentPlan } = await import("./experiment-transfer.ts");
		await expect(
			downloadExperimentPlan(
				{
					...store,
					download: async () => {
						throw new Error("plan selected");
					},
				},
				"123",
				root,
			),
		).rejects.toThrow("plan selected");
		expect(requests).toHaveLength(1);
	} finally {
		fetchMock.mockRestore();
	}
});
