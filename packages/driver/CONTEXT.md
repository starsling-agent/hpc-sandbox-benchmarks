# Sandbox drivers

This context describes the sandbox behavior that benchmark execution can request and observe.

## Language

**Sandbox session**:
An allocated sandbox with provider-qualified identity and available execution and lifecycle
capabilities. A session identifies a particular allocation, not a provider as a whole.

**Driver**:
An implementation of sandbox creation and behavior for a provider integration. Its exposed
capabilities describe that integration, not every capability offered by the vendor.

**Durable execution**:
Command execution that can outlive its launch interaction and whose completion is observed
separately. Launch acceptance is not command completion or success.
