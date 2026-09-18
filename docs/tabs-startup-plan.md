# Tab closing and startup improvement plan

- **Created:** 2026-09-18 06:32:37 UTC+10:00 (actual system clock, captured during audit).
- **Plan status:** Needs decisions.
- **Implementation status:** Core + T6 done; native manual checks pending.
- **Inspected Git HEAD:** `5dd48b7bbbceff9948dd064b6bc190fcfc818ecf` — Add an in-app updater, and bump to 1.1.0.
- **Working tree before this document:** clean; `git status --porcelain=v1` returned no entries. No pre-existing uncommitted changes were present.

## Scope and goal

Audit the tab/window lifecycle, the brief startup flash, and closely related correctness risks. Produce one actionable plan, not an implementation. Preserve fast startup, browser/standalone support, existing saved paths and unrelated work.

This is a Tauri 2 desktop viewer with a shared JavaScript frontend, not an editor. Source files are `src/main.js`, `src/index.html`, `src/app.css`, `src-tauri/src/main.rs` and the Tauri configuration. `build.mjs` produces both packaged assets and a standalone HTML file. Installed dependencies and existing build outputs were inspected; they were not changed. Global agent guidance was supplied; the bounded project/ancestor guidance searches found no additional applicable AGENTS.md file.

## Executive findings

1. **There is a real close-related race.** A file read already underway can finish after its tab closes or after you switch tabs. It can put the old file's text into the newly active tab. The affected text is in memory; no write to the Markdown files was found.
2. **Closing the last tab currently leaves an empty window.** That is confirmed behaviour, not automatically a bug. Closing a native window is a different action. Whether the last tab should close its window needs Q1.
3. **Closing the main window preserves its tab list for next launch.** Closing individual tabs removes their paths from that list. Whether window close should forget those paths needs Q2.
4. **External file opening is broadcast to every window.** With several windows open, one double-click can open the same file more than once.
5. **Three startup transitions could explain the flash:** native background before the page appears; the saved theme being applied after the bundle runs; and the welcome screen appearing before a restored file. Only the code paths are confirmed. The visible flash and its timing have not been recorded.
6. No native file-watcher leak was found. Each window polls only its active document every 700 ms. Other open native windows can legitimately keep the app running; this is not proof of a leaked process.

## Evidence and verification standard

Three independent scouts inspected tab closing, startup, and adjacent correctness/security areas. Separate reviewers re-opened cited code and callers. Corrected claims and newly identified candidates received a further focused recheck. One startup reviewer invocation failed; a replacement completed the review. Findings below distinguish inspection from execution.

**Checks actually run:**
- `git rev-parse HEAD` and `git status --porcelain=v1`: commit recorded above; tree clean before writing.
- `node --check src/main.js`: passed syntax checking.
- `node --check build.mjs`: passed syntax checking.
- A temporary, in-memory Node `vm` check extracted the actual `reloadNow` function from source and supplied mocked native file calls. Started reading A, changed active state to B, completed A's read: B's text became A's text. Assertion confirmed the defect, not a passing application behaviour.
- A second in-memory check extracted actual `openPath`, supplied mocked native calls, and concurrently opened `same.md` twice. Two tab objects were created. Assertion confirmed the duplicate-open defect.
- Both reproductions used standard Node modules, created no files, and accessed no external systems.

**Not run:** frontend build, Cargo build/check, installed-app launch, browser UI tests, native close/process checks, performance measurements, updater network calls or security probes. There is no test script in `package.json`. Existing `dist` sizes are observations of pre-existing output, not proof that those files exactly match HEAD. Syntax checks and mocked execution do not establish native runtime behaviour.

## Prioritised findings

### F1 — P1: unfinished reloads can update the wrong tab

- **Evidence:** `src/main.js:1018–1024` (`stopWatch`) clears future interval ticks only. `1038–1065` (`pollNative`, `pollHandle`) and `1082–1100` (`reloadNow`) use global `state` after awaits. `819–840` (`setDoc`) assigns `state.text` and updates shared document DOM. `1286–1308` and `1310–1333` can replace active state while these calls wait.
- **Trigger and consequence:** read A; switch to B or close A; finish A's read. The callback can change B's text/mtime, repopulate the empty viewer, reset another tab's watch failures or show a stale reload message. An old failing read can also affect the new watcher through shared error counters. Interval ticks can overlap when reads take longer than 700 ms.
- **Expected:** results, errors and indicators belong to the document and watch session that started the work. Closing/switching invalidates outdated work; newer content must not be replaced by older completions.
- **Impact:** misleading displayed document and live-reload state; no demonstrated disk-file modification.
- **Review:** Confirmed. High confidence. Manual-reload miswrite reproduced with actual function and mocked IPC; polling/error variants inspection-only.

### F2 — P1: one external open is delivered to multiple windows

- **Evidence:** `src-tauri/src/main.rs:111–118` calls `app.emit("open-file", path)` and separately focuses `main`. `src/main.js:1536–1551` registers the listener in every Tauri window. `927–975` can open a tab or spawn another window depending on settings.
- **Trigger:** main and a `doc-*` window exist; another file is opened through the OS association.
- **Observed versus expected:** all subscribed windows handle it; one intended recipient should handle it once. With “new window” selected, multiple recipients may each create another window.
- **Impact:** duplicate documents/windows and confusing close behaviour. Simply restricting handling to `main` would drop requests when main has closed but another window survives.
- **Review:** Confirmed, high confidence, inspection-only. Native single-instance event delivery still requires execution testing.

