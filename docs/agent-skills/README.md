# Agent image-prompt skills

Agent includes two small, on-demand guidance packages for image creation and prompt writing. **Settings → Agent → 启用图片提示词专业工作流** controls both packages and is enabled by default, including for older saved configurations. Turning it off removes the skill catalog, automatic section loading and `read_agent_skill` tool; ordinary conversation, visual input and explicitly authorized generation remain available. Existing successful skill receipts remain part of conversation history, but do not reenable skill calls or grant generation permission. Saving this preference does not call a model or change provider, model or generation settings.

When enabled, ordinary conversation sends only the short skill catalog. For clear image-prompt tasks, the application selects an overview and one relevant section locally and supplies them with the request, without a separate model call for classification. A combined reverse-and-refine task can use the corresponding sections from both packages. Preloaded sections do not need to be read again. The model may still call the read-only `read_agent_skill` tool for an additional necessary section. Both paths retain the source revision and section with the text. Reading or preloading a skill does not authorize image generation, web search, extra variants, or configuration changes.

| Skill | Purpose | Available sections |
| --- | --- | --- |
| `image-prompt-reverse` | Derive a reusable prompt from an image actually supplied to a vision-capable model | `overview`, `analysis`, `illustration` |
| `gpt-image` | Refine a prompt or specify an image edit while preserving the user's constraints | `overview`, `composition`, `editing`, `text` |

Prompt-only requests should produce text. Authorized generation continues through the application's existing tools, bound provider/model, reference IDs, request parameters and image budget. The skills do not execute upstream scripts, install a CLI, read credentials, fetch remote files, or choose a model. The finite text slices are embedded in `backend/services/agent_skills.py` so an installed Python package needs no personal skill directory. Local preloading requires no extra model step; optional model-driven skill reads still use the existing model-step budget. Text sent to a provider contributes to its normal token usage.

Local selection recognizes explicit Chinese and English requests to reverse-engineer an available image, write/refine a prompt, generate an image, or specify an image edit. Named execution requests such as “使用图片反推工作流” and “使用 GPT Image Skill 优化” take priority over inferred task selection. Questions about how to use those workflows do not execute them. An explicit opt-out can exclude one named workflow while leaving the other available. “优化刚才反推的提示词” uses the prompt-craft package rather than treating the existing derived text as a new image to reverse-engineer. A task such as “先反推这张图，再优化成英文 Prompt” can load both packages with at most four selected sections, not every chapter.

Merely attaching an image or enabling generation does not select a skill. Ordinary chat, OCR-only requests, descriptions and questions such as “这张图为什么好看？” remain normal visual conversation. Asking next to turn that analysis into a reusable prompt can activate the relevant writing guidance. The immediately preceding user prompt is considered for explicit continuations such as “继续优化”, “refine it”, “给我一个更短的英文版本” or “改成更适合 GPT Image 2.5 的写法”. The same short request after an unrelated database discussion does not inherit an image workflow. These local rules are intentionally conservative; repeated abbreviated follow-ups or unusual wording may require the on-demand reader rather than automatic preloading. This is not a new conversation-memory system.

## Output and preservation

- Reverse-engineered prompts are explicitly identified as **inferred / derived prompts**, not the unknown original prompt that created an image. The model must receive the required image pixels; a reference ID alone is not visual evidence. Visible observations are distinguished from uncertain inference.
- Language, detail, length and target-model instructions come from the user. Without a requested language, guidance follows the user's language. Neither bilingual output nor a fixed character count or number of negative terms is mandatory.
- Prompt optimization preserves the original intent, exact text, clothing, subject, composition and other stated constraints. Partial edits retain the parts the user asked to keep. The original input stays in conversation history; the derived or optimized prompt appears separately in copyable paragraphs or code blocks.
- A request for analysis or a prompt produces text. Image tools run only when the user requests generation and the existing request authorization permits it. Merely allowing images is not an instruction to generate them.
- Skills do not save or overwrite Library assets. Generated images still use the existing Native or Hybrid execution paths and Gallery jobs, with normal Library collection actions.

The reader uses only finite bundled text. When the actual conversation input already contains a matching `read_agent_skill` call and its successful receipt with the exact section body and pinned revision, that content can be reused across model steps or turns rather than duplicated in preloaded instructions. Attribution metadata alone is not the section body: fresh requests must still supply necessary guidance when previous instructions are not present in the conversation input. This is bounded reuse, not a new long-term memory or context-summary system.

## Sources and adaptation

### Image Prompt Reverse

- Source: [LunarXuan/image-prompt-reverse](https://github.com/LunarXuan/image-prompt-reverse).
- Pinned revision: `4dead0a32e2312e56a14ebf3658ee75c9b865055`.
- Files used: [SKILL.md](https://github.com/LunarXuan/image-prompt-reverse/blob/4dead0a32e2312e56a14ebf3658ee75c9b865055/SKILL.md), `references/analysis-framework.md`, `references/category-guides.md`, `references/illustration-style.md` at that revision.
- Upstream license: GNU General Public License v3.0. Full text: [LICENSE.image-prompt-reverse.txt](../../licenses/agent-skills/LICENSE.image-prompt-reverse.txt).
- Adaptation: condensed the analysis and category guidance into bounded sections, retained visible-evidence requirements and user-preferred output formats, and added application authorization/reference boundaries. The application's default follows the user's language and required detail instead of the upstream fixed bilingual length and negative-term counts. Optional negative terms are writing guidance, not a separate image API parameter. Derived prompts are labelled as inference. No upstream installation instructions or images are included.

### GPT Image prompt craft

- Source: [wuyoscar/GPT-Image2-Skill](https://github.com/wuyoscar/GPT-Image2-Skill).
- Pinned revision: `9f8aa1a44a4a5c0f5a5d6e45eed564b3e2d5b87f`.
- Files used: [skills/gpt-image/SKILL.md](https://github.com/wuyoscar/GPT-Image2-Skill/blob/9f8aa1a44a4a5c0f5a5d6e45eed564b3e2d5b87f/skills/gpt-image/SKILL.md) and [references/craft.md](https://github.com/wuyoscar/GPT-Image2-Skill/blob/9f8aa1a44a4a5c0f5a5d6e45eed564b3e2d5b87f/skills/gpt-image/references/craft.md).
- Upstream license: MIT, Copyright (c) 2026 Wuyoscar. Full notice: [LICENSE.gpt-image.txt](../../licenses/agent-skills/LICENSE.gpt-image.txt).
- Adaptation: translated and condensed prompt construction, composition, edit invariants, multi-reference roles and exact-text guidance. The upstream CLI workflow, API flags, fixed model menu, quality defaults and reference gallery are deliberately not included; the application already owns those settings and execution. No third-party gallery prompts or images are bundled. This adaptation is not an assertion that every model in the upstream documentation works with a configured provider.

These adaptations do not modify Explore's existing sample imports or the provenance of previously imported material. Upstream changes are reviewed and pinned explicitly; there is no automatic download or update mechanism.
