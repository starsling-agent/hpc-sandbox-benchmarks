// The dataset↔figures seam: the real registries feeding the figure model, the figure list the
// Markdown links, and the caption under each chart — tested against synthetic Runs so the rules
// hold regardless of what the committed dataset contains.
import { describe, expect, it } from "bun:test";
import type { PipelineSuite } from "@sandbox-benchmarks/figures";
import type { MetricResult, ProviderRun, Run } from "@sandbox-benchmarks/schema";
import { aggregate, SUITES } from "@sandbox-benchmarks/schema";
import {
	benchmarkDataOf,
	LEADERBOARD_FIGURE_DIR,
	leaderboardFigures,
	renderLeaderboardFigureHtml,
	suiteFigureFile,
	suiteFigureNote,
} from "./figures.ts";

/** The suite's canonical task order, widened off the `as const` tuple so the fixtures below can
 *  take the first one or two without restating their ids. */
const MASTRA: readonly string[] = SUITES["realworld-mastra"].metrics;
const [CLONE, INSTALL] = MASTRA as [string, string];

function metric(metricId: string, samples: number[]): MetricResult {
	return { metricId, samples, aggregates: aggregate(samples) };
}

function provider(
	providerId: string,
	metrics: MetricResult[],
	over: Partial<ProviderRun> = {},
): ProviderRun {
	return {
		providerId,
		validationStatus: "validated",
		observedSpecs: {},
		metrics,
		suitesCovered: ["realworld-mastra"],
		gaps: [],
		uncatalogued: [],
		...over,
	};
}

function run(providers: ProviderRun[]): Run {
	return {
		schemaVersion: "2",
		runId: "run-1",
		sha: "abc123",
		generatedAt: "2026-06-20T00:00:00.000Z",
		targetSpec: { vcpus: 2, memoryGb: 8, diskGb: 20 },
		providers,
	};
}

/** Two environments that both completed the same two tasks — the minimum a suite needs to chart. */
function chartableRun(): Run {
	return run([
		provider("daytona-vm", [metric(CLONE, [1, 2]), metric(INSTALL, [30, 32])]),
		provider("modal-vm", [metric(CLONE, [3, 4]), metric(INSTALL, [50, 52])]),
	]);
}

describe("suiteFigureFile", () => {
	it("names the file after the suite, under the figure directory", () => {
		expect(suiteFigureFile("realworld-mastra")).toBe(
			`${LEADERBOARD_FIGURE_DIR}/realworld-mastra.webp`,
		);
	});
});

describe("leaderboardFigures", () => {
	it("lists one figure per chartable suite, with its own counts", () => {
		const figures = leaderboardFigures(benchmarkDataOf(chartableRun()));
		expect(figures).toEqual([
			{
				suiteId: "realworld-mastra",
				suiteName: "Mastra",
				file: `${LEADERBOARD_FIGURE_DIR}/realworld-mastra.webp`,
				width: 960,
				charted: 2,
				incomplete: 0,
				tasks: 2,
			},
		]);
	});

	it("lists nothing when only one environment completed the suite", () => {
		// The ingest's rule, restated here because the Markdown depends on it: a chart of one bar is
		// not a comparison, and the document must then keep its tables in the open.
		const figures = leaderboardFigures(
			benchmarkDataOf(run([provider("daytona-vm", [metric(CLONE, [1, 2])])])),
		);
		expect(figures).toEqual([]);
	});

	it("does not chart an environment that ran only part of the pipeline", () => {
		// The understated-total failure: summing the tasks a provider DID run and drawing it beside
		// providers that ran them all would show a fast bar for an environment that skipped the work.
		const figures = leaderboardFigures(
			benchmarkDataOf(
				run([
					provider("daytona-vm", [metric(CLONE, [1, 2]), metric(INSTALL, [30, 32])]),
					provider("modal-vm", [metric(CLONE, [3, 4]), metric(INSTALL, [50, 52])]),
					provider("e2b", [metric(CLONE, [1, 1])]),
				]),
			),
		);
		expect(figures[0]?.charted).toBe(2);
		expect(figures[0]?.incomplete).toBe(1);
	});
});