### F3 — P2: concurrent native opens bypass duplicate detection

- **Evidence:** `src/main.js:927–951` checks `tabs.find(...)` before file-read/stat awaits, then pushes without checking again. Independent open callers exist at `1537–1549`.
- **Trigger:** two overlapping requests for the same path finish before either sees an existing tab.
- **Observed versus expected:** two tabs for one path, despite the explicit “never open the same file twice” comment; within-window opens should share the existing tab.
- **Impact:** apparent extra copies that must be closed separately. Completing an explicit open and focusing its tab is not itself classified as a bug.
- **Review:** Confirmed after narrowing a broader race claim. High confidence; reproduced with actual function and mocked IPC.

### F4 — P2: close shortcuts are skipped inside text inputs

- **Evidence:** `src/main.js:1473–1486` returns for input/textarea/editable targets before Ctrl+W/Ctrl+Shift+W handling. `1200–1206` focuses the Find input.
- **Trigger:** Find is focused, then the user presses a close shortcut.
- **Observed versus expected:** the application skips its configured close action and does not prevent the browser/native default. Close controls should follow the configured scope regardless of Find focus.
- **Impact:** apparently unresponsive or inconsistent shortcuts. The native/browser fallback action is platform-dependent, not established here.
- **Review:** Confirmed routing gap, high confidence, inspection-only. Do not describe all platforms as doing nothing.

### F5 — P2: last-tab cleanup leaves old Find results

- **Evidence:** `src/main.js:1112–1137` retains matched nodes in `findMarks`; `clearFind` releases them. `1310–1327` clears the last document but does not reset those results or the match display. Normal tab activation reruns Find at `1307`.
- **Trigger:** search a document, then close the final tab.
- **Observed versus expected:** old match count and references remain despite an empty document; there should be zero document matches and no retained old matches.
- **Impact:** stale search UI and avoidable retention of detached document nodes until another search/Find close/window destruction. Not evidence of a permanent native memory leak.
- **Review:** Confirmed, high confidence, inspection-only.

### F6 — P2: wrong-shaped saved paths can interrupt startup

- **Evidence:** `src/main.js:191–194` catches JSON parsing failures; `1652–1655` assumes `openTabs` is iterable and its entries support `toLowerCase()` when an initial file exists, outside the per-file catch.
- **Trigger:** valid JSON of the wrong shape, for example an object instead of an array, or `[null]` while launching a file.
- **Observed versus expected:** boot can reject before restoring/opening remaining files. Invalid saved values should be ignored while valid paths and the requested launch file still work.
- **Impact:** startup recovery failure. No ordinary app write path producing these invalid values was identified, so this is defensive hardening rather than evidence of frequent user corruption.
- **Review:** Corrected from “JSON handling is safe”, then rechecked and Confirmed. High confidence in the conditional path; inspection-only.

### F7 — P2: startup appearance is established too late to rule out flashing

- **Evidence:** `src-tauri/tauri.conf.json:22–32` has no explicit background/readiness gate. `src-tauri/src/main.rs:122` uses the default window-state plugin. Installed plugin 2.4.1 source (`src/lib.rs:62–65,179,227,262–264,407–429`) includes visibility restoration and can show a configured-hidden window, even without a saved entry.
- **Theme:** `src/index.html:2` starts without a saved theme. `src/app.css:2–4,45–71,95–97` initially uses light or OS-dark background. Saved theme is applied in `src/main.js:1391–1396,1624` after deferred bundle evaluation. Saved dark on a light OS can therefore pass through a light state.
- **Content:** `src/index.html:77–94` starts with visible welcome content; `src/app.css:208–213` hides it only when marked gone. Boot awaits file work at `src/main.js:1630–1666`; `setDoc` and `showActiveTab` hide the welcome screen after rendering (`819–824,1295–1297`). Restored paths are opened/rendered sequentially.
- **Expected:** the initial appearance should match the intended theme and avoid a misleading welcome transition, without artificial startup delays.
- **Review:** Corrected and rechecked: these are confirmed ordering/configuration facts, not a reproduced flash. High confidence in pathways; medium confidence in their contribution to the reported flash. Visible cause and speed effect remain Unresolved until runtime measurement.
- **Build facts:** `build.mjs:48–65` emits render-blocking CSS and deferred JS, not async CSS. Existing assets: app.js 506,382 bytes, CSS 17,741 bytes, Mermaid 3,450,740 bytes. Mermaid is loaded by a script tag only when needed (`src/main.js:67–90`); do not make it eager. Updates are delayed three seconds after boot (`1693–1697`). No timing benefit or regression has been measured.

### F8 — P3: an obsolete update offer can remain on screen

- **Evidence:** `src/main.js:333–344` shows the update bar for an available update, but a later no-update result clears `pendingUpdate` without hiding the bar. `353–354` then makes its install button return immediately. Manual checks are wired at `1601`.
- **Trigger:** an earlier check offers an update and a later manual check reports none.
- **Expected/impact:** clear the old offer along with its state; otherwise the user sees a button that does nothing.
- **Review:** Corrected from a blanket “update flow is sound”, independently rechecked and Confirmed. High confidence in the conditional path, inspection-only. No updater network call performed.

## Verified behaviour needing decisions, not automatic fixes

