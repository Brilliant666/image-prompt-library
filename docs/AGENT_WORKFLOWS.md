# Agent image creation and prompt workflows

The Agent is an API-based assistant for visual analysis, prompt writing, reverse prompting, refinement and explicitly authorized image creation. It uses the existing conversation, branch, Gallery job and Library asset systems. It does not provide filesystem, terminal or browser automation tools.

## Using the workflows

In **Settings → Agent**, **Enable professional image-prompt workflows** is on by default, including when opening an older configuration. Both bundled skills share this switch. Saving it does not call a model or change the chosen API profiles, models or image parameters.

| Request | Expected workflow |
| --- | --- |
| Ordinary conversation | Text response; no automatic skill body or image request |
| Attach an image and ask about its light or composition | Normal visual analysis, distinguishing observation from inference |
| “使用图片反推工作流，给我简短中文提示词” | Reverse guidance applied to the supplied image pixels; a derived prompt, not a claim to know the original prompt |
| “使用 GPT Image Skill 优化，给我更短的英文版本” | Prompt refinement with the original intent and constraints retained |
| “只改光线，保留主体、服装和画幅” | A local edit, with the original text retained in conversation history |
| “先反推图片，再优化成英文 Prompt” | Relevant sections from both skills, without loading every chapter |
| Request generation with image permission enabled | Existing Native or Hybrid tools and Gallery task receipts |

Uploading an image or enabling image permission alone does not request generation. When the switch is off, ordinary chat, visual input and authorized generation remain available, but automatic skill loading and `read_agent_skill` are disabled. The local selector is conservative, not an extra paid classifier; unusual phrasing can still require a model-driven finite section read. See [skill sources, chapters and adaptation](agent-skills/README.md).

Reusable prompts are separate Markdown blocks with a **Copy text** button. Copying preserves their displayed whitespace without copying the explanation. Original user input remains available in history. Neither reverse prompting nor refinement automatically overwrites a Library item or creates an empty image entry.

Native uses the Responses image tool. Hybrid uses the chosen text Responses profile and the existing Images API queue. Current API continues to follow the workspace profile. The selected configuration is frozen for each request. Generated results retain their conversation, round, execution prompt, references, model and Gallery job; Gallery and Library selections can be brought back into the same workspace for further editing.

## Correctness and recovery boundaries

### Continue an image edit

The current editing task records a stable target image, auxiliary references and their roles, the user's requirements and confirmed constraints. Open the task panel to inspect or correct these choices, or end the task without deleting the conversation. Each conversation branch keeps its own task. A single newly attached image with an editing request becomes the target; an earlier lighting reference remains auxiliary. Ambiguous multiple-image edits require an explicit target, and unavailable references cannot silently substitute another image. Task roles supplement the required visual history rather than removing it.

When changing the image API profile, the image-model field adopts that profile's saved default. A full manual model ID remains possible. This does not change the text profile, another profile's settings or an already submitted request.

### Retry a failed image

**Retry with current image configuration** reuses the failed image job's actual execution prompt and frozen reference pixels, preserving its parameters unless explicitly changed in the confirmation panel. After confirmation it creates a new linked Gallery job through the existing Images queue, with no additional text-model planning request. The original failure remains in history. A repeated submission identity returns the same receipt; an uncertain response requires checking that receipt instead of sending again. Quota, moderation and rate-limit failures never automatically retry or change suppliers.

Direct retry is available only for confirmed failed Hybrid Images jobs while the current mode is Hybrid. Native Responses and Current API do not silently convert protocols. Use **Edit prompt and regenerate** to restore the actual prompt and available references to the composer, review them and explicitly send through the selected mode. Missing originals block restoration rather than substituting another image.

### Results and progress

Each round reports its own durable image jobs. A completed text-model tool call is not an image-generation success. All failed jobs show that no image was produced; mixed batches retain and identify their successful images. Details distinguish submitted jobs, successful images, failures and the authorized maximum. Saved Library images remain part of the successful count.

Progress distinguishes local preparation, waiting for the text model, receiving output, waiting for image tasks, generating and saving results. Safe diagnostic categories identify quota, model/interface compatibility, moderation, rate limits, service failures, uncertain connections and unavailable references. Unknown provider errors are not classified by guessing from prose. No category automatically retries a paid request or switches providers. Persisted diagnostics omit upstream error prose, addresses and arbitrary JSON; request identities are hashed and endpoint names contain only a recognized API route.

Advanced details contain measured monotonic durations. Headers and first-event milestones start at the same HTTP request and must not be added together. Tool execution includes image queue/call time. Direct Native Responses can combine text and image execution, so its separately observed image-tool interval is not a separate pure-provider latency measurement. Missing historical or post-restart measurements show as unrecorded. Browser send-to-terminal observation includes backend work and transport, and is only available in the page that observed it. Optional timing-storage failures emit a safe warning and cannot overturn a paid-request receipt or trigger another request.

Missing usage values remain unknown; an explicitly reported zero stays zero. These measurements do not estimate actual tokens, money, provider capacity or cache eligibility.

- Ambiguous image instructions retain images from the current conversation branch. A new attachment does not make earlier images irrelevant. Exact reference-only requests can narrow historical pixels; missing or deleted explicit references fail rather than silently substitute an image.
- Native results require a valid completed Responses receipt and a complete image. Failed or incomplete responses containing images are not successful tasks. Previously confirmed sibling tasks remain saved.
- A verified terminal SSE receipt is not undone by connection teardown. A disconnect without a valid terminal remains uncertain and does not automatically replay a paid POST.
- Identified duplicate deltas and terminal events are ignored; different legitimate events containing the same text remain distinct. Final message output can replace previews without duplicating text.
- Request IDs and tool call IDs retain their existing idempotency meaning. Image permissions and maximum steps/jobs limit request counts; they are **not an actual monetary budget**.

