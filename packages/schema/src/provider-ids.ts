/**
 * Canonical provider identity.
 *
 * This is intentionally a dependency-free leaf: code that only needs to name a provider must not
 * evaluate arktype, the provider registry, or the Run schema graph. Runtime parsing belongs in
 * `provider-parsers.ts`.
 */
export const PROVIDER_IDS = [
	"e2b",
	"daytona-vm",
	"daytona-container",
	"blaxel",
	"microsandbox-cloud",
	"modal-gvisor",
	"modal-vm",
	"novita",
	"runloop",
	"namespace",
	"vercel",
	"runcloud",
	"tama",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
