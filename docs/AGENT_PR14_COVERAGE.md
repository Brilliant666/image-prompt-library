# PR #14 coverage in the Agent integration branch

This is a source and regression-test comparison, not a recommendation to merge or close either pull request. PR #14 remains independently open.

## Compared revisions

| Revision | Observed state | Commit |
| --- | --- | --- |
| PR #14 (`codex/collection-editor`) | Open, not Draft; base `main` | `90f69316bf42e3eda8ffda90da1339a2ae0ed374` |
| PR #14 base | `main` at comparison time | `efdba43cce3032ea7dfbda3d25d09166a5753741` |
| PR #15 before documentation CI repair | Agent integration baseline | `eb4947e59fd3ba0da62532daf154d3bae2f5cb8a` |
| PR #15 after documentation CI repair | Research branch starting point | `594a11639c6191d266e10836f1a08ada261e12e2` |

The comparison examined every path changed by PR #14, compared the actual file blobs, and read the later differences. Commit ancestry alone was not used as proof that a fix was incorporated. The documentation repair changes README contracts and their tests; it does not change the product files considered below.

Of PR #14's **41 changed files**, **33 are byte-identical** in the Agent integration baseline and **8 have subsequent changes**. No unabsorbed PR #14 repair was identified within these 41 files. This conclusion covers the reviewed implementation and tests; it does not claim that every browser, operating system, or production workload has been exercised again.

## Feature and test mapping

Paths below are relative to the repository root. Line references describe the compared Agent integration baseline.

| PR #14 behavior | Implementation evidence in PR #15 | Regression evidence | Result |
| --- | --- | --- | --- |
| Searchable Collection selection, stable IDs, explicit creation and Unassigned | `frontend/src/components/CollectionPicker.tsx`; editor integration in `ItemEditorModal.tsx` | `tests/frontend-collection-picker.test.mjs`, `tests/frontend-editor-drop.test.mjs` | Incorporated; both implementation files and test files are identical |
| IME composition must not move search focus or consume candidate keys | `CollectionPicker.tsx:52`, composition lifecycle handlers at lines 88–89 | Composition lifecycle and close/reopen tests in `frontend-collection-picker.test.mjs:189` and `:207` | Incorporated; synthetic event regressions pass; actual system IME was not retested |
| Retry after partial upload must not delete acknowledged images | `ItemEditorModal.tsx:227` onward, persisted item/readback reconciliation and pending-file handling | Partial upload, rollback failure, reorder and removal regressions in `frontend-editor-drop.test.mjs:620`, `:650`, `:707` | Incorporated, tests pass |
| A → B saved partially → A retry must save A against the latest acknowledged prompt state | `ItemEditorModal.tsx:243` compares against `currentItem.prompts`, not the initial prop | Multilingual retry cases at `frontend-editor-drop.test.mjs:583`; unchanged-latest-state case at `:610`; image-order failure case at `:677` | Incorporated, tests pass |
| Model, source URL and notes can be explicitly cleared | Update payload in `ItemEditorModal.tsx:257–259` | Editor component callbacks plus API update regressions | Incorporated; editor file is identical |
| Archiving the last visible Collection item preserves its category and metadata | `backend/repositories.py:123–125` removes only truly unreferenced Collections; archival updates at `:304` and `:332` | `tests/test_items_api.py:822`, both single and batch archive/unarchive | Incorporated, tests pass |
| Late gallery submission receipts preserve newer drafts, models and attachments | `frontend/src/components/gallery/InputBar.tsx:133–141`, captured edit revision | `tests/frontend-gallery.test.mjs` receipt/revision cases, including model edits at `:335` | Incorporated; later Agent bridge does not remove this protection |
| Persisted reference drafts regain verified previews without replacing newer edits | `InputBar.tsx:59–68`, original-reference hydration guarded by initialization/edit ownership | `frontend-gallery.test.mjs:661`, `:726`, `:740`, `:754` | Incorporated, tests pass |
| Background shutdown drains Agent, generation and organizer work before releasing the library lease | `backend/main.py:123–175`; generation queue closing/draining implementation | `tests/test_generation_queue_shutdown.py`, `tests/test_agent_workspaces.py` | Incorporated; shutdown code is identical, regression suites pass |
| Library and Explore can browse past 1,000 items using bounded pages | `frontend/src/hooks/useItemsQuery.ts`; deterministic backend ordering in `backend/repositories.py` | `tests/frontend-items-pagination.test.mjs`, `tests/test_items_pagination.py` | Incorporated, tests pass |
| Refresh retains the complete loaded window and rejects stale responses | `useItemsQuery.ts:31–119` | Window refresh, partial failure and >1,000 refresh tests in `frontend-items-pagination.test.mjs` | Incorporated, tests pass |
| Shared sort, arrangement and gallery status controls; clearable Collection search scope | `ToolbarSelect.tsx`, `ScopeHeader.tsx`, `SearchScope.css`, `App.tsx`, gallery toolbar | `frontend-toolbar-select.test.mjs`, `frontend-search-scope.test.mjs`, `explore-view.test.mjs` | Incorporated; subsequent App changes are additive Agent integration |
| Immediate view switching with independent scroll restoration and stale callback guards | `App.tsx` navigation implementation; retained workspace rendering | `tests/frontend-view-navigation.test.mjs` | Incorporated, all seven navigation cases pass |
| Horizontal Library cards keep stable parents while hidden; responsive image geometry and sparse Collections | `CardsView.tsx`, `ItemCard.tsx`, `utils/images.ts`, stylesheet | `frontend-library-layout.test.mjs`, responsive image cases in `explore-view.test.mjs` | Incorporated; product files are identical |

