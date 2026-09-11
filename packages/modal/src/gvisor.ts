import { defineModalDriver } from "./shared.ts";

export default defineModalDriver("modal-gvisor");

export {
	createModalAllocation,
	type ModalAllocationConfiguration,
	type ModalAllocationOptions,
} from "./allocation.ts";
