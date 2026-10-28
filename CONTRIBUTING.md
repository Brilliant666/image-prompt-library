# Contributing

Thanks for considering a contribution to Image Prompt Library.

This project is a Local-first prompt/image reference manager. Please preserve the privacy-first design: user runtime data belongs on the user's device and should not be committed, uploaded, or sent to third-party services by default.

## License model

The core application code is licensed under **AGPL-3.0-or-later**. By contributing, you agree that your contribution is submitted under AGPL-3.0-or-later and may be included in versions distributed under alternative/commercial licensing terms by the project maintainer.

Sample data and third-party assets are licensed separately and retain their original attribution/license terms.


## Local setup

Use an isolated development library, as shown in the [development guide](docs/DEVELOPMENT.md). Do not use your daily library or an installed app's port for experiments.

Follow the complete platform-specific setup there rather than substituting daily configuration into a partial startup command. Source edits do not update an installed application.

## Draft PR, local trial and final acceptance

Follow [AGENTS.md](AGENTS.md) for the authoritative workflow and merge gates. Create a Draft PR after the first meaningful commit; opening a Draft does not require the full test suite. Run tests relevant to the changed behavior during development. An authorized local trial can precede remote CI completion and merge; low-impact documentation edits do not require rebuilding or restarting the app.

After user acceptance, review and push the accumulated changes to the same PR. Final CI runs the backend, frontend and extension checks, production and standalone Demo builds, native Windows installer smoke, and macOS backup/restore checks. The exact commands live in [CI](.github/workflows/ci.yml); the final Head and merge requirements live in [AGENTS.md](AGENTS.md). Do not substitute an older green run or weaken tests to pass a gate.

CI and local setup use `uv.lock` (`uv sync --locked --extra dev`) and `package-lock.json` (`npm ci`). Local setup preserves extra development tools with `--inexact`; fresh CI environments use an exact sync. A dependency change must update the lock intentionally, then revalidate the affected environment. Do not reuse validation solely because source files match.

For an already running **isolated** test server, the optional smoke helper is:

```bash
BASE_URL=http://127.0.0.1:8010 ./scripts/smoke-test.sh
```

## Release assets — retained design, currently disabled

This fork is source-maintained. Public Release, Pages and release-candidate workflows are disabled; the procedure below describes the retained release design for a future, explicitly authorized publishing policy. It is not an available update path today. See [independent maintenance](docs/INDEPENDENT_MAINTENANCE.md).

Release tags must use `v<major>.<minor>.<patch>` with an optional SemVer prerelease suffix, such as `v1.2.3` or `v1.2.3-rc.1`. Build-metadata suffixes (`+...`) are not accepted because release asset filenames must remain exact. Manual release workflow dispatches are candidate-only and must run from `main`: the workflow binds the schema-v2 manifest to that commit, verifies the package locally, creates the exact tag only after those checks, uploads only the archive, checksum, and manifest to a draft release, downloads them back through the GitHub API, verifies them again, and publishes the release as a prerelease without changing GitHub Latest. If a run stops after creating the draft, rerunning the same tag removes only those exact expected draft assets and resumes the gate. If publication completed, an exact three-asset published prerelease is reverified idempotently; incomplete, duplicate, unknown, orphaned, or retargeted release state is retained and rejected for manual review. Do not publish a draft or stable release manually without completing the same verification.

Before promoting a bare candidate tag, run the manual `Release candidate install update rollback smoke` workflow against the current stable baseline. It uses public assets and default user paths on Windows, macOS, and Ubuntu. Leave the release marked as a prerelease if any platform fails. After every job passes, update that existing GitHub release to `prerelease=false` and `make_latest=true`, then verify `/releases/latest` points to the same release ID; do not retag or re-upload the assets.

Manual `scripts/package-release.sh --skip-build` runs must set `IMAGE_PROMPT_LIBRARY_SOURCE_SHA` to the exact 40-character commit for the controlled frontend build being packaged; normal release workflow runs set this automatically after building.

## Development guidelines

- Keep runtime data out of git:
  - `library/db.sqlite`
  - `library/db.sqlite-*`
  - `library/originals/`
  - `library/thumbs/`
  - `library/previews/`
  - `backups/`
- Avoid hardcoded absolute paths in public docs or scripts.
- Keep local agent state, QA captures, generated artifacts, machine-specific paths, usernames, credentials, and private prompts/images out of git.
- Treat `.agents/`, `.codex/`, `.codex-qa-*`, `.codebase-memory/`, `.qa-*`, `.superpowers/`, `docs/plans/`, and `docs/qa/` as local-only.
- Stage explicit paths only; never use `git add .` or `git add -A`.
- Before committing, inspect `git status --short`, `git diff --cached --name-status`, and `git diff --cached`.
- Before pushing, inspect `git diff --name-status origin/main...HEAD`.
- Keep `/media` limited to intended image media directories; never expose the SQLite DB or internal files.
- Prefer small, tested changes.
- Add regression tests for bug fixes and public-install behavior.
- Preserve the accepted browsing model: Explore is a Collection directory leading to natural-ratio discovery feeds; Library is adaptive masonry and owns selection and batch management.

## Reporting issues

When reporting a bug, include:

- OS and browser
- Python and Node versions
- Whether you use dev mode or `scripts/start.sh`
- Steps to reproduce
- Console/server error output if available
- Whether your library is empty, manually created, or imported

Do not attach private prompt/image data unless you intentionally want it public.