## The eight evolved paths

These paths are not byte-identical, so their changes were inspected individually:

| Path | Subsequent change | Effect on PR #14 coverage |
| --- | --- | --- |
| `frontend/src/App.tsx` | Adds Agent profile focus, gallery handoff command, and image settings state/callbacks | Existing navigation and Collection search behavior remains |
| `frontend/src/components/gallery/GalleryWorkspace.css` | Adds Agent source-link styling and footer wrapping | Does not replace the shared toolbar/theme rules |
| `frontend/src/components/gallery/GalleryWorkspace.tsx` | Routes native Agent results through explicit reference/conversation handoff and passes settings callbacks | Existing filtering, cache, receipt insertion and detail-sequence guards remain |
| `frontend/src/components/gallery/InputBar.tsx` | Reports validated image settings and routes native results to Agent | Draft edit revisions, reference restoration, frozen transport and receipt guards remain; no credentials or transport overrides are copied to Agent |
| `package.json` | Adds Agent test files and Markdown math dependencies | All PR #14 frontend test entries remain enabled |
| `tests/explore-view.test.mjs` | Updates configuration-drawer focus expectations to the new focus helper and transition-end behavior | Existing Collection/layout/navigation cases remain |
| `tests/frontend-gallery.test.mjs` | Adds bridge imports and component dependency stubs | No prior test assertions are removed |
| `tests/test_agent_workspaces.py` | Expands local mock provider response metadata/streaming support; unauthorized-image test now permits the read-only skill tool | Image authorization cannot be bypassed; original shutdown and stop protections remain tested |

The other 33 paths have identical Git blob IDs. This includes the Collection editor and picker, repository/archive behavior, lifecycle shutdown, pagination hook, retained card layout, toolbar components, and their dedicated regression files.

## Reproduction and local validation

Check live PR state again before making merge decisions:

```sh
gh pr view 14 --repo Brilliant666/image-prompt-library \
  --json state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid
git diff --name-only efdba43cce3032ea7dfbda3d25d09166a5753741 90f69316bf42e3eda8ffda90da1339a2ae0ed374
git diff 90f69316bf42e3eda8ffda90da1339a2ae0ed374 eb4947e59fd3ba0da62532daf154d3bae2f5cb8a -- <path>
```

For each changed path, compare `git rev-parse <revision>:<path>` at both heads to distinguish identical blobs from evolved implementations.

The following suites ran on the isolated source checkout, with mock providers and temporary test libraries:

```sh
node --test tests/frontend-collection-picker.test.mjs tests/frontend-editor-drop.test.mjs tests/frontend-items-pagination.test.mjs tests/frontend-library-layout.test.mjs tests/frontend-search-scope.test.mjs tests/frontend-toolbar-select.test.mjs tests/frontend-utils.test.mjs tests/frontend-view-navigation.test.mjs tests/explore-view.test.mjs tests/frontend-gallery.test.mjs
```

Result: **352 passed, 0 failed, 0 skipped**.

```sh
python -m pytest tests/test_compatible_integration.py tests/test_generation_jobs.py tests/test_generation_queue_shutdown.py tests/test_items_api.py tests/test_items_pagination.py tests/test_agent_workspaces.py -q
```

Result: **293 passed, 10 skipped**. The existing skip paths are symlink-creation checks unavailable in this Windows environment (`symlink_or_skip` in `test_generation_jobs.py` and the symlink check in `test_items_api.py`). They are not newly added skips and are not reported as passing path-safety checks. The test run also emitted one existing Starlette/httpx deprecation warning.

Additional Agent checks:

```sh
node --test tests/frontend-agent-core.test.mjs tests/frontend-agent-progress.test.mjs tests/frontend-agent-scroll.test.mjs tests/frontend-agent-gallery-bridge.test.mjs
```

Result: **72 passed, 0 failed, 0 skipped**. In particular:

- Sending is blocked while the selected conversation has not loaded; failed loading retains the draft rather than silently creating another conversation.
- Confirming an uncertain submission consumes its one-request permissions. A later draft or explicitly renewed permission is preserved using the original send boundary.
- Stream failure falls back to read-only polling; stale events do not resubmit an execution request.
- A single bottom-scroll action follows delayed image geometry; upward reading and branch focus cancel inappropriate automatic following.
- Gallery handoffs preserve drafts and reject missing, incompatible, stale or over-capacity references.

These are production component callback/hook regressions with controlled browser APIs, not a new real-browser or real-provider acceptance run. No paid API, personal library, provider key, or running application was used. The previous PR descriptions' browser results were not treated as fresh evidence.

## Remaining boundary

No additional PR #14 patch needs to be cherry-picked on the evidence above. PR #14 should still be reviewed and closed or merged only under explicit authorization; this comparison performs neither action. It does not establish that the broader Agent execution, cost, cache or context risks are resolved. Those are separate from absorbing the Collection/editor/navigation fixes.
