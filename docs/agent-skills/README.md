# Agent image-prompt skills

Agent includes two small, on-demand guidance packages. They are available by default; ordinary conversation sends only their short catalog. For clear image-prompt tasks, the application selects an overview and one relevant section locally and supplies them with the request, without relying on the model to make an extra tool call. Preloaded sections do not need to be read again. The model may still call the read-only `read_agent_skill` tool for an additional necessary section. Both paths retain the source revision and section with the text. Reading or preloading a skill does not authorize image generation, web search, extra variants, or configuration changes.

| Skill | Purpose | Available sections |
| --- | --- | --- |
| `image-prompt-reverse` | Derive a reusable prompt from an image actually supplied to a vision-capable model | `overview`, `analysis`, `illustration` |
| `gpt-image` | Refine a prompt or specify an image edit while preserving the user's constraints | `overview`, `composition`, `editing`, `text` |

Prompt-only requests should produce text. Authorized generation continues through the application's existing tools, bound provider/model, reference IDs, request parameters and image budget. The skills do not execute upstream scripts, install a CLI, read credentials, fetch remote files, or choose a model. The finite text slices are embedded in `backend/services/agent_skills.py` so an installed Python package needs no personal skill directory. Local preloading requires no extra model step; optional model-driven skill reads still use the existing model-step budget. Text sent to a provider contributes to its normal token usage.

Local selection recognizes explicit Chinese and English requests to reverse-engineer an available image, write/refine a prompt, generate an image, or specify an image edit. For example, “根据图生成提示词” with a usable image selects reverse-engineering guidance; “优化这段提示词” does not require an image. Merely attaching an image or enabling generation does not select a skill. Ordinary chat, OCR-only requests and simple descriptions remain unselected, as do explicit requests not to use skills. A supplied previous prompt is considered only for explicit continuations such as “继续优化” or “refine it”; an unrelated new message does not inherit it. These local rules are intentionally conservative, so unusual wording can still use the on-demand reader.

## Sources and adaptation

### Image Prompt Reverse

- Source: [LunarXuan/image-prompt-reverse](https://github.com/LunarXuan/image-prompt-reverse).
- Pinned revision: `4dead0a32e2312e56a14ebf3658ee75c9b865055`.
- Files used: [SKILL.md](https://github.com/LunarXuan/image-prompt-reverse/blob/4dead0a32e2312e56a14ebf3658ee75c9b865055/SKILL.md), `references/analysis-framework.md`, `references/category-guides.md`, `references/illustration-style.md` at that revision.
- Upstream license: GNU General Public License v3.0. Full text: [LICENSE.image-prompt-reverse.txt](../../licenses/agent-skills/LICENSE.image-prompt-reverse.txt).
- Adaptation: condensed the analysis and category guidance into bounded sections, retained visible-evidence requirements and user-preferred output formats, and added application authorization/reference boundaries. The default bilingual output and targeted negative terms are writing guidance; negative terms are not a separate image API parameter. No upstream installation instructions or images are included.

### GPT Image prompt craft

- Source: [wuyoscar/GPT-Image2-Skill](https://github.com/wuyoscar/GPT-Image2-Skill).
- Pinned revision: `9f8aa1a44a4a5c0f5a5d6e45eed564b3e2d5b87f`.
- Files used: [skills/gpt-image/SKILL.md](https://github.com/wuyoscar/GPT-Image2-Skill/blob/9f8aa1a44a4a5c0f5a5d6e45eed564b3e2d5b87f/skills/gpt-image/SKILL.md) and [references/craft.md](https://github.com/wuyoscar/GPT-Image2-Skill/blob/9f8aa1a44a4a5c0f5a5d6e45eed564b3e2d5b87f/skills/gpt-image/references/craft.md).
- Upstream license: MIT, Copyright (c) 2026 Wuyoscar. Full notice: [LICENSE.gpt-image.txt](../../licenses/agent-skills/LICENSE.gpt-image.txt).
- Adaptation: translated and condensed prompt construction, composition, edit invariants, multi-reference roles and exact-text guidance. The upstream CLI workflow, API flags, fixed model menu, quality defaults and reference gallery are deliberately not included; the application already owns those settings and execution. No third-party gallery prompts or images are bundled. This adaptation is not an assertion that every model in the upstream documentation works with a configured provider.

These adaptations do not modify Explore's existing sample imports or the provenance of previously imported material. Upstream changes are reviewed and pinned explicitly; there is no automatic download or update mechanism.
