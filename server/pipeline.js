'use strict';

const { spawn, execSync } = require('child_process');
const path  = require('path');
const store = require('./store');

// ── Stage prompts (sourced from docs/first-time-users/03-reverse-engineer-application.md) ──

const STAGE_PROMPTS = {
  'legacy-architecture-discovery': `Use the legacy-architecture-discovery skill.

Analyze this codebase evidence-based. Separate every statement into Fact, Inference, or Question.
Identify system boundaries, entrypoints, containers, components, data stores, integrations,
runtime flows, contracts, configuration, deployment assumptions, and risks.

Produce:
- legacy-architecture-discovery-report.md at the repository root
- architecture/discovery/discovery-manifest.md
- architecture/discovery/c4-candidate-model.md
- architecture/discovery/adr-candidates.md
- architecture/discovery/agent-context.md
- architecture/discovery/evidence-log.md
- architecture/discovery/governance-candidates.yaml
- architecture/discovery/governance-traceability.md
- architecture/discovery/policy-candidates.md

Label every claim as Fact, Inference, or Question. Do not invent precision where evidence is absent.`,

  'derive-architecture-folder': `Use the derive-architecture-folder skill.

Read legacy-architecture-discovery-report.md and the architecture/discovery/ package that already
exists in this repository. Use them as the primary evidence source.

Build or refresh the architecture/ folder with:
- architecture/README.md
- architecture/c4/ views (system-context, container, component, dynamic, deployment)
- architecture/governance/ artifacts (objectives, principles, capabilities, domain stories,
  business actors, business processes, functions, patterns, controls, measures, components, policy)
- architecture/decisions/ ADRs
- architecture/contracts/ (APIs, schemas, events, files, record layouts)
- architecture/rules/ (domain behavior, calculations, parameters, version logic)
- architecture/agent-context/ (build-run-protocol.md, guardrails, allowed/forbidden changes)
- architecture/quality-gates/ (risky-change checklists, regression requirements)
- architecture/modernization/ (migration questions, readiness notes)

Keep every artifact traceable to the discovery evidence. Mark unknowns explicitly.`,

  'structurizr-c4-dsl': `Use the structurizr-c4-dsl skill.

Read the narrative C4 views already written under architecture/c4/ and the discovery package
under architecture/discovery/ in this repository.

Mirror the approved narrative architecture into architecture/structurizr/ as a modular
Structurizr DSL workspace:
- architecture/structurizr/workspace.dsl  (include root with ordered includes)
- architecture/structurizr/model/         (system, containers, components)
- architecture/structurizr/views/         (one DSL sub-file per view)
- architecture/structurizr/themes/        (styles)

Every Structurizr view must have its own sub-file under views/.
Mirror governance traceability (tags/properties) where it adds value.
Call out any validation gap or open question explicitly rather than inventing clean output.

STRICT DSL GRAMMAR RULES — violating these causes parser errors:

VALID top-level model element keywords (use ONLY these):
  person, softwareSystem, deploymentEnvironment, group, enterprise, element

VALID child keywords inside a softwareSystem block:
  container, group, !docs, !adrs, description, tags, url, properties, perspectives

VALID child keywords inside a container block:
  component, group, description, technology, tags, url, properties, perspectives

VALID relationship syntax:
  identifier -> identifier "description" "technology" tags "tagValue"

FORBIDDEN — these keywords do NOT exist in Structurizr DSL and will cause parser errors:
  dataAsset, service, module, dataStore, database, actor, role, api, queue,
  messageQueue, topic, event, process, function, lambda, microservice, entity,
  repository, gateway, proxy, cache, bus, pipeline, workflow, job, task,
  domain, subdomain, boundedContext, aggregate, valueObject, domainEvent

If you need to represent a database, queue, message bus, cache, or file store:
  - Use container with technology tag, e.g.: db = container "PostgreSQL" "Primary database" "PostgreSQL" { tags "Database" }
  - Use softwareSystem for external services

If you need to represent data: use properties or description on the owning container — do NOT invent a dataAsset or data element type.

VALID view keywords:
  systemLandscape, systemContext, container, component, dynamic, deployment, filtered, image, custom

Each view block must reference elements that are defined in the model. Use autoLayout when layout is unknown.

Validate mentally before writing: if you are about to use a keyword not in the VALID lists above, replace it with the correct valid equivalent.`,
};

// ── In-memory line buffer per run (for SSE replay) ──

const lineBuffers = new Map(); // runId -> Array<{ stageName, line, ts }>
const sseClients = new Map();  // runId -> Set<res>

function getOrCreateBuffer(runId) {
  if (!lineBuffers.has(runId)) lineBuffers.set(runId, []);
  return lineBuffers.get(runId);
}

function emitLine(runId, stageName, line) {
  const buf = getOrCreateBuffer(runId);
  const entry = { stageName, line, ts: Date.now() };
  buf.push(entry);

  const clients = sseClients.get(runId);
  if (clients) {
    const data = JSON.stringify(entry);
    for (const res of clients) {
      res.write(`event: log\ndata: ${data}\n\n`);
    }
  }
}

