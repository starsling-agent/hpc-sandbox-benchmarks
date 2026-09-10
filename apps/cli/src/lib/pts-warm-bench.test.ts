import { describe, expect, it } from "bun:test";
import { discardInstallTree, installPayloadProblem } from "./pts-warm-bench.ts";

// Both helpers interpolate the target into a bash line that reaches `rm -rf` or a path probe under
// `pts_install_root`, so the name guard runs BEFORE anything is spawned. These cases therefore need
// no PTS on PATH: a reachable spawn would already be the bug.
describe("install-target name guard", () => {
	const traversals = ["pts/../../etc", "local/.ssh", "pts/a b", 'pts/x";rm -rf /;"'];

	it("refuses to discard a target that is not two plain path segments", async () => {
		for (const target of traversals) {
			await expect(discardInstallTree("/repo", target)).rejects.toThrow(/refusing to discard/);
		}
	});

	it("refuses to probe a target that is not two plain path segments", async () => {
		for (const target of traversals) {
			await expect(installPayloadProblem("/repo", target)).rejects.toThrow(/refusing to probe/);
		}
	});

	it("ignores a target with no namespace rather than treating the whole string as a path", async () => {
		// PTS only ever reports `<ns>/<name>`; a bare word is not an install tree to touch.
		expect(await discardInstallTree("/repo", "stream-1.3.4")).toBeUndefined();
		expect(await installPayloadProblem("/repo", "stream-1.3.4")).toBeUndefined();
	});
});
