---
status: accepted
---

# Separate harness operations with provider-specific GPU allocation

Complete the driver migration specified by ADR-0007 using separate suite execution, lifecycle
measurement, and managed custom-work operations with declarative inputs. Each operation owns its
execution and cleanup sequence; all use the driver-session seam. This concentrates lifecycle
ownership without requiring callers to assemble it or introducing a generic workflow language.
Lifecycle measurement retains its existing create-to-first-success semantics, distinct from
operational readiness. The published measurement contract remains unchanged during migration.

GPU allocation configuration belongs to the selected provider's fleet implementation. Prefer
exported Modal SDK types for Modal image references, volumes, and allocation fields instead of
copying vendor shapes. Keep canonical request values single-authored and keep Modal types out of
the common driver and harness interfaces. Future GPU runners reuse the session seam with their
own typed allocation configuration. This preserves provider-specific resource and artifact
semantics without an arbitrary vendor-options bag on every request.

Modal GPU allocation uses the stable V1 gVisor service. The CPU gVisor DriverModule uses V2;
prepared GPU resources resolve through a separate typed allocation factory for the same provider.
[Modal VM sandboxes](https://modal.com/docs/guide/vm-sandboxes) and
[Sandbox V2](https://modal.com/docs/guide/sandbox-v2) do not support GPUs. Built or restored SDK
image IDs remain the session artifact identity, and mounted volumes retain SDK mount options.

CLI composition owns environment and artifact resolution; harness owns workload execution,
measurement, and evidence persistence; drivers own provider behavior. Migrate all existing
providers and callers before removing the legacy package and exports. ComputeSDK may remain
one fleet-private adapter, as ADR-0007 permits. Migration does not by itself establish live
conformance or publication eligibility under ADR-0008.

Deliver the migration as focused, stacked provider PRs. Each provider path must be live-validated
before its PR is opened; missing credentials or infrastructure block that submission. Intermediate
commits preserve the existing paths for unmigrated providers, and the final migration removes
legacy compatibility. This keeps each change reviewable without declaring the whole fleet migrated
or validated on the strength of one provider's result.
