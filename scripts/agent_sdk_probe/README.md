# Optional Agent SDK development probe

This isolated probe evaluates `@librechat/agents@4.1.1` against the application's existing Python image adapter and Gallery queue. It is not a production dependency, service, engine replacement or full browser acceptance test.

Requirements: Node >=24, npm, and the repository's locked Python development environment (`uv sync --locked --extra dev`, from the repository root). The probe uses `.venv` when present. Set `AGENT_SDK_PROBE_PYTHON` to select another interpreter containing the locked application and test dependencies.

From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The local `.npmrc` explicitly selects public npm and disables lifecycle scripts. Keep `--ignore-scripts`: the SDK depends on an install-telemetry package. The runner also sets `DO_NOT_TRACK=1`, disables Reova and LangChain tracing, discards provider/tracing environment variables, and denies Node network requests before importing the SDK. Python provider HTTP is intercepted in process. External socket connections and production port 8000 are denied; Windows asyncio's loopback self-pipe remains allowed.

The three tests exercise:

- Synthetic image input, prompt optimization, SDK tool/result pairing and response aggregation, real application queue persistence, frozen configuration, same-call idempotency, unknown-outcome rejection and stopped-request rejection.
- SDK cancellation before image-tool dispatch.
- Non-mutating context projection with explicit unknown-window behavior.

All prompts, images, credentials and libraries are synthetic. The runner prints a new temporary output directory containing JSON receipts, a saved PNG and `result.html`; it neither loads an existing library nor writes generated results to this source directory. The bridge is a short-lived child process and opens no HTTP service. Temporary evidence is retained for inspection; it is not a distributable application backup.

The HTML viewer reads the real saved job result but is only a development display. Mock success does not validate real visual quality, provider latency/cache/billing, in-flight remote cancellation or SDK restart recovery. The current probe proves Hybrid custom-tool integration; Native/mask parity remains unverified. See [the source audit](../../docs/AGENT_ARCHITECTURE.md) for the fixed upstream revisions and engine decision.

The nested lockfile deliberately pins compatible OpenTelemetry/Langfuse versions because the initial unconstrained SDK installation failed during import. Keep dependency updates explicit and rerun this probe after changing the lock. Do not copy its dependencies into the application package or installer.
