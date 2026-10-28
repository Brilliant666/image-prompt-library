# Agent image-prompt skills

Agent includes two bundled guidance packages for image creation and prompt writing. **Settings → Agent → 启用图片提示词专业工作流** controls both packages and is enabled by default, including for older saved configurations. Turning it off removes the skill catalog, guidance bodies and `read_agent_skill` tool from new requests; ordinary conversation, visual input and explicitly authorized generation remain available. Saved successful skill receipts are preserved but do not reenable skill calls or grant generation permission. Saving this preference does not call a model or change provider, model or generation settings.

When enabled, every request contains both skills' complete adapted `overview` bodies in a fixed order, not just their names or catalog. No keyword or regular-expression task classifier decides whether they are present. The model interprets the user's intent from the conversation and may call the read-only `read_agent_skill` tool for a deeper chapter such as `analysis` or `editing`. It can use both workflows for a combined task. Basic guidance does not require an extra model call to load or confirm it. Source revisions and chapter identities are retained, and reading guidance does not authorize image generation, web search, extra variants, or configuration changes.

| Skill | Purpose | Available sections |
| --- | --- | --- |
| `image-prompt-reverse` | Derive a reusable prompt from an image actually supplied to a vision-capable model | `overview`, `analysis`, `illustration` |
| `gpt-image` | Refine a prompt or specify an image edit while preserving the user's constraints | `overview`, `composition`, `editing`, `text` |

Prompt-only requests should produce text. Authorized generation continues through the application's existing tools, bound provider/model, reference IDs, request parameters and image budget. The skills do not execute upstream scripts, install a CLI, read credentials, fetch remote files, or choose a model. The finite text slices are embedded in `backend/services/agent_skills.py` so an installed Python package needs no personal skill directory. Local preloading requires no extra model step; optional model-driven skill reads still use the existing model-step budget. Text sent to a provider contributes to its normal token usage.

Users may name a workflow, describe a task naturally or continue an existing edit with a short instruction. The model chooses which guidance applies, including named workflow requests and user requests not to use a workflow. “优化刚才反推的提示词” can refine existing derived text, while “先反推这张图，再优化成英文 Prompt” can combine both workflows. The application does not enumerate required sentence patterns, clothing names or other trigger words.

The core guidance stays available for ordinary chat, OCR, visual analysis and continuous edits, without forcing a long prompt template into every answer. A question such as “这张图为什么好看？” should receive visual analysis; a later request can turn that analysis into a reusable prompt. Merely attaching an image or enabling image mode does not request generation. Image mode controls image-tool authorization independently of the professional workflow preference. A supplied-guidance receipt proves what text reached the model, not that a real model followed it correctly.

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
