import { shellQuote } from "@sandbox-benchmarks/driver";

export function detachedCommand(identity: string, command: string): string {
	if (!/^bench-[a-f0-9-]+$/.test(identity)) throw new Error("invalid detached command identity");
	const directory = `/tmp/${identity}`;
	const done = `${directory}/completion.done`;
	return (
		`umask 077; mkdir ${directory} || exit 1; ` +
		`bash -c ${shellQuote(command)} > ${directory}/output.log 2>&1 ` +
		`&& code=0 || code=$?; printf 'v1 ${identity} %s\\n' "$code" > ${done}.tmp && mv ${done}.tmp ${done}`
	);
}

/** A versioned receipt binds completion to the exact detached command, not just a filename. */
export function completionCode(raw: string, identity: string): number | null {
	const match = /^v1 ([a-zA-Z0-9-]+) (0|[1-9][0-9]*)\n?$/.exec(raw);
	if (!match || match[1] !== identity) return null;
	const code = Number(match[2]);
	return Number.isInteger(code) && code <= 255 ? code : null;
}
