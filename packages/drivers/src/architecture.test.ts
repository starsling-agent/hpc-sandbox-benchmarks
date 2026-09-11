import { expect, test } from "bun:test";

test("the fleet contains only a loader and no direct vendor dependencies", async () => {
	const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: import.meta.dir })];
	expect(files.filter((file) => !file.endsWith(".test.ts"))).toEqual(["index.ts"]);
	const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
	expect(
		Object.keys(manifest.dependencies).every((name) => name.startsWith("@sandbox-benchmarks/")),
	).toBe(true);
});
