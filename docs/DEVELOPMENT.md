# Development Guide

Use this path to develop the app or run from a checkout. `main` is the integration
branch; develop changes on a feature branch and submit a pull request to `main`.
The former `codex/sub2api-images` branch is retained as history.

For a Chinese walkthrough with complete Windows/macOS/Linux commands, see
[Quick start](QUICK_START.md). For a public static showcase or a persistent full
server, see [Deployment](DEPLOYMENT.md). A source checkout does not install the
historical global application controller.

## Source setup

Use Python 3.10+ and Node.js 24. The commands below are for macOS/Linux; Windows
PowerShell setup is documented in [Independent maintenance](INDEPENDENT_MAINTENANCE.md#从源码开发与启动).
Use an isolated library and credential paths for development. Never point an
unverified branch at daily data: startup initializes the database and recovers
queued work. Confirm the test library is unused before starting.
A checkout and an installed application are separate copies; editing
source does not update an existing installation.

```bash
git clone https://github.com/Brilliant666/image-prompt-library.git
cd image-prompt-library
./scripts/setup.sh
export IMAGE_PROMPT_LIBRARY_PATH="$PWD/.local-work/dev/library"
export IMAGE_PROMPT_LIBRARY_AUTH_PATH="$PWD/.local-work/dev/auth.json"
export IMAGE_PROMPT_LIBRARY_GROK_AUTH_PATH="$PWD/.local-work/dev/grok-auth.json"
export IMAGE_PROMPT_LIBRARY_CONFIG_PATH="$PWD/.local-work/dev/config.json"
export IMAGE_PROMPT_LIBRARY_OPENAI_COMPATIBLE_CONFIG_PATH="$PWD/.local-work/dev/openai-compatible.json"
export IMAGE_PROMPT_LIBRARY_CAPTURE_CLIENTS_PATH="$PWD/.local-work/dev/capture-clients.json"
export IMAGE_PROMPT_LIBRARY_CAPTURE_ORGANIZER_CONFIG_PATH="$PWD/.local-work/dev/capture-organizer.json"
export BACKEND_PORT=8010
npm run build
./.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
```

Open <http://127.0.0.1:8010/>. Use synthetic content and mock providers; do not
copy personal data or real credentials into this setup. Check an existing test
directory for queued work before reusing it.

`setup.sh` auto-detects `python3.13`, `python3.12`, `python3.11`, or `python3.10` before falling back to `python3`. On macOS, `/usr/bin/python3` may still be Python 3.9; if setup cannot find a new enough interpreter, install Python 3.10+ and rerun with an explicit interpreter:

```bash
PYTHON=/path/to/python3.12 ./scripts/setup.sh
```

`setup.sh` installs locked dependencies with uv 0.12.16 (`--locked --extra dev`)
and `npm ci`. It preserves existing local tools with `--inexact` and refuses to
silently rewrite an outdated lockfile. CI uses a fresh, exact sync of the same lock.

`start.sh` uses `.venv/bin/python` from setup when available and prints an actionable setup message if Python dependencies are missing.

For normal local use, `scripts/start.sh` builds the frontend and serves the built app through FastAPI. Unlike the direct isolated command above, it reads `.env`: review its library and credential paths before using it with a development branch.

## Development mode

Stop the isolated server with `Ctrl-C`. In the same shell, retaining all isolated
paths above, start the development backend:

```bash
./.venv/bin/python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8010
```

In a second terminal at the checkout root, start Vite:

```bash
BACKEND_PORT=8010 npm run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

Open <http://127.0.0.1:5177/>.

Ports in this isolated example (script defaults remain unchanged):

- Backend API: <http://127.0.0.1:8010>
- Vite frontend: <http://127.0.0.1:5177>

### Windows hot reload

Complete the isolated Windows setup in [Quick start](QUICK_START.md) first,
including **all seven library/credential variables**. In that same backend shell:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8010
```

A second PowerShell terminal in the same checkout runs only the frontend:

```powershell
$env:BACKEND_PORT = '8010'
npm run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

Set `BACKEND_PORT` in the **Vite terminal** so `/api` and `/media` do not reach a
daily 8000 instance. `--strictPort` avoids silently moving to an unapproved origin.
For another frontend port, explicitly allow its exact origin using
`IMAGE_PROMPT_LIBRARY_DEVELOPMENT_ORIGINS` in the backend shell. Do not use a wildcard
or disable Origin checks. Hot reload is for isolated development, not a live library.

## Configuration

For persistent settings, copy `.env.example` only when `.env` does not exist;
otherwise edit it without replacing existing values:

```bash
[ -f .env ] || cp .env.example .env
```

The POSIX scripts read supported `.env` entries as literal `KEY=value` data; they do not execute shell syntax or expand quotes, variables, or command substitutions. Write paths and values directly, including spaces when needed. `scripts/dev.sh` is also available after reviewing `.env`: its auth/config entries can override shell values. The direct `uvicorn` examples above avoid that source of accidental configuration reuse.

Important settings:

```bash
IMAGE_PROMPT_LIBRARY_PATH=./.local-work/dev/library
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8010
FRONTEND_PORT=5177
BACKUP_DIR=./backups
```

`IMAGE_PROMPT_LIBRARY_PATH` controls where your private database and images live. The default `./library` is repo-local and intentionally ignored by git. For long-term personal use, you may prefer a durable path such as `~/ImagePromptLibrary`.

These `.env` loading rules apply to the POSIX helper scripts. When launching
`python -m uvicorn` directly, set environment variables in that shell; the backend
does not automatically load the checkout's `.env` file.

## Data layout

Runtime data lives under `IMAGE_PROMPT_LIBRARY_PATH`:

```text
library/db.sqlite       SQLite metadata and full-text search index
library/originals/      original uploaded/imported images
library/previews/       generated preview images
library/thumbs/         generated thumbnail images
library/generation-results/       generated results awaiting or retaining review
library/generation-references/    library-owned copies used by generation jobs
```

Do not commit runtime `library/` data to git. It is your private prompt/image collection.

## Add your own prompts and images

1. Start the app.
2. Click `+ Add`.
3. Add a title, prompt text, collection, optional tags, and a required result image.
4. Save the card.
5. Use Explore/Library, search, filters, and detail view to browse and copy prompts later.

For the current Gallery generation composer and Agent conversations, see
[Playground workspaces](PLAYGROUND.md). [The older generation guide](GENERATION.md)
describes OAuth generation; API-key profiles are documented in
[API connections](API_CONNECTIONS.md), [OpenAI compatibility](OPENAI_COMPATIBLE.md)
and [native Gemini/Seedream image protocols](NATIVE_IMAGE_PROVIDERS.md).

## Portable backup and safe restore

Stop the app, then create a timestamped backup archive:

```bash
./scripts/backup.sh
```

Installed Windows, macOS, and Linux releases use the same engine through:

```bash
image-prompt-library backup
image-prompt-library verify-backup /safe/place/backup.tar.gz
image-prompt-library restore /safe/place/backup.tar.gz --yes
```

The backup includes:

- `library/db.sqlite`
- `library/originals/`
- `library/thumbs/`
- `library/previews/`
- `library/generation-results/`
- `library/generation-references/`

The archive uses a fixed `manifest.json` plus `library/...` layout with per-file sizes and SHA-256 checksums. Before creating it, the command applies the same credential-path boundary as application startup, refuses an auth/config path inside the library, and rejects unsafe library paths, links, or non-regular payload files. App-owned OAuth credentials, provider config, and device-login/session state stay outside the archive by construction.

This is an allowlist, not a content scrubber. Prompts, notes, generation history, and images deliberately stored in the library are included; do not put secrets in library content.

Stop the app before backup or restore. Restore validates and stages the complete archive before replacing the active path, preserves the previous library as a sibling, and rejects the former manifest-less `backup.sh` format instead of guessing how to import it.

See [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md) for the exact payload, credential boundary, commands, failure behavior, and non-goals. Keep backups somewhere outside the repo and outside the active library if the library matters to you.

## Database and request lifecycle

`backend.db.connect()` returns a SQLite connection, not a generator. Use
`with connect(library) as conn:` for an owned transaction scope: normal exit
commits, exceptional exit rolls back, and the outermost scope closes the handle,
including when commit fails. Do not return a live cursor or use the connection
after leaving that scope. Nested scopes retain SQLite's existing transaction
semantics; they do not create savepoints. Direct callers still own `close()`;
`contextlib.closing()` alone does not commit pending work. Helpers borrowing a
caller's connection must not close it or start another ownership scope.

An Agent stop is claimed against the current durable request state under a write
transaction. A completion, known failure or local-result-recovery receipt that
commits first is retained; a stop that commits first retains its stopped state
and existing dispatch guards. Child cancellation remains conditional and cannot cancel an already successful
image. This does not promise that a request already sent to a supplier is cancelled
or unbilled. Local-result repair continues to use the original task without a new
supplier request.

## Tests and contribution workflow

Run commands from the checkout root using the prepared interpreter, with the
isolated paths above still set. No real provider credentials are needed:

```bash
.venv/bin/python -m pytest -q tests/test_api_connection_drafts.py tests/test_model_catalog.py
npm run test:frontend
npm run build:extension
npm run test:extension
npm run build
```

On Windows use `.\.venv\Scripts\python.exe` instead of `.venv/bin/python`.
For documentation changes:

```bash
.venv/bin/python -m pytest -q tests/test_readme_contract.py tests/test_quickstart_deployment_docs.py
```

`python -m pytest -q` is the full backend suite. It includes platform installer,
subprocess and environment tests: run those in an isolated VM/CI runner, not on a
daily Windows profile whose PATH must remain unchanged. The exact full jobs are in
[CI](../.github/workflows/ci.yml); mocks do not verify supplier quality or billing.

For the static demo, use `npx tsc` followed by
`npx vite build --mode demo --base /`, output `frontend/dist`.
This needs no Python backend or credentials. The existing `npm run build:demo`
targets `/image-prompt-library/` for GitHub Pages, not a root-domain deployment.
A demo build replaces the ordinary frontend output: run `npm run build` again
before using a full local app. For real HTTP/UI checks with mock providers use
[the offline Agent preview](AGENT_PREVIEW.md), not a personal library.

See [CONTRIBUTING](../CONTRIBUTING.md) for local and final validation, and
[AGENTS.md](../AGENTS.md) for the authoritative Draft PR, trial and merge workflow.
