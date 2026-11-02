# Unreleased — independent source edition

This independently maintained repository is source-only: **no standalone Release
installer is published**. “Unreleased” here means not packaged as a public binary
release; these features can already be present in reviewed `main` source. Do not
install an upstream release over this edition.

## Current source capabilities

- Agent continuity uses verified generated results for natural follow-up edits,
  while explicit references and frozen branches keep their original meaning.
- A shared Provider layer supports OpenAI-compatible, Gemini native and Seedream
  native image connections; Agent Hybrid keeps its separate Responses text path.
- API connections use a single type-selection flow and unsaved model discovery.
  Text/image/unknown labels are evidence-based; manual IDs remain available.
  Text-only claims do not replace the image default, and failed discovery does not
  retain a stale success indicator.
- Paid final images have local registration recovery; imports validate declared
  media and commit complete assets atomically. Unknown results are not replayed.
- Bounded 20,000,000-pixel image handling covers supported native 4K outputs without
  resizing stored originals; other byte and protocol limits still apply.

## Documentation

[Quick start](../QUICK_START.md) covers local use, isolated development and tests.
[Deployment](../DEPLOYMENT.md) separates the Cloudflare/Vercel read-only demo from
full persistent-server operation and protected remote access.
[API connections](../API_CONNECTIONS.md) and [native image protocols](../NATIVE_IMAGE_PROVIDERS.md)
explain settings, model discovery and verification limits.

## Verification boundary

Automated tests and synthetic providers do not establish real account access,
visual quality, latency or fees. Cloud-hosting instructions are not a claim that
this repository has deployed to your account or gained a serverless storage adapter.
Historical [v0.11.2](v0.11.2.md) notes describe the upstream project, not a new
release of this independent edition. See [source maintenance](../INDEPENDENT_MAINTENANCE.md).
