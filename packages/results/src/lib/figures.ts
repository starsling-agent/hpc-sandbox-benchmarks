/**
 * The seam between the dataset and the figure package: which registries feed the figure
 * model, where the rendered files live, and the caption under each chart.
 *
 * `@sandbox-benchmarks/figures` takes the Run and the registries as ARGUMENTS (typed by the
 * schema, so there is nothing to cast and nothing to drift) — something still has to pass the
 * REAL ones and own the file naming. It is this module rather than the CLI bin because two
 * consumers need it: the bin, which renders and writes, and `tooling/repo-checks`, which
 * re-derives the published surface and diffs. A helper private to the bin would leave the
 * gate re-implementing it, and a gate that re-implements what it checks is checking its own
 * copy.
 */
import type { PipelineSuite, RealworldFigureModel } from "@sandbox-benchmarks/figures";
import {
	buildPipelineChartModel,
	buildRealworldFigureModel,
	FIGURE_WIDTH,
	pipelineChartHtml,
} from "@sandbox-benchmarks/figures";
import type { Run } from "@sandbox-benchmarks/schema";
import { METRIC_CATALOG, PROVIDERS, SUITES } from "@sandbox-benchmarks/schema";
import type { LeaderboardFigure } from "./leaderboard.ts";

/**
 * Where the rendered leaderboard figures are written, relative to the directory holding the
 * Markdown. A relative directory rather than a repo-absolute path: the CLI resolves it against
 * whatever `outFile` it was given, and the Markdown links it verbatim, so the two agree for a
 * render into a scratch directory exactly as they do for `LEADERBOARD.md` at the repo root.
 */
export const LEADERBOARD_FIGURE_DIR = "docs/figures";

/** The file one suite's chart is written to, and the path the Markdown links. */
export function suiteFigureFile(suiteId: string): string {
	return `${LEADERBOARD_FIGURE_DIR}/${suiteId}.webp`;
}

/**
 * Raster density of the committed charts: the WebP is this many device pixels per CSS px, and the
 * Markdown's `<img width>` shows it at logical size. One constant with two consumers — the CLI
 * rasterises at it, the artifact gate asserts the committed files against it — so the pixels and
 * the check cannot drift apart.
 */
export const FIGURE_DEVICE_SCALE = 2;

/**
 * The paragraph under a chart's title.
 *
 * It states the two things the picture cannot: that a bar is a SUM OF MEDIANS rather than a
 * measured single run, and how many trials each of those medians rests on. Both matter for
 * reading the chart honestly — the segments add up to the bar by construction (that is what a
 * stacked bar means), which is exactly why the total is not the median of any pipeline that ever
 * executed, and saying so is cheaper than letting a reader assume otherwise.
 *
 * `n` is read off the segments rather than from the suite registry's `defaultReplicas`: the
 * registry says what was REQUESTED, and a lost replicate shard makes the retained count smaller
 * without changing the request. A range is printed when the tasks disagree, because they can.
 *
 * `chartCount` is how many charts the run draws IN TOTAL — a property of the run, not of this
 * suite — because the caption's shared-scale sentence is a claim about the other charts, and a
 * hand-counted "all three" was wrong the day the run charted two.
 */
export function suiteFigureNote(suite: PipelineSuite, chartCount: number): string {
	const counts = suite.bars.flatMap((bar) => bar.segments.map((segment) => segment.n));
	const low = Math.min(...counts);
	const high = Math.max(...counts);
	const trials = low === high ? `${low}` : `${low}–${high}`;
	const plural = low === 1 && high === 1 ? "trial" : "trials";
	const scale = chartCount > 1 ? " All charts share one time scale." : "";
	// A declared task NO environment completed is dropped from every bar — which is exactly
	// why the caption must say so: without this sentence a universally-failed task simply
	// vanishes and the chart presents a failed suite as a completed comparison.
	const dropped =
		suite.droppedTasks.length === 0
			? ""
			: ` **${suite.droppedTasks.join("**, **")}** failed or was skipped in every ` +
				`environment and is excluded from all bars.`;
	return (
		`Each segment is that task's median over ${trials} retained ${plural}; the bar is their sum, ` +
		`so it is the cost of the pipeline and not the timing of any single run.${dropped}${scale}`
	);
}

/**
 * Derive the figure model from a Run: which suites are chartable, and with what in them.
 *
 * Pure and browser-free, so a caller that only needs the LIST — the Markdown renderer's argument,
 * and the artifact gate reproducing it — pays for nothing. The suite selection is entirely the
 * figure model's (it drops a suite nobody exercised, and one where fewer than two environments
 * completed every exercised task); this module adds only where the file goes. The registries go
 * in here, once, typed by the schema that owns them.
 */
export function benchmarkDataOf(run: Run): RealworldFigureModel {
	return buildRealworldFigureModel({
		run,
		metrics: METRIC_CATALOG,
		providers: PROVIDERS.map((provider) => ({
			id: provider.id,
			displayName: provider.displayName,
			isolationTechnology: provider.isolation.technology,
		})),
		suites: SUITES,
	});
}

/** The figures the Markdown links, in the order it links them. */
export function leaderboardFigures(data: RealworldFigureModel): LeaderboardFigure[] {
	return data.suites.map((suite) => ({
		suiteId: suite.id,
		suiteName: suite.name,
		file: suiteFigureFile(suite.id),
		width: FIGURE_WIDTH,
		charted: suite.bars.length,
		incomplete: suite.incomplete.length,
		tasks: suite.tasks.length,
	}));
}

/** One chart, ready to be rasterised — or compared, which is why the HTML travels with the
 *  figure the Markdown will link. */
export interface RenderedLeaderboardFigureHtml {
	/** What the Markdown links it as — the same value the renderer is handed. */
	readonly figure: LeaderboardFigure;
	/** The complete, self-contained chart document. Deterministic: same run, same code, same
	 *  string — the pixels Chrome makes of it are not, which is why gates hold onto THIS. */
	readonly html: string;
}

/**
 * Render every chartable suite in `run` to HTML.
 *
 * Pure and browser-free — rasterising the documents is the CLI's job
 * (`@sandbox-benchmarks/figures/screenshot`). One map over `data.suites` produces the figure
 * and its document TOGETHER, so the Markdown cannot link an image this function did not
 * produce — there is no second derivation to disagree with.
 */
export function renderLeaderboardFigureHtml(run: Run): RenderedLeaderboardFigureHtml[] {
	const data = benchmarkDataOf(run);
	const figures = leaderboardFigures(data);
	return data.suites.map((suite, index) => ({
		// Indexed, not looked up: both lists are the same map over `data.suites`.
		figure: figures[index] as LeaderboardFigure,
		html: pipelineChartHtml(
			buildPipelineChartModel(suite, data, suiteFigureNote(suite, data.suites.length)),
		),
	}));
}