- **D1 — Last tab:** `src/main.js:1310–1357` empties the viewer rather than closing its window. No main/doc-window distinction exists in this branch. Tab ×, middle-click and tab-scoped Ctrl+W converge on it. Whole-window close calls Tauri's window-close API. Q1 controls any change.
- **D2 — Reopen after window close:** `src/main.js:1362–1365,1652–1660` saves/restores only the main window's native file paths. There is no close-request persistence override. Title-bar close and window-scoped shortcuts leave the existing saved list intact; individual tab closing updates it. Q2 controls any change.
- **No watcher leak established:** Rust has one-off read/stat/list/initial-file commands, not a native watcher map (`src-tauri/src/main.rs:27–78`). Window-level JS listeners/timers normally die with the webview; ignored unlisten functions alone do not prove post-close activity. Process exit after the final native window closes is untested.
- **Neighbour selection is correct:** after removing the active tab, `src/main.js:1328–1333` selects its right neighbour, or the left neighbour if it was rightmost. Closing only a background tab leaves active polling state alone.

## Optional and unapproved work — do not include in core

These are bounded follow-ups, not permission to build features or redesign saved state.

- **Browser file identity:** `src/main.js:867–875` reuses tabs by filename, so two separate `README.md` files replace each other's in-memory tab. Confirmed by inspection/reviewer. Browser handles can provide better identity, but plain File objects do not reliably reveal paths. A browser identity policy and targeted browser work should be approved separately; do not invent full paths or treat equal name/size as proof of identity.
- **Browser reopening after close:** `openHandle` persists an IndexedDB handle (`901–908`); boot can reopen it (`1675–1680`) after its tab closed. `lastText` caching occurs only through `setDoc` during reload, not on every initial open (`831–833,867–889,1295–1309`). Corrected and rechecked. Choosing whether browser close forgets resume history is outside the native close choices below; leave browser persistence unchanged pending separate approval.
- **Restore reading position after restart:** positions live only in tab objects (`1280–1301`); persisted native state contains paths only (`1362–1365`). Confirmed optional feature, not a bug fixed by an unload handler. Do not change the saved-data format as part of this plan.
- **Mermaid theme race:** initial async rendering can insert old-theme diagrams if the theme changes before figures exist (`83–129,1399`). Corrected/rechecked inspection-only. It is a visual issue, not cross-tab source corruption; defer unless separately approved.
- **New-window creation uncertainty:** `src/main.js:966–975` resolves creation after three seconds even without a success event. A later creation failure cannot trigger its fallback. Installed API permits delayed rejection; actual delayed failure was not reproduced. Do not replace this with a blind timeout rejection that can create both a late window and a fallback tab. A separate readiness/late-result design is needed if this path is addressed.
- **Security boundary:** asset scope is broad (`src-tauri/tauri.conf.json:13–18`); relative images use `convertFileSrc` (`src/main.js:683–694`); native text-read commands accept arbitrary accessible paths (`src-tauri/src/main.rs:28–43`). Confirmed authority/risk, not a discovered compromise. CSP and sanitisation are important safeguards. Broad asset scope does not by itself prove arbitrary JavaScript fetches are permitted. Narrowing it could break legitimate images outside a document folder; no permission/CSP expansion, exploit development or security redesign belongs in core.
- **No drive-by cleanup:** dead `lastPath`, the unused metadata argument and package `main` entry have no demonstrated effect on supported launch workflows. Leave them alone. Do not add a framework, split the whole main module, add settings, or implement “quit every window” as a workaround for unclear close expectations.

## Implementation tasks

Before editing, each worker must verify symbols and assumptions against the current files and any later Decision records. Line numbers belong to the audited HEAD. Preserve unrelated work. Core approval authorises the core tasks below, not optional items or unresolved decisions.

### T0 — Baseline and regression fixtures (core prerequisite)

- **Owned files:** new `tests/tab-lifecycle.test.mjs` and `tests/startup-state.test.mjs`, if no suitable existing suite has appeared. Append run outcomes only in this plan, not separate logs. Do not change `package.json` just to run Node tests.
- Build a small standard-library test harness around the relevant functions or a minimal testable boundary. Keep mocks explicit; do not duplicate production algorithms and test only the copies. No dependency installation required.
- Cover delayed reads, stale failures, overlapping opens, Find cleanup, focused-input shortcuts and saved-path validation. Stub native calls; never touch real user files/storage in fixtures.
- Record a native startup baseline before appearance changes: same installed/release build, machine and saved-state scenarios; at least ten comparable launches per selected scenario if practical. Record time to visible usable shell separately from time to readable document, and capture the flash visually. Include light/dark OS and opposing saved theme, no file, launch file, and several restored tabs. Record actual results; no invented millisecond target.
- **Dependencies:** none. **Acceptance:** tests expose current bugs; baseline or honest “native timing unavailable” recorded. Absent native evidence blocks claiming a flash fix/no slowdown, not independent race fixes.

### T1 — Make asynchronous tab operations belong to their origin (core)

- **Owned file:** `src/main.js`.
- Capture tab identity, path/handle and an operation/watch generation before starting asynchronous reload work. Invalidate obsolete generations on active-tab change, stop/restart and final close. Check identity, membership and generation before every mutation, render, success/error notification or shared watcher-counter update.
- Prevent concurrent polling from applying out-of-order results, using a small in-flight guard per watch session and/or ordered operation IDs. Coordinate manual reload with polling; a late earlier operation must not replace a newer one. A tab-reference check alone is insufficient if the user switches A → B → A while A's old read remains outstanding.
- Preserve existing foreground-only polling, 700 ms interval and atomic-save failure tolerance. Do not add background tab watchers or physical cancellation claims for IPC that cannot be cancelled; safely ignore obsolete results.
- Prevent duplicate same-path opens after asynchronous work: recheck at the commit point or share an in-flight open operation. Preserve existing case-insensitive native comparison and explicit-open selection behaviour. Do not “fix” this by moving code after `setDoc`: `openPath` does not call it.
- **Shared expectations:** document mutations go through the active-session guard; T2/T5 must use the same invalidation path. **Dependencies:** T0 fixtures.
- **Acceptance:** A read cannot change B; final close cannot be undone by a late read; old failures cannot stop B's watcher; A → B → A is safe; rapid reloads preserve newest result; simultaneous same-path opens yield one tab; current-tab reload still preserves scroll and restarts watching appropriately.

