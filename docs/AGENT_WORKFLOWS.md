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

Uploading an image or enabling image permission alone does not request generation. When the switch is off, ordinary chat, visual input and authorized generation remain available, but automatic skill loading and `read_agent_skill` are disabled. Previously recorded conversation and genuine tool results remain history; switching off does not erase them or silently activate a new skill read. The local selector is conservative, not an extra paid classifier; unusual phrasing can still require a model-driven finite section read. See [skill sources, chapters and adaptation](agent-skills/README.md).

### Continue a professional task

Short messages such as “就换白色的”, “保持原来的姿势”, “接着改背景” and “按照刚才的效果继续” can inherit the current editing task's target, confirmed requirements and relevant workflow. They do not depend only on keywords in the immediately preceding user message. An answer to the assistant's clarification can continue the same task. An explicit task change or ending the task stops that inheritance; a greeting, ordinary visual-analysis question or unrelated request does not reactivate the old workflow.

Only the relevant sections of the two pinned local skills are used. An automatic preload records the section identity and source revision once per round, and later requests can reuse the validated section as application-supplied guidance. Repeating a short continuation does not append another copy of the same automatic guidance for every previous round. Genuine `read_agent_skill` calls and their paired results remain in conversation history. A receipt is not a fabricated tool call, and neither a receipt nor a skill grants image permission. Disabling professional workflows also disables reuse of automatic guidance; re-enabling permits task-relevant reuse or loading again.

### Read and copy a prompt

Recognized prompt blocks show **提示词 · 纯文本** and a visible **复制提示词** button. Natural-language prompts wrap within the card, including long lines; wrapping does not insert characters into the copied text. Standard fenced prompt blocks copy directly from their source, preserving spaces, line endings and paragraphs, without the Markdown fence or surrounding explanation. An unfinished streamed block can also be copied. Ordinary replies stay ordinary replies, and programming code keeps its code-block display and copy behavior. Markdown and formulas remain available.

Original user input remains available in history. Original, reverse-derived and optimized prompts do not overwrite one another. Neither reverse prompting nor refinement automatically overwrites a Library item or creates an empty image entry.

Native uses the Responses image tool. Hybrid uses the chosen text Responses profile and the existing Images API queue. Current API continues to follow the workspace profile. The selected configuration is frozen for each request. Generated results retain their conversation, round, execution prompt, references, model and Gallery job; Gallery and Library selections can be brought back into the same workspace for further editing.

## Correctness and recovery boundaries

### Continue an image edit

The current editing task records a stable target image, auxiliary references and their roles, the user's requirements and confirmed constraints. Describe changes or end the task in the conversation; no separate task form is required. The model can select the target and auxiliary roles from this branch's verified image references, or ask a clarification when the target is ambiguous. Each branch keeps its own task, and unavailable references cannot silently substitute another image. Task roles supplement the required visual history rather than removing it.

For continuous edits, local image tools can select the subject and auxiliary roles in the same call that supplies the execution prompt. The server validates the entire batch's references before changing the selection or creating jobs. This removes a separate model round trip when selection and generation can be decided together; it does not bypass image permission, job limits or uncertain-result recovery. A direct Native image tool still requires selection to be resolved before its upstream call; Native batch functions validate locally first. Actual provider latency and whether the model uses this shorter path depend on the provider.

The composer keeps one **Image mode** switch, initially off. Turning it on permits the model to interpret a full visual prompt or a natural generation request; it does not force generation for a request to analyze or refine text. **Image settings** in Hybrid share the Gallery's provider, model, dimensions, quality, format and image count. Changes work in both directions, while each workspace retains its own draft and attachments. Automatic dimensions are resolved from the prompt and references of the request being sent. Previously submitted requests retain their frozen settings. Native and Current API continue to use their Responses image tool and do not silently inherit an incompatible Gallery protocol.

The configured maximum jobs and model steps remain backend safeguards, without duplicate per-turn controls. Image count is a requested default, separate from the safety maximum; a choice above that maximum is rejected explicitly. These limits are request-count controls, not monetary budgets.

When changing the image API profile, the image-model field adopts that profile's saved default. A full manual model ID remains possible. This does not change the text profile, another profile's settings or an already submitted request.

### Retry an answer or image

The compact **Retry** button on an image reuses its actual execution prompt and original frozen references with the current image settings. It creates a new linked Gallery job without an additional text-model planning request, and retains the original result or confirmed failure. The composer draft and attachments are unaffected. Change the prompt by describing the desired change in the conversation. A repeated submission identity returns the same receipt; an uncertain response requires checking that receipt instead of sending again. Quota, moderation and rate-limit failures never automatically retry or change suppliers.

Successful, saved and confirmed failed results can be retried when their source is complete. Hybrid remains on the Images queue; Native remains on Responses. Native direct results require a reliable execution prompt and a complete record of the pixels actually sent, including necessary history images. Old results without this evidence, excessive reference counts, missing originals, protocol changes and unknown outcomes block direct retry rather than substituting another request.

