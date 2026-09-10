import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const transpiler = new Bun.Transpiler({ loader: "ts" });

function localRuntimeDependency(importer: string, specifier: string): string | undefined {
	if (specifier.startsWith(".")) return resolve(dirname(importer), specifier);
	if (specifier.startsWith("node:")) return undefined;
	throw new Error(`${importer} pulls package ${specifier} into the driver root runtime graph`);
}

async function rootRuntimeGraph(): Promise<Set<string>> {
	const pending = [resolve(SRC, "index.ts")];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		const source = await Bun.file(file).text();
		for (const imported of transpiler.scanImports(source)) {
			const local = localRuntimeDependency(file, imported.path);
			if (local !== undefined) pending.push(local);
		}
	}
	return visited;
}

describe("driver package boundaries", () => {
	test("the complete root runtime graph stays arktype-free", async () => {
		const graph = await rootRuntimeGraph();
		expect([...graph].map((file) => file.slice(SRC.length + 1)).sort()).toEqual([
			"index.ts",
			"lib/accelerator.ts",
			"lib/define.ts",
			"lib/diagnostics.ts",
			"lib/errors.ts",
			"lib/output.ts",
			"lib/policy.ts",
			"lib/poll.ts",
			"lib/port.ts",
			"lib/session.ts",
			"lib/shell.ts",
			"lib/table.ts",
		]);
	});

	test("package subpaths cannot bypass the root-runtime fence", () => {
		for (const specifier of [
			"arktype",
			"arktype/internal",
			"@sandbox-benchmarks/schema",
			"@sandbox-benchmarks/schema/driver-schemas",
			"some-transitive-wrapper",
		]) {
			expect(() => localRuntimeDependency("index.ts", specifier)).toThrow(
				/into the driver root runtime graph/,
			);
		}
		expect(localRuntimeDependency("index.ts", "node:path")).toBeUndefined();
	});
});
