#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import type { CoverageReport } from "@sandbox-benchmarks/results";
import { renderCoverageSummary } from "../lib/coverage-summary.ts";

if (import.meta.main) {
	const [file] = process.argv.slice(2);
	if (!file) throw new Error("usage: summarize-coverage <coverage.json>");
	process.stdout.write(
		renderCoverageSummary(JSON.parse(readFileSync(file, "utf8")) as CoverageReport),
	);
}
