# Reverse Engineering Harness — Plan

## Overview

Build a standalone local web application that lets a developer point at any code repository, trigger the full three-skill architecture pipeline, watch progress in real time, and browse the resulting `architecture/` artifacts. The harness orchestrates:

1. **`legacy-architecture-discovery`** — evidence-based analysis producing a discovery report and package
2. **`derive-architecture-folder`** — building the full `architecture/` repository from the discovery evidence
3. **`structurizr-c4-dsl`** — mirroring the narrative C4 model into a validated Structurizr DSL workspace

Each stage is executed by calling the **Claude CLI** (`claude`) as a subprocess with the appropriate skill prompt, streaming stdout/stderr back to the browser UI via Server-Sent Events. An optional post-processing step invokes the **Architecture Repository MCP** tools (`architecture_ensure_project_rules`, `architecture_evaluate_repository`) after the pipeline completes.

### Stack

- **Backend**: Node.js + Express (lightweight, no framework overhead)
- **Frontend**: Plain HTML + CSS + vanilla JS (no bundler)
- **Persistence**: Local JSON file for run history (survives restarts)
- **External dependency**: `claude` CLI on PATH, `ANTHROPIC_API_KEY` in environment

### Location

All harness code lives under `Reverse Engineering Harness/` in this workspace.

---

## Sub-Tasks

---

### Sub-Task 1 — Scaffold the Project

**Intent**  
Create the Node.js/Express project skeleton with all required folders, `package.json`, `.gitignore`, and a minimal `README.md`. No logic yet — just the structure everything else builds on.

**Expected Outcomes**

