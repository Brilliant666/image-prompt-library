# Playground workspaces

Image Prompt Library remains the asset library and the only generation task store.
The gallery, Agent workspace and grouped settings adapt interaction and source
code from [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground),
pinned to `1e9d5af60aadd9117a835cc2da43908b8e3370dd` (2026-10-19).

The source is MIT licensed, copyright 2026 CookSleep; its complete license is
retained in [Playground-MIT.txt](../licenses/Playground-MIT.txt). The existing
Image Prompt Library license and attribution remain in effect.

Adaptations replace the source's browser database, credentials and direct provider
requests with this project's server-side profiles, generation queue and library.
No Playground installer, updater, remote announcement, sponsor configuration or
preconfigured account is included.

The source `virtualGrid.ts` and `useVirtualGrid.ts` are reused for virtual layout
and rectangular selection. Lightbox wheel zoom, pan, pinch, double-tap and swipe
handling comes from `src/components/Lightbox.tsx`, with scoped styles and this
project's focus management. Image dragging outside these controls remains enabled.

The new workspaces require a local backend; the static example site continues to
offer Explore and Library without prompting for provider credentials.
