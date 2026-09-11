// Project native SDK handles into the shared session machinery without passing through
// ComputeSDK's error-erasing wrappers. The SDK's exact native type survives inference.
import type { DriverOperationOptions } from "@sandbox-benchmarks/driver";
import type { ComputeSdkSandboxLike } from "./computesdk.ts";

export function nativeSdkCompute<Options, Native>(
	create: (options: Options, operation: DriverOperationOptions) => Promise<Native>,
	project: (native: Native) => Omit<ComputeSdkSandboxLike<Native>, "getInstance">,
) {
	return {
		sandbox: {
			async create(options: Options, operation: DriverOperationOptions = {}) {
				operation.signal?.throwIfAborted();
				const native = await create(options, operation);
				return { ...project(native), getInstance: () => native };
			},
		},
	};
}