function emitStageEvent(runId, stageName, status) {
  const clients = sseClients.get(runId);
  if (clients) {
    const data = JSON.stringify({ stageName, status, ts: Date.now() });
    for (const res of clients) {
      res.write(`event: stage\ndata: ${data}\n\n`);
    }
  }
}

function emitRunEvent(runId, status) {
  const clients = sseClients.get(runId);
  if (clients) {
    const data = JSON.stringify({ status, ts: Date.now() });
    for (const res of clients) {
      res.write(`event: run\ndata: ${data}\n\n`);
    }
  }
}

// ── Stage runner ──

function buildClaudeEnv() {
  const env = { ...process.env };

  // Support ANTHROPIC_AUTH_TOKEN as an alias (used by route33 and other gateways).
  // The claude CLI reads ANTHROPIC_API_KEY, so map it across when needed.
  if (!env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  }

  // ANTHROPIC_BASE_URL and ANTHROPIC_MODEL are already in process.env if the
  // user exported them; they are forwarded automatically via the spread above.
  // Explicitly re-assert them here for clarity and to surface any overrides.
  if (process.env.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  }
  if (process.env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
  }

  return env;
}

function spawnStage(runId, stageName, targetRepo) {
  return new Promise((resolve, reject) => {
    const prompt = STAGE_PROMPTS[stageName];
    const proc = spawn(
      'claude',
      ['--dangerously-skip-permissions', '-p', prompt],
      {
        cwd: targetRepo,
        env: buildClaudeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    let remainder = '';
    function handleChunk(chunk) {
      const combined = remainder + chunk;
      const lines = combined.split('\n');
      remainder = lines.pop(); // last element may be incomplete
      for (const line of lines) {
        emitLine(runId, stageName, line);
      }
    }

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('close', (code) => {
      if (remainder) emitLine(runId, stageName, remainder);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Stage "${stageName}" exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude for stage "${stageName}": ${err.message}`));
    });
  });
}

// ── DSL validate + repair loop ────────────────────────────────────────────
//
//  After stage 3 completes, run the Structurizr validator (docker).
//  If it fails and Docker is available, invoke Claude once more with a
//  targeted repair prompt, then validate again.  Repeat up to MAX_REPAIR_ATTEMPTS.
//  The result is stored in run.dslValid so the UI can gate the preview button.

const MAX_REPAIR_ATTEMPTS = 2;
const DSL_PSEUDO_STAGE    = 'dsl-quality'; // virtual stage name for log grouping

function findWorkspaceDslPath(targetRepo) {
  const p = path.join(targetRepo, 'architecture', 'structurizr', 'workspace.dsl');
  return require('fs').existsSync(p) ? path.dirname(p) : null;
}

function dockerIsAvailable() {
  try {
    require('child_process').execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Translate container-internal path to host path for docker -v flag
function toHostPath(p) {
  const reposRoot     = process.env.REPOS_ROOT;
  const hostReposRoot = process.env.HOST_REPOS_ROOT;
  if (reposRoot && hostReposRoot && p.startsWith(reposRoot)) {
    return hostReposRoot + p.slice(reposRoot.length);
  }
  return p;
}

// Run `structurizr/structurizr validate` and return { passed, output }
// The new structurizr/structurizr image requires -w <workspace-path>.
function runStructurizrValidate(dslDir) {
  return new Promise((resolve) => {
    const { spawn: sp } = require('child_process');
    const proc = sp('docker', [
      'run', '--rm',
      '-v', `${toHostPath(dslDir)}:/usr/local/structurizr`,
      'structurizr/structurizr', 'validate',
      '-w', '/usr/local/structurizr/workspace.dsl',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', (code) => resolve({ passed: code === 0, output: out.trim() }));
    proc.on('error', (e) => resolve({ passed: false, output: e.message }));
  });
}

// Build a focused repair prompt that includes the exact error output
function buildRepairPrompt(errorOutput) {
  return `Use the structurizr-c4-dsl skill.

The Structurizr DSL workspace in this repository failed validation with the following errors:

--- VALIDATION ERRORS ---
${errorOutput}
--- END ERRORS ---

Fix ONLY the errors listed above. Do not rewrite the entire workspace.

STRICT RULES:
- Valid top-level model keywords: person, softwareSystem, deploymentEnvironment, group, element
- Valid inside softwareSystem: container, group, description, tags, url, properties, perspectives
- Valid inside container: component, group, description, technology, tags, url, properties, perspectives
- The ONLY relationship syntax is: id -> id "desc" "tech"
- FORBIDDEN keywords (replace with valid equivalents):
    dataAsset → container with tags "DataAsset" or remove and add to properties
    database → container with technology string
    queue/messageQueue/topic → container with technology string
    cache → container with technology string
    service/module/actor/role/api/gateway/proxy/bus/pipeline → container or component
    domain/subdomain/boundedContext → group
    aggregate/entity/valueObject/domainEvent → component or properties
    workflow/job/task/process/function/lambda/microservice/repository → component

For each error: read the indicated file and line, identify the invalid keyword, replace it with the correct valid keyword using the rules above. Save the fixed files.`;
}

async function runDslQualityLoop(runId, targetRepo) {
  const PSEUDO = DSL_PSEUDO_STAGE;

  const dslDir = findWorkspaceDslPath(targetRepo);
  if (!dslDir) {
    emitLine(runId, PSEUDO, '[dsl-quality] No workspace.dsl found — skipping validation');
    store.updateRun(runId, { dslValid: null });
    return;
  }

  if (!dockerIsAvailable()) {
    emitLine(runId, PSEUDO, '[dsl-quality] Docker not available — skipping DSL validation');
    emitLine(runId, PSEUDO, '[dsl-quality] Install Docker Desktop to enable automatic DSL quality checks');
    store.updateRun(runId, { dslValid: null });
    return;
  }

  emitLine(runId, PSEUDO, `[dsl-quality] Validating workspace at: ${dslDir}/workspace.dsl`);

  let attempt = 0;
  let lastResult;

  while (attempt <= MAX_REPAIR_ATTEMPTS) {
    emitLine(runId, PSEUDO, `[dsl-quality] Running structurizr/structurizr validate (attempt ${attempt + 1})…`);
    lastResult = await runStructurizrValidate(dslDir);

    if (lastResult.output) {
      for (const line of lastResult.output.split('\n')) {
        emitLine(runId, PSEUDO, line);
      }
    }

    if (lastResult.passed) {
      emitLine(runId, PSEUDO, '[dsl-quality] ✓ DSL is valid — preview is ready');
      store.updateRun(runId, { dslValid: true, dslRepairAttempts: attempt });
      emitStageEvent(runId, PSEUDO, 'valid');
      return;
    }

    // Failed — attempt repair if we have attempts left
    attempt++;
    if (attempt > MAX_REPAIR_ATTEMPTS) break;

    emitLine(runId, PSEUDO, `[dsl-quality] ✗ Validation failed — invoking Claude repair pass ${attempt}/${MAX_REPAIR_ATTEMPTS}…`);
    store.updateRun(runId, { dslRepairAttempts: attempt });

    const repairPrompt = buildRepairPrompt(lastResult.output);
    await spawnClaudePrompt(runId, PSEUDO, repairPrompt, targetRepo);
  }

  emitLine(runId, PSEUDO, `[dsl-quality] ✗ DSL still invalid after ${MAX_REPAIR_ATTEMPTS} repair attempt(s)`);
  emitLine(runId, PSEUDO, '[dsl-quality] Use the "Validate DSL" button to see errors and fix manually');
  store.updateRun(runId, { dslValid: false, dslRepairAttempts: attempt });
  emitStageEvent(runId, PSEUDO, 'invalid');
}

// Low-level: spawn claude with an arbitrary prompt (used for repair passes)
function spawnClaudePrompt(runId, stageName, prompt, targetRepo) {
  return new Promise((resolve) => {
    const proc = spawn(
      'claude',
      ['--dangerously-skip-permissions', '-p', prompt],
      { cwd: targetRepo, env: buildClaudeEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    let rem = '';
    function onChunk(chunk) {
      const combined = rem + chunk;
      const lines = combined.split('\n');
      rem = lines.pop();
      for (const l of lines) emitLine(runId, stageName, l);
    }
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    proc.on('close', () => { if (rem) emitLine(runId, stageName, rem); resolve(); });
    proc.on('error', (e) => { emitLine(runId, stageName, `[ERROR] ${e.message}`); resolve(); });
  });
}

// ── Main pipeline runner ──

async function runPipeline(runId, targetRepo) {
  const stages = store.STAGE_NAMES;

  for (const stageName of stages) {
    store.updateStage(runId, stageName, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    emitStageEvent(runId, stageName, 'running');

    try {
      await spawnStage(runId, stageName, targetRepo);
      store.updateStage(runId, stageName, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
      });
      emitStageEvent(runId, stageName, 'completed');
    } catch (err) {
      emitLine(runId, stageName, `[ERROR] ${err.message}`);
      store.updateStage(runId, stageName, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
      });
      emitStageEvent(runId, stageName, 'failed');
      store.updateRun(runId, { status: 'failed', finishedAt: new Date().toISOString() });
      emitRunEvent(runId, 'failed');
      return;
    }
  }

  // Stage 3 done — run DSL quality loop before marking the run completed
  emitLine(runId, DSL_PSEUDO_STAGE, '');
  await runDslQualityLoop(runId, targetRepo);

  store.updateRun(runId, { status: 'completed', finishedAt: new Date().toISOString() });
  emitRunEvent(runId, 'completed');
}

// ── SSE subscription helpers ──

function subscribeSSE(runId, res) {
  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  sseClients.get(runId).add(res);
}

function unsubscribeSSE(runId, res) {
  const clients = sseClients.get(runId);
  if (clients) clients.delete(res);
}

function getBufferedLines(runId) {
  return lineBuffers.get(runId) || [];
}

// ── Check claude CLI availability ──

function checkClaudeAvailable() {
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  runPipeline,
  subscribeSSE,
  unsubscribeSSE,
  getBufferedLines,
  checkClaudeAvailable,
  STAGE_PROMPTS,
};
