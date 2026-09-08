import { defineModalDriver } from "./_modal.ts";

export default defineModalDriver("modal-gvisor");

export {
	createModalAllocation,
	type ModalAllocationConfiguration,
	type ModalAllocationOptions,
} from "./_modal-allocation.ts";
