# Reverse Engineering Harness

A standalone local web application, packaged for Docker-first distribution, that runs the AAAC reverse-engineering pipeline over any code repository, streams progress in real time, and lets you inspect the generated `architecture/` artifacts and Structurizr workspace.

## What It Does

Points the [AAAC](../docs/architecture-as-an-active-delivery-system.md) reverse-engineering route at any repository and orchestrates the stages end-to-end:

| Stage | Skill | Output |
|---|---|---|
| 1 | `legacy-architecture-discovery` | `legacy-architecture-discovery-report.md` + `architecture/discovery/` evidence package |
| 2 | `derive-architecture-folder` | Full `architecture/` folder with C4 views, governance, ADRs, contracts, rules, and agent context |
| 3 | `structurizr-c4-dsl` | `architecture/structurizr/` DSL workspace with one file per view |

After stage 3, the harness can run a Docker-backed DSL quality pass: validate `architecture/structurizr/workspace.dsl`, attempt up to two targeted Claude repair passes if validation fails, and unlock a local Structurizr preview when the workspace is valid.

Each stage calls the Claude CLI as a subprocess, streams output live to the browser via Server-Sent Events, and persists run history across restarts.

---

## Distribution Package

This repo is intended to be shipped as a small Docker bundle:

- `Dockerfile` builds a runtime image with Node.js, Claude CLI, and Docker CLI.
- `docker-compose.yml` mounts the host repositories folder at `/repos`, persists run history in a named volume, and exposes port `4200`.
- `.env.example` captures the settings a recipient must fill in before first run.
- `.dockerignore` keeps local dependencies, logs, git data, and runtime history out of the image build context.

The docs in [`../docs/first-time-users/03-reverse-engineer-application.md`](../docs/first-time-users/03-reverse-engineer-application.md) remain the canonical explanation of the architecture workflow. This README focuses on packaging, distribution, and operation.

---

## Host Prerequisites

| Mode | Requirements | Notes |
|---|---|---|
| Docker distribution | Docker Desktop or Docker Engine with Compose v2, Anthropic credentials, and a host folder containing the repositories you want to analyse | The container already includes Node.js and the Claude CLI |
| Native development | Node.js 18+, `claude` on `PATH`, and Anthropic credentials | Install Docker too if you want DSL validation and Structurizr preview |

Authentication can be provided either as `ANTHROPIC_API_KEY`, or as `ANTHROPIC_AUTH_TOKEN` plus optional `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` when routing through a custom gateway.

If Docker is unavailable, the three Claude stages can still run natively, but the DSL quality pass and Structurizr preview are skipped.

---

## Run The Docker Distribution

```bash
cd "Reverse Engineering Harness"

cp .env.example .env
# Edit .env:
# - set ANTHROPIC_API_KEY, or set ANTHROPIC_AUTH_TOKEN for a custom gateway
# - set REPOS_ROOT to the absolute host folder that contains your repositories

docker compose up -d --build
```

Then open `http://localhost:4200` in your browser.

When the harness runs in Docker:

- Enter target repositories in the UI as `/repos/<project-name>`.
- The target repository is still modified on the host; the container is only a wrapper around the tooling.
- Run history is stored in the `harness-data` Docker volume, so it survives container restarts and image rebuilds.
- The host Docker socket is mounted so the harness can run `structurizr/structurizr` for DSL validation and preview.

To stop the distribution:

```bash
docker compose down
```

---

## Distribute To Another Machine

### Source Distribution

Share the entire repository checkout with the recipient. If you want the "Further Reading" links to keep working outside the larger workspace, also distribute the sibling `docs/` and `.bob/skills/` folders. The recipient only needs to fill in `.env` and run the Docker steps above.

### Prebuilt Image Distribution

If you want to avoid rebuilding on the target machine, export a prebuilt image and ship it together with `docker-compose.yml` and `.env.example`:

```bash
docker build -t rev-eng-harness:1.0.0 .
docker save rev-eng-harness:1.0.0 | gzip > rev-eng-harness-1.0.0.tar.gz
```

On the target machine:

```bash
gunzip -c rev-eng-harness-1.0.0.tar.gz | docker load
cp .env.example .env
docker compose up -d --no-build
```

You can also run a distributed image directly without Compose:

```bash
docker run -d \
  -p 4200:4200 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /absolute/path/to/repos:/repos \
  -v rev-eng-harness-data:/app/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --name rev-eng-harness \
  rev-eng-harness:1.0.0
```