- `Reverse Engineering Harness/package.json` with name, version, scripts (`start`, `dev`), and `express` dependency
- `Reverse Engineering Harness/server.js` stub (Express app, PORT=4200, one health route)
- `Reverse Engineering Harness/public/` folder for static assets (index.html, style.css, app.js — empty stubs)
- `Reverse Engineering Harness/data/` folder for persisted run history (`.gitkeep`)
- `Reverse Engineering Harness/.gitignore` (node_modules, data/*.json except .gitkeep)
- `Reverse Engineering Harness/README.md` summarising what the harness is and how to run it

**Todo List**

1. Create `package.json` with `express` as the only runtime dependency.
2. Create `server.js` as an Express stub with a `/api/health` route returning `{ status: "ok" }`.
3. Create `public/index.html`, `public/style.css`, `public/app.js` as empty stubs.
4. Create `data/.gitkeep` and `data/runs.json` stub (`[]`).
5. Write `.gitignore` and `README.md`.

**Relevant Context**

- Follow the same lightweight structure used by `apps/architecture-remarks-workbench/` (plain HTML, Python/Node backend, no bundler).
- Port `4200` is chosen to avoid clashing with other local tools.

**Status**: `[x] done`

---

### Sub-Task 2 — Run History Store

**Intent**  
Implement a simple JSON-file persistence layer for pipeline runs so history survives server restarts. Each run record holds id, target repo path, start time, end time, status, and per-stage results.

**Expected Outcomes**

- `server/store.js` module exporting `createRun`, `updateRun`, `getRun`, `listRuns`
- Runs stored in `data/runs.json` as an array, written atomically on every mutation
- Each run record has the shape:
  ```json
  {
    "id": "<uuid>",
    "targetRepo": "/path/to/repo",
    "startedAt": "<iso>",
    "finishedAt": null,
    "status": "running|completed|failed",
    "mcpPostProcess": false,
    "stages": [
      { "name": "legacy-architecture-discovery", "status": "pending|running|completed|failed", "startedAt": null, "finishedAt": null }
    ]
  }
  ```

**Todo List**

1. Create `server/` directory.
2. Write `server/store.js` with `createRun(targetRepo, mcpPostProcess)`, `updateRun(id, patch)`, `getRun(id)`, `listRuns()`.
3. Load `data/runs.json` on module import; write it back on every mutation.
4. Add `crypto.randomUUID()` for IDs (Node 15+, no extra dep).

**Relevant Context**

- No database required; the file is written synchronously to keep it simple.
- The three stage names are fixed: `legacy-architecture-discovery`, `derive-architecture-folder`, `structurizr-c4-dsl`.

**Status**: `[x] done`

---

### Sub-Task 3 — Claude CLI Pipeline Runner

**Intent**  
Implement the core pipeline execution module that, for each of the three stages, builds the correct Claude CLI command with the right skill prompt, spawns it as a child process, and emits stdout/stderr line-by-line to a callback. The runner advances stage status in the store automatically.

**Expected Outcomes**

- `server/pipeline.js` module exporting `runPipeline(runId, targetRepo, onLine)`
- Each stage spawns: `claude --dangerously-skip-permissions -p "<stage-prompt>"` in the `targetRepo` working directory
- `onLine(stageName, line)` callback fires for every output line
- Stage and run status are updated in the store as stages start, complete, or fail
- If a stage exits with non-zero code the pipeline stops and the run is marked `failed`

**Todo List**

1. Write `server/pipeline.js`.
2. Define the three stage prompts (one per skill) based on the first-time prompt in `docs/first-time-users/03-reverse-engineer-application.md`.
3. Implement `spawnStage(stageName, prompt, cwd, onLine)` using `child_process.spawn` with inherited `ANTHROPIC_API_KEY` env.
4. Implement `runPipeline(runId, targetRepo, onLine)` iterating stages in order, calling `store.updateRun` on transitions.
5. Export a `getActiveRuns()` helper so the SSE endpoint knows which runs are live.

**Relevant Context**

- The Claude CLI prompt for each stage comes from the canonical "First-Time Prompt" in `docs/first-time-users/03-reverse-engineer-application.md`, wrapped to activate the correct skill.
- Stage prompts must instruct Claude to work in the `targetRepo` directory.
- `claude` must be on PATH; the backend should check for it at startup and warn if missing.

**Status**: `[x] done`

---

### Sub-Task 4 — REST + SSE API Routes

**Intent**  
Wire up the Express routes that the frontend calls: start a pipeline run, stream its live output via SSE, query run status, list past runs, and optionally trigger MCP post-processing.

**Expected Outcomes**

- `POST /api/runs` — validates `{ targetRepo, mcpPostProcess }`, creates a run record, starts the pipeline asynchronously, returns `{ runId }`
- `GET /api/runs` — returns array of all run summaries from store
- `GET /api/runs/:id` — returns full run record
- `GET /api/runs/:id/stream` — SSE endpoint, replays buffered lines then streams live output until run ends
- `POST /api/runs/:id/mcp` — triggers MCP post-processing step (`architecture_ensure_project_rules` + `architecture_evaluate_repository`) if not already run
- `GET /api/runs/:id/artifacts` — lists files under `<targetRepo>/architecture/` recursively

**Todo List**

1. Create `server/routes.js` with all routes above, imported by `server.js`.
2. Implement SSE with `text/event-stream`, proper keep-alive, and buffered line replay for reconnecting clients.
3. Implement the MCP post-processing call using the Node.js MCP client or by invoking the MCP server via subprocess (match existing `.bob/mcp.json` config).
4. Implement artifact listing with `fs.readdirSync` recursion on `<targetRepo>/architecture/`.
5. Add input validation: `targetRepo` must be an absolute path and must exist on disk.

**Relevant Context**

- SSE replay is critical so the browser can reconnect mid-run without losing lines already emitted.
- MCP server is at `.bob/mcp-servers/architecture-repository-mcp/server.py`; post-processing calls `architecture_ensure_project_rules` and `architecture_evaluate_repository`.
- See `.bob/mcp.json` for the server invocation pattern.

**Status**: `[x] done`

---

### Sub-Task 5 — Frontend: New Run Form + Run List

**Intent**  
Build the two main UI panels: a form to start a new pipeline run (with repo path input, MCP toggle, and submit button) and a run history list showing each run's status and a link to its detail view.

**Expected Outcomes**

- `public/index.html` with two sections: "New Run" form and "Run History" table
- `public/style.css` with minimal but clean layout (flexbox, monospace log area, status badges)
- `public/app.js` implementing:
  - `POST /api/runs` on form submit, then redirect to detail view
  - `GET /api/runs` on page load, rendering the history table
  - Auto-refresh of history list every 5 s while any run is `running`

**Todo List**

1. Write `public/index.html` with the form and history table structure.
2. Write `public/style.css` for layout, status badge colours (pending=grey, running=blue, completed=green, failed=red), and log panel.
3. Write the `app.js` section for the index page (form submit, history fetch, auto-refresh).
4. Add client-side validation: repo path must be non-empty.

**Relevant Context**

- Keep styling consistent with the architecture-remarks-workbench (clean, minimal, no framework).
- The detail view (Sub-Task 6) lives on `public/run.html`.

**Status**: `[x] done`

---

### Sub-Task 6 — Frontend: Run Detail + Live Log + Artifact Browser

**Intent**  
Build the run detail page showing the three-stage pipeline progress, a live streaming log panel (via SSE), and an artifact browser listing files under `architecture/` after the run completes.

**Expected Outcomes**

- `public/run.html` — standalone page loaded with `?runId=<id>`
- Stage progress bar showing each stage as pending / running / completed / failed
- Log panel: scrolling monospace textarea that receives SSE lines in real time, auto-scrolls, with a copy-to-clipboard button
- Artifact browser panel: appears after run completes, listing `architecture/` files as a tree with click-to-view for text files
- "Run MCP post-processing" button (shown only when `mcpPostProcess` was enabled and not yet done)

**Todo List**

1. Write `public/run.html` with stage tracker, log panel, and artifact browser placeholders.
2. Write `app.js` section for the run detail page:
   - Open SSE connection to `/api/runs/:id/stream`
   - Render stage transitions from `data-` events
   - Append log lines to the textarea
   - On run completion, call `GET /api/runs/:id/artifacts` and render the tree
   - Implement text-file viewer (inline, not a new page)
3. Add "MCP post-processing" button that calls `POST /api/runs/:id/mcp` and shows its output.

**Relevant Context**

- SSE events should carry a `type` field distinguishing log lines from stage-status transitions.
- The artifact viewer should handle `.md`, `.yaml`, `.json`, `.dsl` as text; everything else shown as filename only.

**Status**: `[ ] pending`

---

### Sub-Task 7 — Startup Checks + README

**Intent**  
Add a startup validation routine that checks for `claude` CLI availability and `ANTHROPIC_API_KEY`, and write a complete `README.md` with install, run, and usage instructions.

**Expected Outcomes**

- `server.js` startup logs a clear warning if `claude` is not on PATH or `ANTHROPIC_API_KEY` is missing
- `README.md` covers: prerequisites, `npm install`, `npm start`, how to use the UI, environment variables, and how each pipeline stage maps to a Bob skill

**Todo List**

1. Add `checkPrerequisites()` in `server.js` using `child_process.execSync('claude --version')` in a try/catch.
2. Check `process.env.ANTHROPIC_API_KEY` and warn if absent.
3. Write final `README.md` with full usage instructions.

**Relevant Context**

- Keep warnings non-fatal so the server still starts and the UI is accessible even if Claude isn't ready yet.
- README should reference the three skills and the docs at `docs/first-time-users/03-reverse-engineer-application.md`.

**Status**: `[x] done`

---

## Architecture Diagram

```
Browser
  |-- GET / ---------> public/index.html  (New Run Form + History List)
  |-- GET /run.html -> public/run.html    (Stage Tracker + Log + Artifacts)
  |
  |-- POST /api/runs ---------> routes.js -> store.createRun -> pipeline.runPipeline (async)
  |-- GET  /api/runs ---------> routes.js -> store.listRuns
  |-- GET  /api/runs/:id -----> routes.js -> store.getRun
  |-- GET  /api/runs/:id/stream -> routes.js -> SSE (buffered replay + live)
  |-- GET  /api/runs/:id/artifacts -> routes.js -> fs.readdirSync(targetRepo/architecture/)
  |-- POST /api/runs/:id/mcp -> routes.js -> spawn python3 MCP server tools

pipeline.runPipeline
  |-- stage 1: claude --dangerously-skip-permissions -p "<legacy-discovery-prompt>"  (cwd=targetRepo)
  |-- stage 2: claude --dangerously-skip-permissions -p "<derive-folder-prompt>"     (cwd=targetRepo)
  |-- stage 3: claude --dangerously-skip-permissions -p "<structurizr-dsl-prompt>"   (cwd=targetRepo)
  |   (each stage streams to SSE buffer, updates store on start/complete/fail)
  |-- [optional] MCP post-process: architecture_ensure_project_rules + architecture_evaluate_repository

store (data/runs.json)
  |-- createRun / updateRun / getRun / listRuns
  |-- atomic JSON write on every mutation
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backend | Node.js + Express | Lightweight, npm ecosystem, easy subprocess streaming |
| Frontend | Plain HTML/CSS/JS | No bundler, consistent with workbench app pattern |
| Pipeline execution | `claude` CLI subprocess | Matches user requirement; streams output naturally |
| Stage prompts | From `docs/first-time-users/03-reverse-engineer-application.md` | Canonical prompts already defined in project docs |
| Run persistence | `data/runs.json` | Simple, survives restarts, no DB required |
| SSE replay | Buffered lines per run in memory | Allows browser reconnect without losing history |
| MCP post-processing | Optional toggle, `POST /api/runs/:id/mcp` | User-confirmed — should not be automatic |
| Artifact browser | `<targetRepo>/architecture/` only | Scope confirmed; global MCP tab is future work |
| Port | 4200 | Avoids conflict with common dev servers |
