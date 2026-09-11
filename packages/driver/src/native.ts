// Project native SDK handles into the shared session machinery without passing through
// ComputeSDK's error-erasing wrappers. The SDK's exact native type survives inference.
import type { DriverOperationOptions } from "@sandbox-benchmarks/driver";
import type { ComputeSdkSandboxLike } from "./computesdk.ts";
import { detachedShellCommand } from "./lib/shell.ts";

export function nativeSdkCompute<Options, Native>(
	create: (options: Options, operation: DriverOperationOptions) => Promise<Native>,
	project: (native: Native) => Omit<ComputeSdkSandboxLike<Native>, "getInstance">,
) {
	return {
		sandbox: {
			async create(options: Options, operation: DriverOperationOptions = {}) {
				operation.signal?.throwIfAborted();
				const native = await create(options, operation);
				const projected = project(native);
				return {
					...projected,
					getInstance: () => native,
					// Native projections execute synchronously; explicit commands.launch hooks own
					// vendor background APIs. Honor the wrapper convention through the shared shell.
					runCommand: (command: string, options?: Parameters<typeof projected.runCommand>[1]) =>
						projected.runCommand(options?.background ? detachedShellCommand(command) : command, {
							...options,
							background: false,
						}),
				};
			},
		},
	};
}