## Reproducing the offline baseline

From a development checkout with the test dependencies installed:

```sh
python scripts/diagnose_agent_context.py --rounds 5 25 50 100 --repeats 3
python scripts/diagnose_agent_result_snapshots.py --rounds 5 25 50 100 --repeats 3
python -m pytest -q tests/test_agent_context_diagnostic.py
```

Both tools create temporary synthetic libraries and block network connections. Context requests use `MockTransport`; the result-copy diagnostic stages generated fixtures without dispatching a queue worker. Output contains aggregate measurements, not prompts, credentials or existing library contents. Measurements are diagnostic observations, not timing thresholds.

The comparison below uses `main` at `0aa6c8f` and the correctness/workflow changes. Each read timing is the median of three runs on the same Windows machine; creation is measured once because replay is a different operation. Each image-history round adds a deterministic 197,104-byte PNG. JSON bytes include Base64; raw image bytes do not. These numbers are **not tokens, API latency, cost or cache hits**.

| Rounds | Image request JSON bytes before → after | Raw image bytes / occurrences, unchanged | `build_input` ms before → after | Snapshot ms before → after | Build SQL connections / statements | Snapshot SQL connections / statements |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 1,326,520 → 1,328,238 | 985,520 / 5 | 23.302 → 23.416 | 10.340 → 11.620 | 5 / 10 | 8 / 20 |
| 25 | 6,605,892 → 6,607,610 | 4,927,600 / 25 | 114.653 → 116.394 | 36.124 → 37.468 | 25 / 50 | 28 / 60 |
| 50 | 13,205,117 → 13,206,835 | 9,855,200 / 50 | 245.287 → 438.082 | 68.004 → 130.793 | 50 / 100 | 53 / 110 |
| 100 | 26,403,569 → 26,405,287 | 19,710,400 / 100 | 473.725 → 840.943 | 137.357 → 260.587 | 100 / 200 | 103 / 210 |

The SQL counts and image occurrence counts are unchanged. The unchanged snapshot implementation also became slower in the later samples; this run does not identify the cause of timing variation or establish a speed improvement. Text-only JSON grows from 13,568 bytes at 5 rounds to 111,795 at 100; its build time is 0.032–0.220 ms and snapshot time 4.287–7.430 ms, with three snapshot connections and ten statements.

The indirect-reference probe (“use the previous light” with a new attachment) previously supplied only one image at every checkpoint. It now supplies 5/25/50/100 branch images respectively. This is an intentional correctness cost with linear transmission, not a second copy of each image inside the request. The exact-reference-plus-current-attachment probe stays at two images, and the greeting-plus-attachment probe stays at one.

### Skill content and cache prefixes

For the fixed prompt-refinement task, selected chapter bodies grow from 2,861 to 3,221 UTF-8 bytes; the catalog from 1,023 to 1,242; full instructions from 5,198 to 6,916. Request JSON grows by a constant 1,718 bytes at every checkpoint; the tool schema stays at 2,078 bytes. Ordinary greetings preload no chapter bodies.

First-call instructions and tools are stable across this fixed task. The leading input items remain equal for 9/9, 49/49 and 99/99 items between successive checkpoints. Task selection and remaining image quotas can change instructions and tools. An actual matching skill receipt allows its exact pinned chapter body to be reused rather than loaded twice; in the measured follow-up, instructions shrink from 6,916 to 5,188 bytes. That also changes the instruction prefix, so reduced duplication does not prove better provider cache reuse. Missing `cached_tokens` remains unknown. Real provider routing, cache eligibility and cache lifetime have not been measured by these tools.

### Frozen output copies remain a separate problem

With one distinct 12,420-byte generated fixture per round:

| Rounds | Frozen copies before / after | Distinct frozen image hashes | Frozen bytes | `create_round` ms before → after | Snapshot ms before → after |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 10 / 10 | 4 | 124,200 | 72.554 → 97.579 | 18.233 → 25.468 |
| 25 | 300 / 300 | 24 | 3,726,000 | 419.142 → 732.022 | 77.804 → 139.941 |
| 50 | 1,225 / 1,225 | 49 | 15,214,500 | 774.196 → 1,413.861 | 138.073 → 263.780 |
| 100 | 4,950 / 4,950 | 99 | 61,479,000 | 2,738.475 → 2,891.513 | 485.911 → 515.940 |

This remains `n(n−1)/2` frozen copies, in addition to the original result files. A separate asset-ownership change should address immutable shared bytes and reference lifetimes before introducing summaries or a new Agent harness. Its acceptance boundary must include stopped/uncertain requests, deleted Gallery results, Library copies, old branches, repeated requests, backup/restore and migration rollback. No existing assets are rewritten by the workflow change.

## Validation scope

Regression suites verify actual request image bytes, JSON/SSE terminal states, duplicate events, frozen configuration, authorization and HTTP-to-worker-to-Gallery/Library behavior with mock providers. Frontend tests exercise production callbacks, configuration events and clipboard behavior. Isolated browser acceptance checks the actual settings, uploads, prompt blocks, Native/Hybrid results and asset picker against the real local backend with a synthetic provider. Scripted responses verify wiring and preservation, not model intelligence or visual quality.

Real supplier compatibility, output quality, paid generation, system IME and supplier-side cache behavior require separate acceptance. No live provider call, production-library migration or deployment is part of these diagnostics.