describe("renderLeaderboardFigureHtml", () => {
	it("passes declared and aggregated detected isolation into figure labels", () => {
		const withRuntime = (providerId: string, runtime: string) =>
			provider(providerId, [metric(CLONE, [1, 2]), metric(INSTALL, [30, 32])], {
				hostMetadata: [
					{
						source: "mise/system-provider",
						sourceFile: "system/system-provider.json",
						fields: [{ path: "isolation_runtime", value: runtime }],
					},
				],
			});
		const data = benchmarkDataOf(
			run([
				withRuntime("namespace", "firecracker"),
				withRuntime("daytona-vm", "firecracker"),
				withRuntime("modal-gvisor", "gvisor"),
				withRuntime("microsandbox-cloud", "libkrun"),
			]),
		);
		expect(data.providers).toEqual([
			{
				id: "namespace",
				name: "Namespace",
				specMatched: true,
				isolation: { kind: "microVM", technology: "Firecracker" },
			},
			{
				id: "daytona-vm",
				name: "Daytona",
				specMatched: true,
				isolation: { kind: "microVM", technology: "Firecracker" },
			},
			{
				id: "modal-gvisor",
				name: "Modal",
				specMatched: true,
				isolation: { kind: "Userspace", technology: "gVisor" },
			},
			{
				id: "microsandbox-cloud",
				name: "microsandbox",
				specMatched: true,
				isolation: { kind: "microVM", technology: "libkrun" },
			},
		]);
	});

	it("returns one self-contained document per chartable suite, paired with its figure", () => {
		const rendered = renderLeaderboardFigureHtml(chartableRun());
		expect(rendered.map(({ figure }) => figure.suiteId)).toEqual(["realworld-mastra"]);
		const html = rendered[0]?.html as string;
		// The document must carry everything the screenshot needs: the chart, the caption, the
		// faces. A reference to anything outside the string would make the WebP depend on the
		// machine that rendered it.
		expect(html).toContain("<title>Mastra</title>");
		expect(html).toContain("retained trials");
		expect(html).toContain("data:font/woff2;base64,");
	});

	it("is deterministic — same run, same strings", () => {
		// The browser's pixels are not byte-stable across machines; the HTML must be, everywhere,
		// or a figure regeneration reviews as unexplainable churn.
		const [first, second] = [
			renderLeaderboardFigureHtml(chartableRun()),
			renderLeaderboardFigureHtml(chartableRun()),
		];
		expect(first.map(({ html }) => html)).toEqual(second.map(({ html }) => html));
	});
});

describe("suiteFigureNote", () => {
	const suite = (counts: number[][]): PipelineSuite => ({
		id: "realworld-mastra",
		name: "Mastra",
		minDiskGb: 30,
		tasks: [],
		droppedTasks: [],
		bars: counts.map((row, index) => ({
			provider: `p${index}`,
			totalS: 1,
			segments: row.map((n) => ({ id: "t", phase: "clone" as const, p50: 1, n })),
		})),
		incomplete: [],
	});

	it("discloses declared tasks no environment completed, named in bold", () => {
		const rows: number[][] = [
			[12, 12],
			[12, 12],
		];
		const withDropped = { ...suite(rows), droppedTasks: ["test core"] };
		expect(suiteFigureNote(withDropped, 3)).toContain(
			"**test core** failed or was skipped in every environment and is excluded from all bars.",
		);
		expect(suiteFigureNote(suite(rows), 3)).not.toContain("excluded from all bars");
	});

	it("prints one trial count when every task agrees", () => {
		expect(
			suiteFigureNote(
				suite([
					[12, 12],
					[12, 12],
				]),
				3,
			),
		).toContain("median over 12 retained trials");
	});

	it("prints a range when they do not, rather than one task's count as if it were the suite's", () => {
		// A lost replicate shard lowers the RETAINED count for one task only. Printing "12" there
		// would be the note claiming evidence the run does not have.
		expect(
			suiteFigureNote(
				suite([
					[12, 9],
					[12, 12],
				]),
				3,
			),
		).toContain("median over 9–12 retained trials");
	});

	it("says the bar is a sum of medians, not a measured run", () => {
		// The one thing a stacked bar cannot say for itself, and the thing a reader would otherwise
		// assume: the total is arithmetic over per-task medians, so no single pipeline ever took it.
		const note = suiteFigureNote(
			suite([
				[12, 12],
				[12, 12],
			]),
			3,
		);
		expect(note).toContain("the bar is their sum");
		expect(note).toContain("not the timing of any single run");
	});

	it("claims a shared time scale only when there is more than one chart to share it", () => {
		// The count is the RUN's, not the suite's — "all three charts" hand-counted in prose was
		// wrong the day a suite dropped to one completing environment.
		const rows: number[][] = [
			[12, 12],
			[12, 12],
		];
		expect(suiteFigureNote(suite(rows), 3)).toContain("All charts share one time scale.");
		expect(suiteFigureNote(suite(rows), 1)).not.toContain("share one time scale");
	});
});
