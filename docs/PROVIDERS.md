# Provider dispatch and compatibility

The provider layer separates protocol choice from the application's durable
image tasks. It does not introduce another queue, database or automatic retry.

## Registered capabilities

`backend/services/providers/registry.py` explicitly declares each executor and
its optional image, text, catalog and parameter-mapping capabilities. Only entries
with an executor participate in automated queue dispatch. Model names do not select
a protocol. An unknown explicit protocol fails before a provider request.

The OpenAI-compatible profile remains the default when a legacy profile has no
`protocol` field. Its public module, class identities, settings storage, frozen
configuration digests and existing job provider ID are retained. The small adapter
uses that stable implementation instead of copying it or replacing public imports.
The common request mapper and job lifecycle are extracted into `providers/`.

ChatGPT/Codex OAuth, Grok OAuth and Agent Native batch entries retain their original
executors. Registering those paths does not turn them into API-key image adapters.

## One execution path

Gallery still submits to the existing generation queue. Agent Hybrid, confirmed
recipe execution and image-only retries resolve their image implementation through
the same registry using the already-verified profile. Recipe byte verification,
reference ordering, authorization and pre-dispatch guards remain at their existing
boundaries. Native Responses is not silently converted to an Images request.

The API-key runner preserves the existing sequence: claim a queued task, validate
its frozen inputs, issue one generation request, preserve the final bytes and local
recovery evidence, register the result, then write optional completion observations.
Pending local results are not ordinary provider failures or permission to regenerate.
See [Local result recovery](LOCAL_RESULT_RECOVERY.md).

`TextProvider.complete` exposes a response context manager. It does not collapse a
stream into plain text: the existing Responses parser still validates tool outputs,
reasoning items, JSON/SSE terminal receipts and disconnect behavior. There is no
extra planning request, endpoint fallback or retry in the text adapter.

## Parameters and catalogs

`CanonicalImageRequest` preserves input intent and copies parameters before mapping.
The OpenAI mapper retains existing omission/default behavior, original whitespace,
compression zero, ratio-hint handling and JSON/multipart transport. Unknown legacy
metadata is preserved locally, not blindly forwarded to the provider.

The catalog interface delegates to the existing bounded discovery implementation.
The disposable cache writes version 2 and reads version 1 without rewriting it on
read. Its public `image_generation` field remains tri-state; a model name or image
input support alone does not prove image output capability. Discovery never changes
the selected model or triggers an image request.

## Validation boundaries

Registry contracts and actual MockTransport wire tests cover JSON, ordered multipart,
stream-request/JSON-response compatibility, compression zero, authorization headers,
legacy profiles, read-only v1 cache compatibility and Responses terminal teardown.
The existing recovery, Hybrid, direct recipe, retry and Native regression suites
remain authoritative. Simulated transports do not verify real provider permissions,
latency, billing or image quality. No production credentials are needed for tests.
