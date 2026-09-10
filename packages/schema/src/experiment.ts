import { type } from "arktype";
import { gpuSpecSchema } from "./driver-schemas.ts";
import { providerIdSchema } from "./provider-parsers.ts";
import { targetSpecSchema } from "./target-spec-schema.ts";

const digest = type(/^sha256:[a-f0-9]{64}$/);
const identifier = type(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const phase = type("'create' | 'setup' | 'benchmark' | 'collect'");
export const executionReceiptSchema = type({
	schemaVersion: "'1'",
	executionId: identifier,
	runId: identifier,
	"replicateIndex?": "number.integer >= 0",
	provider: providerIdSchema,
	suite: "string >= 1",
	sandboxId: "string >= 1",
	steps: type({
		phase,
		label: "string",
		ms: "number >= 0",
		exitCode: "number.integer | null",
	}).array(),
	detached: type({
		identity: identifier,
		label: "string",
		phase,
		state:
			"'launch-pending' | 'launch-accepted' | 'running' | 'observation-unavailable' | 'completed' | 'deadline-exceeded' | 'collection-failed'",
		exitCode: "number.integer | null",
		"lastObservationMs?": "number >= 0",
		"logTail?": "string | null",
	}).array(),
	primaryFailure: "string | null",
}).onUndeclaredKey("reject");

export const cleanupReceiptSchema = type({
	schemaVersion: "'1'",
	executionId: identifier,
	completed: "boolean",
	attemptedAt: "string.date.iso",
	"completedAt?": "string.date.iso",
	"diagnostic?": "string",
	confirmedAbsent: "boolean",
}).onUndeclaredKey("reject");
export type ExecutionReceipt = typeof executionReceiptSchema.infer;
export type CleanupReceipt = typeof cleanupReceiptSchema.infer;

export const experimentExclusionSchema = type({
	metricId: "string >= 1",
	workloadRevision: "string >= 1",
	reason: "string >= 1",
	owner: "string >= 1",
	issue: /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/,
	expires: /^\d{4}-\d{2}-\d{2}$/,
}).onUndeclaredKey("reject");

export const experimentCellSchema = type({
	id: identifier,
	provider: providerIdSchema,
	quotaDomain: identifier,
	suite: "string >= 1",
	replicate: "number.integer >= 0",
	workloadRevision: "string >= 1",
	artifactIdentity: "string >= 1",
	environmentRevision: "string >= 1",
	target: targetSpecSchema,
	"gpu?": gpuSpecSchema,
	metrics: "string[] >= 1",
	exclusions: experimentExclusionSchema.array(),
	passes: "number.integer >= 1",
	startupMinutes: "number.safe > 0",
	workloadMinutes: "number.safe > 0",
	finishMinutes: "number.safe > 0",
}).onUndeclaredKey("reject");

export const experimentBatchSchema = type({
	id: identifier,
	quotaDomain: identifier,
	cells: "string[] >= 1",
	maxConcurrency: "number.integer >= 1",
	budgetMinutes: "number.safe > 0",
}).onUndeclaredKey("reject");

export const experimentPlanSchema = type({
	schemaVersion: "'1'",
	id: identifier,
	sha: /^[a-f0-9]{40}$/,
	createdOn: /^\d{4}-\d{2}-\d{2}$/,
	digest,
	retryPolicy: "'premeasurement-only'",
	maxPremeasurementRetries: "number.integer >= 0",
	accounts: type({
		quotaDomain: identifier,
		sandboxes: "number.integer >= 1",
		"vcpus?": "number.safe > 0",
		"memoryGb?": "number.safe > 0",
		"gpus?": "number.integer >= 0",
	})
		.onUndeclaredKey("reject")
		.array()
		.atLeastLength(1),
	cells: experimentCellSchema.array().atLeastLength(1),
	batches: experimentBatchSchema.array().atLeastLength(1),
	rounds: type({ id: identifier, quotaDomain: identifier, batches: "string[] >= 1" })
		.onUndeclaredKey("reject")
		.array()
		.atLeastLength(1),
}).onUndeclaredKey("reject");

/** Evidence is a receipt, not a second metric store. runDigest binds its observations to one shard. */
export const experimentAttemptSchema = type({
	schemaVersion: "'1'",
	id: identifier,
	cellId: identifier,
	planDigest: digest,
	sha: /^[a-f0-9]{40}$/,
	workloadRevision: "string >= 1",
	environmentRevision: "string >= 1",
	artifactIdentity: "string >= 1",
	passes: "number.integer >= 1",
	workflowRun: identifier,
	workflowAttempt: "number.integer >= 1",
	job: "string >= 1",
	sequence: "number.integer >= 0",
	"previousAttempt?": identifier,
	outcome: "'completed' | 'failed' | 'cancelled'",
	measurementStarted: "boolean",
	retryable: "boolean",
	cleanup: "'confirmed' | 'unresolved' | 'not-allocated'",
	completion: "'known-success' | 'known-failure' | 'unknown'",
	"runDigest?": digest,
	"rawDigest?": digest,
	"diagnostic?": "string <= 16384",
}).onUndeclaredKey("reject");

export type ExperimentPlan = typeof experimentPlanSchema.infer;
export type ExperimentCell = typeof experimentCellSchema.infer;
export type ExperimentAttempt = typeof experimentAttemptSchema.infer;
export type ExperimentBatch = typeof experimentBatchSchema.infer;

export const experimentRequestSchema = type({
	id: "string >= 1",
	sha: "string >= 1",
	createdOn: "string >= 1",
	cells: experimentCellSchema.array(),
	"maxPremeasurementRetries?": "number.integer >= 0",
}).onUndeclaredKey("reject");
export const accountCapacityPolicySchema = type({
	"[string]": {
		sandboxes: "number.integer >= 1",
		"vcpus?": "number.safe > 0",
		"memoryGb?": "number.safe > 0",
		"gpus?": "number.integer >= 0",
	},
});
