import { expect, test } from "bun:test";
import { githubExperimentStore, scanArtifactPages } from "./experiment-store.ts";

test("an upload outside the artifact runtime names the step that provides it", async () => {
	const store = githubExperimentStore({ GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "token" });
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