On a text answer, **Retry** immediately requests another answer in a sibling branch using the original user message and input references. It does not enable image generation or search, and does not replace an unsent draft. This preservation also applies when the submission receipt is lost and the page is reloaded.

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
python scripts/diagnose_agent_execution.py --rounds 5 25 50 100 --repeats 3
python -m pytest -q tests/test_agent_context_diagnostic.py tests/test_agent_execution_diagnostic.py
```

All three tools create temporary synthetic libraries and block network connections. Context requests use `MockTransport`; the result-copy diagnostic stages generated fixtures without dispatching a queue worker. The execution diagnostic runs the real Agent request loop, SSE parsing, Images queue and result persistence against `MockTransport`. Output contains aggregate measurements, not prompts, credentials or existing library contents. No tool reads a production library or contacts a supplier.

The following samples were collected on Windows with Python 3.10.10 on 2026-10-26. Reads use the median of three repetitions. Request creation and execution run once because repeating a mutation would measure idempotent replay instead. Timings vary with local scheduling and filesystem load; they are observations, not performance thresholds or proof of a speed improvement. JSON sizes include Base64, while image byte counts do not. None of these byte counts are tokens or prices.

### Same-fixture context comparison

The result-observability baseline ([PR #20](https://github.com/Brilliant666/image-prompt-library/pull/20), stage A) and the task/skill workflow version (stage C) use the same fixture: each image-history round independently uploads one 197,104-byte synthetic PNG. Request JSON adds 548 bytes at 5 rounds and 863 bytes at the later checkpoints. Required image counts and raw pixels are unchanged. Re-uploading identical source bytes in this particular fixture creates independent upload assets; it is separate from copying historical generated results.

| Rounds | Image request JSON bytes, A → C | Raw image bytes / occurrences, unchanged | C context preparation ms | C `build_input` ms | C snapshot ms | C snapshot connections / SELECTs |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 1,328,238 → 1,328,786 | 985,520 / 5 | 32.444 | 35.367 | 14.488 | 8 / 14 |
| 25 | 6,607,610 → 6,608,473 | 4,927,600 / 25 | 136.767 | 132.675 | 42.977 | 28 / 34 |
| 50 | 13,206,835 → 13,207,698 | 9,855,200 / 50 | 264.892 | 262.085 | 85.436 | 53 / 59 |
| 100 | 26,405,287 → 26,406,150 | 19,710,400 / 100 | 535.732 | 537.930 | 188.976 | 103 / 109 |

Context preparation includes loading the request and resolving references. `build_input` is measured separately with an already-read request and reference map; these independent medians must not be subtracted as if they were nested observations of one call. The snapshot adds one SELECT compared with the stage A baseline for the editing-task/retry projection. The indirect-reference probe retains 5/25/50/100 branch images; the exact-reference-plus-current-attachment probe retains two, and a greeting with an attachment retains one. Necessary pixels are not dropped to improve timing.

| Rounds | Text-only JSON bytes, A → C | C context preparation ms | C `build_input` ms | C snapshot ms |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 13,568 → 14,116 | 3.193 | 0.148 | 6.958 |
| 25 | 34,244 → 35,107 | 2.139 | 0.214 | 6.537 |
| 50 | 60,094 → 60,957 | 2.718 | 0.276 | 9.583 |
| 100 | 111,795 → 112,658 | 2.847 | 0.409 | 15.966 |

Text-only snapshots use three connections and nine SELECTs at each checkpoint. Repeated local runs showed substantial timing variation, so the stable byte and query counts are stronger evidence about work performed than the timing difference between two runs.

### Frozen outputs after asset reuse

The immutable frozen-asset reuse change in [PR #19](https://github.com/Brilliant666/image-prompt-library/pull/19) already removed the earlier quadratic physical-copy behavior. With one distinct 12,420-byte generated fixture per round, the current result-snapshot diagnostic finds one frozen original per prior result, **zero duplicate physical copies** and **zero additional files on request-ID replay**. Original Gallery result files remain separate from these frozen references.

| Rounds | Frozen original files / duplicate copies | Frozen bytes | `create_round` ms | `build_input` ms | Snapshot ms | Cumulative frozen history JSON bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 4 / 0 | 49,680 | 60.917 | 20.625 | 21.515 | 9,728 |
| 25 | 24 / 0 | 298,080 | 228.156 | 120.685 | 91.618 | 306,394 |
| 50 | 49 / 0 | 608,580 | 724.717 | 404.179 | 296.540 | 1,247,994 |
| 100 | 99 / 0 | 1,229,580 | 1,653.093 | 945.837 | 598.297 | 5,016,319 |

The corresponding request JSON sizes are 73,868 / 411,979 / 834,629 / 1,679,930 bytes. Snapshot connections/SELECTs are 13/19, 53/59, 103/109 and 203/209. Physical image growth is linear, but copying the prior conversation's JSON into each frozen request still produces approximately quadratic cumulative history JSON. Image resolution and snapshot construction also perform increasing per-asset database reads and validation. A follow-up can investigate batched reads and immutable history manifests while preserving frozen identity, branches, deletion behavior, backups and recovery. This workflow change does not rewrite historical requests or asset ownership.

### Full execution with measured phases

The execution fixture starts with one synthetic input image and creates a distinct 12,420-byte result in every round. It runs **104 Responses POSTs and 100 Images POSTs** through the real engine and image queue. Each of the four checkpoint rounds includes one initial model call, one image call and one model follow-up; the other rounds finish after their image result. Counts come from the mock transport, not an assumed request multiplier.

| Rounds | First model request JSON bytes | Raw image bytes / occurrences | Context preparation ms | Snapshot ms | Snapshot connections / SELECTs |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 95,847 | 62,100 / 5 | 26.299 | 34.991 | 15 / 21 |
| 25 | 439,436 | 310,500 / 25 | 216.656 | 224.954 | 55 / 61 |
| 50 | 868,926 | 621,000 / 50 | 481.536 | 396.005 | 105 / 111 |
| 100 | 1,727,816 | 1,242,000 / 100 | 951.737 | 825.677 | 205 / 211 |

The mock deliberately waits 5 ms before model headers, another 5 ms before its first SSE event, another 5 ms before completion, and 10 ms in the Images response. The table below reads persisted stage measurements after reloading the request. It is **not a benchmark of a real model or supplier**.

| Rounds | Preparation ms | First model call's first event ms | Model response ms, two calls | Image provider interval ms | Tools ms | Result processing ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 173 | 47 | 140 | 0 | 187 | 16 |
| 25 | 751 | 31 | 172 | 16 | 281 | 30 |
| 50 | 1,531 | 47 | 188 | 32 | 297 | 47 |
| 100 | 2,845 | 63 | 234 | 15 | 265 | 79 |

Preparation includes request creation as well as pre-model work. Tool time contains queueing, dispatch, the image call, persistence and completion polling. First event means the first received SSE event, **not the first visible text token**. Model-response duration includes the local stream handling performed within that measured interval. The execution clock on this Python/Windows runtime has 15.625 ms resolution, so a 10 ms mock wait can measure 0; this measured zero is different from an unrecorded `null`. The diagnostic reports both execution-clock and high-resolution benchmark-clock precision.

Creation itself took 89.303 / 450.914 / 946.936 / 1,778.339 ms; `run_request` took 564.470 / 1,180.521 / 1,737.674 / 2,721.977 ms. At 100 rounds that execution used 331 SQLite connections and 419 SELECTs. These local measurements demonstrate why total time minus image-call time cannot all be labelled text-model latency. They cannot determine whether a particular real conversation was delayed by routing, throttling, model computation or the network.

### Skill content and cache prefixes

The full execution fixture uses `gpt-image/overview` and `gpt-image/editing`, totalling 3,292 UTF-8 bytes. After the initial load, their bodies appear once each in the reusable input guidance and not again in instructions. They still travel in the full-context HTTP request; local reuse does not mean the supplier has cached them or that no bytes are transmitted.

The first preload moves from instructions into durable input guidance on the next request, changing the prefix once. Across the later 5→25, 25→50 and 50→100 checkpoints, instructions and tools match; 17/18, 98/99 and 199/200 previous input items remain equal from the beginning. The current editing-task data is not identical when that user turn later becomes history. Within a checkpoint's tool follow-up, the existing input prefix is preserved, but the tool schema shrinks from 2,078 to 449 bytes after image permission is exhausted. New tasks, different skill sections or configuration changes can also change prefixes. No optimization keeps an unauthorized tool available merely for cache stability.

For usage-parsing verification, the synthetic provider reports fixed 120 input, 20 output and 140 total tokens per model call. It omits `cached_tokens` in 52 receipts and explicitly reports 0 in the other 52; both cases remain distinct after persistence. These values are **fixture reports, not actual token usage, cache measurements or cost savings**. Real supplier cache eligibility, routing and lifetime remain unverified. A missing cache field cannot establish a zero hit rate, and stable local prefixes alone cannot establish cache hits.

## Validation scope

Regression suites verify actual request image bytes, JSON/SSE terminal states, duplicate events, frozen configuration, authorization and HTTP-to-worker-to-Gallery/Library behavior with mock providers. Frontend tests exercise production callbacks, configuration events and clipboard behavior. Isolated browser acceptance checks the actual settings, uploads, prompt blocks, Native/Hybrid results and asset picker against the real local backend with a synthetic provider. Scripted responses verify wiring and preservation, not model intelligence or visual quality.

Real supplier compatibility, output quality, paid generation, system IME and supplier-side cache behavior require separate acceptance. No live provider call, production-library migration or deployment is part of these diagnostics.