### T2 — Correct local close cleanup and keyboard routing (core)

- **Owned file:** `src/main.js`.
- Handle Ctrl/Cmd+W and Ctrl/Cmd+Shift+W before the text-input exclusion, following existing modifier conventions and `closeScope`. Preserve normal input editing, Escape and unrelated shortcut behaviour; check the browser can intercept the intended key on each target platform.
- Reset document-bound Find results/count/navigation before clearing the final document. Keep the Find panel's open/closed preference unchanged; if it remains open, show no stale matches. Ensure empty-view geometry and title are refreshed through existing functions as necessary, without unrelated layout changes.
- Keep last-tab and window-reopen semantics unchanged unless Q1/Q2 are explicitly answered.
- **Dependencies:** T1 invalidation contract. **Acceptance:** focused Find respects both close scopes; last-tab empty state contains no old results; active/background tab neighbour behaviour remains correct; no leftover old render callback visibly revives content.

### T3 — Deliver each external open to one live recipient (core)

- **Owned file:** `src-tauri/src/main.rs`; coordinate any frontend event contract change through the sole `src/main.js` writer in T4/T5.
- Replace app-wide delivery with one explicit destination. Prefer `main` when present; otherwise choose one live document window using a stable existing-label order. This is routing, not a new session owner: preserve main-only saved-list ownership.
- Focus/unminimise the selected recipient, not always the missing `main`. Preserve event name and path payload where possible so frontend changes are unnecessary.
- Verify startup/listener readiness and recipient-close races. If a new recipient must be created, deliver through its existing initial-file URL/readiness path rather than emitting before it subscribes. Do not add silent dropping or send the same request to multiple windows as a fallback.
- **Dependencies:** T0; shares native file ownership with any later startup window handling, so those edits cannot run concurrently.
- **Acceptance:** one external file-open request produces one handling operation with one or several windows; “new tab” and “new window” settings both work; closing main while a document window remains still permits opening another file once. Repeated events remain distinct requests; T1 handles same-path overlap inside a recipient.

### T4 — Recover malformed saved paths and clear obsolete update UI (core)

- **Owned file:** `src/main.js`.
- Validate `openTabs` as an array of non-empty strings before looping/comparing. Retain valid paths, tolerate bad entries, and still open the launch file. Do not erase unrelated preferences, migrate formats or silently rewrite valid data.
- When an update check establishes no available update, clear the stale offer UI alongside `pendingUpdate`. Preserve install-in-progress guards and existing failure behaviour.
- **Dependencies:** after T2 because of shared source ownership. **Acceptance:** object/null/mixed-array fixtures cannot abort boot; valid paths still restore; a prior offered update followed by “none available” leaves no non-working offer; no real network is needed for fixture verification.

### T5 — Remove avoidable startup transitions without an artificial wait (core, evidence-gated)

