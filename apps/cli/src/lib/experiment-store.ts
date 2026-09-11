import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import { type } from "arktype";

const artifactPage = type({
	total_count: "number.integer >= 0",
	artifacts: type({
		id: "number.integer > 0",
		name: "string",
		expired: "boolean",
		workflow_run: { id: "number.integer > 0" },
	}).array(),
});
const workflowRunId = type(/^[1-9][0-9]*$/);
export type StoredArtifact = (typeof artifactPage.infer.artifacts)[number];
export interface ExperimentStore {
	list(query: { name: string } | { prefix: string }): Promise<readonly StoredArtifact[]>;
	upload(name: string, directory: string): Promise<void>;
	download(artifact: StoredArtifact, directory: string): Promise<void>;
}

/** Require a complete inventory within the selected workflow run. */
export async function scanArtifactPages(
	read: (page: number) => Promise<unknown>,
): Promise<StoredArtifact[]> {
	const artifacts: StoredArtifact[] = [];
	const ids = new Set<number>();
	let total: number | undefined;
	for (let page = 1; page <= 100; page++) {
		const response = artifactPage.assert(await read(page));
		total ??= response.total_count;
		if (response.total_count !== total)
			throw new Error("artifact inventory changed during scan; retry admission");
		for (const artifact of response.artifacts) {
			if (ids.has(artifact.id))
				throw new Error("artifact inventory pagination repeated an identity");
			ids.add(artifact.id);
			artifacts.push(artifact);
		}
		if (artifacts.length === total) return artifacts;
		if (artifacts.length > total || response.artifacts.length === 0)
			throw new Error("artifact inventory is incomplete");
	}
	throw new Error("artifact history exceeds supported scan; archival reconciliation is required");
}

export function githubExperimentStore(
	runId: string,
	env: NodeJS.ProcessEnv = process.env,
): ExperimentStore {
	const run = workflowRunId.assert(runId);
	const repository = env.GITHUB_REPOSITORY;
	const token = env.GH_TOKEN || env.GITHUB_TOKEN;
	if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
		throw new Error("GitHub artifact access requires repository and token");
	const [repositoryOwner, repositoryName] = repository.split("/");
	if (!repositoryOwner || !repositoryName) throw new Error("invalid repository identity");
	const client = new DefaultArtifactClient();
	return {
		async list(query) {
			const entries = await scanArtifactPages(async (page) => {
				const response = await fetch(
					`https://api.github.com/repos/${repository}/actions/runs/${run}/artifacts?per_page=100&page=${page}${"name" in query ? `&name=${encodeURIComponent(query.name)}` : ""}`,
					{
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2022-11-28",
						},
						signal: AbortSignal.timeout(20_000),
					},
				);
				if (!response.ok) throw new Error(`artifact inventory HTTP ${response.status}`);
				return response.json();
			});
			const selected = entries.filter((entry) =>
				"name" in query ? entry.name === query.name : entry.name.startsWith(query.prefix),
			);
			if (selected.some((entry) => entry.expired))
				throw new Error(
					"required artifact history expired; vendor-confirmed recovery or retained archive is required",
				);
			if (new Set(selected.map((entry) => entry.name)).size !== selected.length)
				throw new Error("conflicting immutable artifact names");
			return selected.toSorted((a, b) => a.name.localeCompare(b.name));
		},
		async upload(name, directory) {
			// @actions/artifact uploads through the run-scoped artifact runtime, which GitHub injects
			// only into action steps; a `run:` step gets it from .github/actions/artifact-runtime. Fail
			// before walking the tree so the message names the fix, not the library's bare env lookup.
			if (!env.ACTIONS_RUNTIME_TOKEN || !env.ACTIONS_RESULTS_URL)
				throw new Error(
					"artifact upload requires the Actions artifact runtime (ACTIONS_RUNTIME_TOKEN and ACTIONS_RESULTS_URL); run .github/actions/artifact-runtime before this step",
				);
			const files: string[] = [];
			const visit = (path: string) => {
				for (const entry of readdirSync(path, { withFileTypes: true })) {
					const child = join(path, entry.name);
					if (entry.isSymbolicLink()) throw new Error("artifact contains a symbolic link");
					if (entry.isDirectory()) visit(child);
					else if (entry.isFile()) files.push(child);
					else throw new Error("artifact contains a non-regular file");
				}
			};
			if (lstatSync(directory).isSymbolicLink())
				throw new Error("artifact root is a symbolic link");
			visit(directory);
			const result = await client.uploadArtifact(name, files, resolve(directory));
			if (!result.id) throw new Error("artifact upload was not acknowledged");
		},
		async download(artifact, directory) {
			mkdirSync(directory, { recursive: true });
			await client.downloadArtifact(artifact.id, {
				path: resolve(directory),
				findBy: { token, repositoryOwner, repositoryName, workflowRunId: artifact.workflow_run.id },
			});
		},
	};
}