If you use a custom Anthropic gateway, pass `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and optionally `ANTHROPIC_MODEL` instead of `ANTHROPIC_API_KEY`.

---

## Run Natively

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Then open `http://localhost:4200` in your browser.

Useful variations:

```bash
npm run dev
PORT=5000 npm start
```

Native mode expects absolute host paths in the UI, for example `/Users/you/Programming/my-app`.

---

## Using The UI

### Starting A Run

1. Enter the repository path.
2. If you are using Docker, enter `/repos/<project-name>`. If you are running natively, enter the absolute host path.
3. Optionally enable MCP post-processing to run `architecture_ensure_project_rules` and `architecture_evaluate_repository` after the pipeline.
4. Click `Run Pipeline`.

The harness immediately opens the run detail page. The pipeline stages run sequentially and stream output into the live log.

### Run Detail Page

- `Pipeline Stages` shows the three skill stages plus a `DSL Quality` stage for validation and repair attempts.
- `Live Output` streams stdout and stderr via SSE and supports copying the full log.
- `MCP Post-Processing` appears when the toggle was enabled for the run.
- `Structurizr Preview` lets you validate the generated workspace and start a local viewer backed by Docker.
- `Architecture Artifacts` lists the generated `architecture/` tree and renders supported text files inline.

### Run History

The home page lists past runs newest-first with status badges, timestamps, and elapsed time. History is persisted to `data/runs.json` when running natively, or to the `harness-data` volume when running through Docker Compose.

---

## How It Works

```text
Browser
  ├── POST /api/runs ─────────────► pipeline.runPipeline()
  │                                   ├── stage 1: claude CLI (legacy-architecture-discovery)
  │                                   ├── stage 2: claude CLI (derive-architecture-folder)
  │                                   ├── stage 3: claude CLI (structurizr-c4-dsl)
  │                                   └── stage 4: docker validate/repair loop (DSL quality)
  │
  ├── GET /api/runs/:id/stream ───► SSE replay + live log
  ├── GET /api/runs/:id/artifacts ─► fs.readdirSync(targetRepo/architecture/)
  ├── POST /api/runs/:id/mcp ─────► python3 architecture-repository-mcp/server.py
  ├── POST /api/structurizr/validate
  │                               └► docker run structurizr/structurizr validate -w /usr/local/structurizr/workspace.dsl
  └── POST /api/structurizr/start
                                  └► docker run structurizr/structurizr local
```

In Docker mode, the harness translates `/repos/...` back to the host path before launching Structurizr containers so volume mounts still work correctly from the host Docker daemon.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4200` | HTTP port exposed by the app |
| `ANTHROPIC_API_KEY` | empty | Standard Anthropic credential |
| `ANTHROPIC_AUTH_TOKEN` | empty | Alternative auth token, forwarded to the Claude CLI as `ANTHROPIC_API_KEY` when the standard key is absent |
| `ANTHROPIC_BASE_URL` | empty | Optional custom Anthropic-compatible gateway URL |
| `ANTHROPIC_MODEL` | empty | Optional model override for the Claude CLI |
| `REPOS_ROOT` | `~/repos` in `docker-compose.yml` | Host-side path mounted into the container as `/repos` |
| `HOST_REPOS_ROOT` | derived from `REPOS_ROOT` in `docker-compose.yml` | Host-side path used for Docker-backed Structurizr path translation; normally you do not set this yourself |
| `ARCHITECTURE_REPOSITORY_ROOT` | Docker: `/repos/architecture`, native fallback: `~/architecture` | Architecture repository root used by MCP post-processing |

---

## Project Structure

```text
Reverse Engineering Harness/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── server.js
├── server/
│   ├── routes.js
│   ├── pipeline.js
│   └── store.js
├── public/
│   ├── index.html
│   ├── run.html
│   ├── app.js
│   └── style.css
├── data/
│   └── runs.json
└── package.json
```

---

## Further Reading

- [`../docs/first-time-users/03-reverse-engineer-application.md`](../docs/first-time-users/03-reverse-engineer-application.md) - the reverse-engineering route this harness automates
- [`../docs/architecture-as-an-active-delivery-system.md`](../docs/architecture-as-an-active-delivery-system.md) - the AAAC approach
- `../.bob/skills/legacy-architecture-discovery/SKILL.md` - stage 1 skill
- `../.bob/skills/derive-architecture-folder/SKILL.md` - stage 2 skill
- `../.bob/skills/structurizr-c4-dsl/SKILL.md` - stage 3 skill