- **Owned files:** `src/index.html`, new `src/startup.js` if needed, `src/app.css`, `build.mjs`, `src/main.js`; only if native background/show control proves necessary, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`.
- Apply the saved theme in a tiny synchronous early bootstrap, before body rendering/heavy application bundle evaluation. Read the same existing `mdv.theme` storage format with failure guards; support auto/light/dark, storage-denied and invalid-value cases. Share this resolution logic with later appearance setup rather than maintaining conflicting theme algorithms.
- Follow the existing dual-output build: external local bootstrap for packaged assets; inline equivalent in standalone HTML. Do not weaken CSP. Tauri can inject hashes/nonces into packaged scripts, but the existing external-script pattern avoids needing a new policy exception.
- Measure whether the reported flash remains. Avoid arbitrary sleeps, splash screens or holding back the window until all restored files, diagrams, images or update checks finish. Preserve deferred app JS and lazy Mermaid.
- If the visible cause is the welcome screen during restoration, suppress only that transient message while startup determines whether a file will open; keep the shell usable. Always restore the normal empty view when no file exists or loading fails. Do not change saved-tab order/selection or introduce a new restore format merely to hide the transition.
- If a native pre-paint flash remains confirmed, match native/webview background to the actual resolved appearance where the installed APIs allow it. A fixed dark background is not a complete solution for light users. A hidden-start/show handshake is a last resort, not the first fix: exclude only visibility from window-state restoration while retaining geometry, cover all window creation paths, add a failure-recovery show path, and do not depend solely on `requestAnimationFrame` while hidden. Review narrowly required show permission if invoked from JavaScript.
- **Dependencies:** T0 measurements; T1–T4 source contracts; T3 before any shared Rust changes. **Acceptance:** theme matches from first visible content in light/dark/auto cases; normal no-file welcome remains available; packaged and standalone outputs work; secondary windows and load failures do not stay hidden; recorded paired timing/captures support no meaningful startup slowdown. Do not claim “zero cost” without measurements. If native checks are unavailable, stop after independently verifiable early-theme work and record remaining flash work as blocked.

### T6 — Apply approved closing behaviour (decision-gated, not implied by core approval)

- **Owned files:** `src/main.js`; `README.md` for the resulting close/session explanation. Recheck native close APIs/permissions before editing; use native code only if required by the supported close-event path.
- **Q1 A:** retain the final empty window; no window-lifetime change. **Q1 B:** after final-tab cleanup and persistence, close only that native window; surface failure without leaving inconsistent tab state. Never try to close the user's browser tab from standalone/browser mode.
- **Q2 A:** preserve main-window path restoration. **Q2 B:** clear only the main window's saved open-path list on a successful intentional window close, consistently for title-bar and application shortcuts. Do not clear it if a close is cancelled/fails; verify supported native close lifecycle. Do not delete Markdown files or global settings. Define crash/forced-kill and updater-restart behaviour honestly: they are not guaranteed clean-close events and must not accidentally change under this choice.
- If both answers are B, final-tab close must persist the empty list before closing, using the same cleanup/invalidation path. Neither answer authorises quitting other windows, changing browser resume history or giving secondary windows ownership of the restore list.
- **Dependencies:** explicit answers for the respective branches; T1/T2; coordinate with T5 if it changes native window lifecycle. Unanswered branches pause independently.
- **Acceptance:** selected options match the worked examples below; window ×/shortcuts agree; other windows remain usable; saved paths follow the answer; no user document is changed; final native window/process exit is checked on Windows rather than assumed.

### T7 — Combined verification and completion record (core)

- **Owned files:** regression tests and `README.md` only for implemented behaviour; append this plan's Implementation record. No unrelated documentation cleanup.
- Run checks below, inspect final diff and record any partial/blocked outcome. Do not mark an unexecuted native check passed.
- **Dependencies:** implemented T1–T5 plus answered T6 branches. Unanswered decisions do not block verification of independent core work.

## Parallel execution batches

One writer per file per batch, including tests, documentation and generated `dist`/Cargo output. Different files can still have interface dependencies.

1. **Batch A:** T0 owns tests and captures baseline. A read-only native routing investigator may prepare T3 assumptions alongside it; no separate planning deliverable.
2. **Batch B:** T1 → T2 → T4 in sequence under one `src/main.js` owner. T3 may run in parallel under one Rust owner, preserving `open-file` payload/interface. Separate writers must not modify shared tests simultaneously.
3. **Batch C:** T5 after the frontend/native contracts settle. Its bootstrap/build/source edits are one coordinated work unit. Do not concurrently run T6 against `src/main.js` or the native lifecycle files.
4. **Batch D:** answered branches of T6, then T7. If unanswered, skip those behaviour changes and finish core verification. One owner performs build generation; no overlapping build/test processes writing the same output directories.

## Final combined verification, in dependency order

Commands below are for the implementation run, not claims that this audit ran them. Builds write output/cache and must be run only within implementation permission; do not install dependencies or contact update services without separate permission.

1. Record current `git status --porcelain=v1`, HEAD and applicable guidance; preserve new unrelated edits. Confirm explicit answers from Decision records/chat before T6.
2. `node --check src/main.js`, `node --check build.mjs`, and `node --check src/startup.js` if added.
3. `node --test tests/tab-lifecycle.test.mjs tests/startup-state.test.mjs` once T0 creates those files. Tests must use mocks and isolated fixture state, not a real user's IndexedDB/localStorage or files.
4. `npm run build`. Inspect both `dist/index.html` and `dist/Markdown Viewer.html`: no unreplaced markers, bootstrap before content, external packaged script under current CSP, standalone has no new required sibling. Build output is generated, never hand-edit it.
5. If Rust/config/capabilities changed: `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline` with a 120-second initial wall-clock timeout. Cache/dependency absence is a blocker, not permission to fetch/install. Increase timeout only with an explicit reason; timeout is a failed check.
6. Use an existing native test build or permitted `npm run app:build` for desktop validation. For startup timing use comparable release builds, not development hot reload. Inspect Tauri config/capabilities with the actual installed CLI/build; Node parsing alone is insufficient.
7. UI matrix: open A/B/C; close active/middle/background/rightmost/last; Find matches then last close; shortcut with Find and settings input focus; both existing close scopes; late read after close; repeated same-path open; main plus two document windows; OS file open with main present and absent; unreadable files/atomic editor saves. Check no unexpected surviving native window/process after the final window is actually closed. Do not confuse an intentionally empty window with a leaked process.
8. Restore matrix: zero/one/several saved paths, launch-file overlap, unreadable paths, wrong-shaped mocked storage, normal window close/relaunch, secondary close. Exercise the approved Q1/Q2 combination. Keep real saved-state backups private if needed and avoid printing contents.
9. Startup matrix and paired timings from T0: OS/saved themes matching and opposite; no file/file launch/multiple restores; main/secondary; storage denied; bootstrap/file failure; window-state geometry restoration. Capture first visible appearance and time to usable shell/readable document. No fixed delay or eager Mermaid allowed. If results worsen outside observed run-to-run variation, investigate/revise rather than declare the goal met.
10. Offline mocked updater offer → no-offer check; no automatic real update download/install. Smoke-test Markdown, local images, Find, diagrams and standalone rendering without weakening sanitisation/CSP.
11. `git diff --check`, review `git diff --stat` and full relevant diff. Record commands/results, native checks not run, remaining risks and whether only approved branches were implemented.

## Record-keeping instruction for the implementation AI

Keep this file as the single record. Preserve the original findings, tasks, creation metadata, questions and option labels. Update only **Implementation status** in the original header. Do not rewrite the diagnosis to match the eventual fix.

At each run's end append a short dated **Implementation record** after the original plan: actual timestamp with UTC offset, starting/ending commit or working-tree description, tasks attempted/completed, approved decision sources, tests and results, limitations, partial/blocked outcomes and next steps. Later runs append instead of replacing history. Later `/decisions` runs may append dated Decision records here. The original Plan status describes this audit; later records establish the current answer state.

## Your decisions

**2 open questions.** No explicit answer to either behaviour choice was available in the conversation. The request to investigate closing and preserve startup speed is not approval to change what window close remembers.

1. Should closing the last tab also close its window?
2. Should closing the main window remember its files for next launch?

These are independent. Closing a tab already removes its saved path; closing a whole window currently remembers its remaining native file paths. Neither question asks to close every app window at once.

### Q1 — Should closing the last tab also close its window?

**What you are deciding**

Whether removing the final document tab leaves an empty viewer ready for another file, or closes that native app window. This affects tab ×, middle-click and Ctrl+W when your existing setting says to close a tab. It does not change Ctrl+W when set to close the whole window.

**What happens now**

If a window contains only `Notes.md` and you close that tab, the document disappears but the empty window stays open. Its normal repeating file check stops. A separate bug can let a read already underway put content back; the core plan fixes that whichever option you choose. Closing the actual window is already a separate action. We have not run a native process-exit test. Evidence: `src/main.js:1018–1024,1310–1357`.

#### Option A — Keep an empty window after the final tab closes

**What would happen:** Closing the last tab clears the document and old search results, but keeps that one window open. You can open or drop another file into it. The stale-read bug is still fixed.

**Example:** Start with one window and one tab, `Notes.md`. Close the tab. You now have zero document tabs and one empty window. Use its title-bar × to close the window too.

**Benefits:** Keeps a ready place to open the next file and preserves the existing window behaviour.

**Downsides and consequences:** The app remains visibly open until you close the window separately. If you expected the final tab close to quit that window, this will still feel like an extra step. No document or preference data is deleted. Changing this choice later is a small behaviour change, not a saved-data migration.

#### Option B — Close that window when its final tab closes

**What would happen:** After clearing the final tab and saving the empty tab list where applicable, the app closes that native window. Other app windows stay open. Browser/standalone mode keeps its empty viewer; it will not try to close a browser window.

**Example:** Start with one window and one tab, `Notes.md`. Close the tab. That window disappears. If a second app window contains `Guide.md`, it stays open; this is not “quit all windows”.

**Benefits:** Fits the expectation that closing the last tab finishes that window, and removes the extra empty-window close step.

**Downsides and consequences:** You lose the empty drop target and must reopen the app or use another window for the next file. Native window-close failure and final-process exit need testing. An individually closed native tab is already removed from the main restore list, so this does not make it reopen later. It does not delete its Markdown file. Changing this choice later needs no new saved-data format.

**My recommendation and why**

Option B best matches your concern that closing does not close everything, provided you mean the last tab's window. Its trade-off is losing the ready empty window. Choose A if you often close one document and immediately drop another into the same viewer. Neither choice adds a command to quit all windows.

**What is still uncertain**

We do not know whether you meant tab ×, window ×, a shortcut, or files returning next launch. The code confirms the empty-window behaviour, but native process exit was not measured. Q2 separately covers files returning after whole-window close.

**If you do not answer**

The last tab will continue to leave an empty window. The last-tab window-lifetime branch of T6 pauses. Reload protection, Find cleanup, shortcut consistency, duplicate-open fixes and startup work can continue. No “quit all windows” feature will be built.

**How to answer**

Reply `Q1 A` or `Q1 B`, give your preferred rule in your own words, or ask for more explanation.

---

### Q2 — Should closing the main window remember its files for next launch?

**What you are deciding**

Whether closing the original app window preserves the list of native file paths to reopen next time, or deliberately forgets that list. This affects whole-window close, including title-bar × and window-scoped shortcuts. It does not delete the actual files, close other windows, or change browser resume history.

**What happens now**

Suppose the main window has `Notes.md`, `Guide.md` and `Todo.md`. Closing the whole window leaves those three paths saved, so a later launch tries to reopen them. Closing all three tabs individually instead saves an empty list. Only the original main window owns this list; extra document windows are not separately restored by it. Scroll positions are not saved across launches. Evidence: `src/main.js:1310–1365,1652–1660`.

This can look like things did not close when they actually closed and were then reopened. It is separate from the unfinished-read bug and from other windows remaining open.

#### Option A — Reopen the main window's files next time

**What would happen:** Whole-window close keeps the existing saved path list. Next launch tries to reopen the files that were still tabs in the main window. Individually closed tabs stay removed. Secondary windows and browser history are unchanged.

**Example:** Start with the three tabs `Notes.md`, `Guide.md` and `Todo.md` in the main window. Close that window without closing the tabs first. Launch the app again: it tries to reopen all three, each without a restored reading position.

**Benefits:** Preserves convenient session continuation and current behaviour. Closing the app for a break does not require remembering which files you were reading.

**Downsides and consequences:** Files appear again even if you thought window close meant “forget these”. Their paths remain in the app's saved preferences until the tab list changes. This is not a guarantee that moved/deleted files can be restored. Choosing B later can clear future restore lists but does not alter the files themselves.

#### Option B — Forget the main window's file list on intentional window close

**What would happen:** A successful intentional main-window close clears its saved open-path list. Starting the app normally then shows an empty viewer; opening a file through the OS still opens that requested file. Other preferences remain. A crash or forced process termination is not guaranteed to run normal close cleanup, and secondary windows still do not gain their own restore lists.

**Example:** Start with the same three tabs `Notes.md`, `Guide.md` and `Todo.md`. Close the main window. Launch the app normally: none of those three is automatically reopened. If you instead double-click `Guide.md`, that requested file opens.

**Benefits:** Makes whole-window close mean “finished with these files” and prevents intentional close from restoring an unwanted group next launch.

**Downsides and consequences:** You lose automatic continuation after a normal close and must reopen the files yourself. Clearing the list removes the app's record of which paths to restore; changing back to A later cannot recover that discarded list, although all Markdown files remain untouched. Handling title-bar close, shortcut close, cancelled/failed close and updater-driven restart consistently needs extra native lifecycle testing. This choice does not promise erasure of browser history, other cached data or every trace of a file path.

**My recommendation and why**

Option A is my recommendation unless files returning next launch are specifically what you dislike. It keeps useful existing resume behaviour while the core fixes address actual stale content and duplicates. Choose B if closing the main window should explicitly finish that reading session. B's main cost is losing the remembered list, not losing the documents.

**What is still uncertain**

Your preferred meaning of window close is not stated. Native close cancellation, forced exit and updater-restart paths were not executed during this audit. If you choose B, those paths need checking so failed closes do not accidentally discard the list and an app update does not silently change behaviour beyond the approved intentional-close rule.

**If you do not answer**

Whole-window close keeps remembering the main window's native file paths. The forget-on-window-close branch of T6 pauses; no saved-data clearing is added. All independent core fixes and an explicitly answered Q1 can proceed. Browser resume policy and secondary-window session saving remain unchanged.

**How to answer**

Reply `Q2 A` or `Q2 B`, describe a different rule in your own words, or ask for more explanation.

**Combined reply example — syntax only, not approval or a preselected answer:** `tabs-startup-plan/Q1 B, tabs-startup-plan/Q2 A`.

Recommendations, silence and a generic instruction to implement are not answers. Preserve current behaviour for unanswered questions, pause only the affected work and continue independent approved core tasks.

## Implementation record

### Run ended: 2026-09-18 07:38:52 UTC+10:00

**Overall: Partially complete.** Core implementation and automated checks succeeded; native UI acceptance and remaining evidence-gated startup work are unfinished. Timestamp captured from the system clock at the end of implementation/checks, before saving this record.

- **T0 completed:** isolated standard-library fixtures execute actual frontend source. Baseline `node --test tests/tab-lifecycle.test.mjs tests/startup-state.test.mjs`: 20 passed, 70 expected failures. Native timing/captures unavailable; no installed app or real saved session was accessed.
- **T1 and T4 completed in automated coverage:** session/operation guards prevent stale reloads, failures and overlapping polls from changing another document; duplicate native opens recheck before committing. Saved paths are filtered without changing the format; obsolete update offers disappear. Manual reload samples metadata before reading so a later save is not incorrectly marked already read.
- **T2 implemented, platform acceptance unfinished:** focused-input close routing, Find cleanup, neighbour selection and deferred render guards pass mocks. Actual browser/Windows shortcut interception remains untested. Existing final empty-window behaviour is unchanged.
- **T3 implemented, native acceptance unfinished:** explicit single-recipient targeting, registration/boot readiness, claim-before-open, stable main/document selection and bounded recovery for unclaimed failed delivery. Native unit tests cover selection, revocation, stale claims and repeated paths; frontend mocks cover both opening modes and URL ownership. A close after claim acceptance cannot safely retry an open that may already have created a window. Final-window exit/creation races and OS association delivery still need real Windows execution. Persistent creation/emission failures retain unassigned requests for a later routing message and log errors; no completed display is promised.
- **T5 partially complete:** shared synchronous early-theme bootstrap only. External packaged `startup.js`, inline standalone equivalent, invalid/denied storage guards; deferred app bundle, lazy Mermaid, welcome, CSP and window visibility preserved. Remaining flash diagnosis, welcome/native background changes and paired startup measurements are **blocked by missing native visual/timing evidence**. No flash-fix or no-slowdown claim.
- **T6 both branches paused:** Q1/Q2 remain unanswered. No last-tab window-lifetime or forget-on-window-close changes; README close/session explanation unchanged. Optional/unapproved browser identity/history, saved scroll, Mermaid theme race, late new-window timeout and security redesign were skipped.
- **T7 partial:** combined automated checks and relevant diff review complete; native/browser UI matrices, real Markdown/images/diagrams rendering, intentional close/relaunch, process exit, geometry and performance checks not run. An old release executable exists but launching it would not verify these uncommitted changes. No installer/release build or updater network call was run.

**Files:** `src/main.js`, `src/startup.js`, `src/index.html`, `build.mjs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.lock`; new `tests/helpers/source-harness.mjs`, `tests/tab-lifecycle.test.mjs`, `tests/startup-state.test.mjs`, `tests/early-theme.test.mjs`, `tests/external-open.test.mjs`. Generated `dist/` outputs were rebuilt, not hand-edited. This plan is the only implementation record.

**Checks actually run and corrections:**
- `node --check src/main.js`, `node --check src/startup.js`, `node --check build.mjs`: passed; worker test/helper syntax checks passed.
- Required two-suite Node command passed after fixes; final `node --test tests/*.test.mjs`: **136 passed, 0 failed**, covering lifecycle, restore, theme and external-open interactions. Additional early-theme suite rerun: 28 passed.
- Initial `npm run build` failed because the Windows npm child could not locate Node. Command-local `PATH="/c/Users/Tim/AppData/Local/hermes/node:$PATH" npm run build`: passed. No persistent PATH change. A `node --input-type=module` assertion check on actual generated packaged/standalone HTML and scripts passed: bootstrap ordering, marker substitution, script syntax, no new standalone sibling and lazy Mermaid.
- Initial `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline` failed: existing lockfile still named app version 1.0.3 while Cargo.toml was 1.1.0. `cargo test --manifest-path src-tauri/Cargo.toml --offline` regenerated only that root version entry, with no dependency changes/downloads, then failed on read-only generated build directories. PowerShell cleared ReadOnly only on 144 directories under `src-tauri/target/debug/build`; a subsequent check exposed two unsupported `get_window` calls. Replaced them with installed public `get_webview_window`; no API feature expansion.
- Final `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline`: **passed**. Final `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`: **4 passed, 0 failed**. Cargo commands had 120-second wall-clock bounds; no timeout occurred. Tauri build/config generation therefore passed, but this is not GUI execution.
- `rustfmt --edition 2021 --check src-tauri/src/main.rs`, `git diff --check`, relevant diff/stat review: passed. Focused routing review found stranded failure assignments; bounded revoke/retry recovery and regression tests addressed it. No repeated full audit.

**User decisions received and applied:** none. The implementation request approves independent core tasks, not Q1/Q2. Existing mocks specifically verify that intentional native window close keeps the restore list and individual tab close updates it; no forget-on-quit fix was inferred. No competing source edits were observed; starting tree contained only the supplied untracked `docs/` plan. Global guidance and bounded local guidance checks found no additional instructions.

**Unresolved decisions (existing IDs/options unchanged):**

- **Question Q1:** Should closing the final tab close its native window?
  - **What happens now:** one `Notes.md` tab becomes zero tabs in an empty window (`closeTab`; mocked lifecycle tests). Actual native process exit remains unverified.
  - **Options:** **A** keeps that empty window as a ready drop target, but needs a separate window close. **B** closes only that window after cleanup; a second window with `Guide.md` stays open. B removes the extra close step but loses the drop target and requires native close-failure/exit checks. Browser windows and Markdown files are unchanged.
  - **Recommendation:** **B** if the intended concern is the extra empty window; A if keeping a ready viewer is useful. The original concern's exact meaning remains uncertain.
  - **If unanswered:** keep current behaviour; T6 last-tab branch and its native acceptance/documentation stay paused. Independent core fixes above are implemented.
  - **How to answer:** `Q1 A` or `Q1 B`, or your own rule.
- **Question Q2:** Should intentional main-window close remember its files for next launch?
  - **What happens now:** closing a main window containing `Notes.md`, `Guide.md`, `Todo.md` leaves those paths saved; boot tries to reopen them. Individual tab close removes paths. Verified in source/mocks, not a real launch/close/reopen.
  - **Options:** **A** reopens those three files, preserving convenient continuation and stored paths (not reading positions). **B** forgets that list after successful intentional close: a normal launch is empty; double-clicking `Guide.md` still opens it. B removes automatic continuation and discards the remembered list, not files; changing back cannot recover that list. Cancelled/failed closes, updater restarts and forced exits require native checks; crashes cannot guarantee normal cleanup. Neither changes browser history or other windows.
  - **Recommendation:** **A** unless files returning next launch are specifically unwanted. Native cancellation/update paths remain unverified.
  - **If unanswered:** keep remembering main-window paths; T6 forget-on-close branch and its native acceptance/documentation stay paused. Independent fixes are implemented.
  - **How to answer:** `Q2 A` or `Q2 B`, or your own rule.

**Exact next step:** receive Q1/Q2 answers before touching those branches; use an isolated Windows test session and a current build for the plan's targeted native open/close/restore matrix and paired release startup captures before proceeding with remaining T5 changes or claiming full completion. Combined answer example, not approval: `Q1 B, Q2 A`. Revisit with `/decisions docs/tabs-startup-plan.md`.

**Git:** starting and ending HEAD `5dd48b7bbbceff9948dd064b6bc190fcfc818ecf`. Uncommitted source/lockfile changes and untracked tests/bootstrap/plan remain; this commit does **not** contain the implementation. No commit created.


### Run ended: 2026-09-18 (second run)

**Decisions (from chat):** Q1 — browser-style: closing the last tab closes that window, focus moves to another window, the last window quits the program. Alt+F4 / title-bar close quits the whole program. Q2 — new setting "Reopen tabs from last time", default off; the previous session is pushed onto a recently-closed stack so Ctrl+Shift+T brings it back.

- **Frontend (`src/main.js`, `src/index.html`):** `session` (label → paths, every window) replaces main-only `openTabs` (legacy key migrated once). `closed` stack (max 25) fed by tab close, Ctrl+Shift+W and the previous session. Ctrl+Shift+T = `reopenClosed`. JS closes use `destroy()`; last tab destroys its window.
- **Native (`src-tauri/src/main.rs`, capabilities):** `CloseRequested` → `prevent_close` + `app.exit(0)`; `Destroyed` focuses a remaining window; `core:window:allow-destroy` added.
- **Checks:** `node --test tests/*.test.mjs` 139/139; `cargo check`/`cargo test --locked --offline` pass (4/4); `npm run build` passes.
- **Not run:** real Windows click-through (close last tab with 2 windows, Alt+F4 with 2 windows, Ctrl+Shift+T after relaunch). Remaining T5 flash work still needs native evidence.
