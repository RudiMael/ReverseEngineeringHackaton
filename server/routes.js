'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const pipeline = require('./pipeline');
const { spawn } = require('child_process');

const router = express.Router();

// ── POST /api/runs — start a new pipeline run ──────────────────────────────

router.post('/runs', (req, res) => {
  const { targetRepo, mcpPostProcess } = req.body || {};

  if (!targetRepo || typeof targetRepo !== 'string') {
    return res.status(400).json({ error: 'targetRepo is required and must be a string' });
  }
  const absPath = path.resolve(targetRepo);
  if (!fs.existsSync(absPath)) {
    return res.status(400).json({ error: `targetRepo does not exist: ${absPath}` });
  }

  const run = store.createRun(absPath, mcpPostProcess);

  // Fire and forget — stream output via SSE
  pipeline.runPipeline(run.id, absPath).catch((err) => {
    console.error(`[pipeline] Unhandled error for run ${run.id}:`, err.message);
  });

  res.status(201).json({ runId: run.id });
});

// ── GET /api/runs — list all runs (newest first) ──────────────────────────

router.get('/runs', (_req, res) => {
  res.json(store.listRuns());
});

// ── GET /api/runs/:id — single run ────────────────────────────────────────

router.get('/runs/:id', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// ── GET /api/runs/:id/stream — SSE live log ───────────────────────────────

router.get('/runs/:id/stream', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Replay buffered lines
  const buffered = pipeline.getBufferedLines(run.id);
  for (const entry of buffered) {
    res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  }

  // If run is already finished, also emit the final run status and close
  if (run.status !== 'running') {
    // Replay stage statuses
    for (const stage of run.stages) {
      if (stage.status !== 'pending') {
        res.write(`event: stage\ndata: ${JSON.stringify({ stageName: stage.name, status: stage.status })}\n\n`);
      }
    }
    res.write(`event: run\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
    res.end();
    return;
  }

  // Subscribe for live events
  pipeline.subscribeSSE(run.id, res);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    pipeline.unsubscribeSSE(run.id, res);
  });
});

// ── GET /api/runs/:id/artifacts — list architecture/ files ────────────────

router.get('/runs/:id/artifacts', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const archDir = path.join(run.targetRepo, 'architecture');
  if (!fs.existsSync(archDir)) {
    return res.json({ root: archDir, files: [] });
  }

  const files = walkDir(archDir, archDir);
  res.json({ root: archDir, files });
});

function walkDir(base, dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);
    if (entry.isDirectory()) {
      result.push({ type: 'dir', name: entry.name, path: relPath, children: walkDir(base, fullPath) });
    } else {
      result.push({ type: 'file', name: entry.name, path: relPath });
    }
  }
  return result;
}

// ── GET /api/runs/:id/artifacts/read — read a single text file ────────────

router.get('/runs/:id/artifacts/read', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const relPath = req.query.file;
  if (!relPath) return res.status(400).json({ error: 'file query param required' });

  const archDir = path.join(run.targetRepo, 'architecture');
  const absFile = path.resolve(archDir, relPath);

  // Prevent path traversal outside architecture/
  if (!absFile.startsWith(archDir + path.sep) && absFile !== archDir) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(absFile)) return res.status(404).json({ error: 'File not found' });

  const TEXT_EXTS = new Set(['.md', '.yaml', '.yml', '.json', '.dsl', '.txt', '.toml', '.xml', '.js', '.ts', '.py', '.sh', '.tf']);
  const ext = path.extname(absFile).toLowerCase();
  if (!TEXT_EXTS.has(ext)) {
    return res.status(415).json({ error: 'Binary or unsupported file type' });
  }

  try {
    const content = fs.readFileSync(absFile, 'utf8');
    res.json({ path: relPath, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/runs/:id/mcp — trigger MCP post-processing ─────────────────

router.post('/runs/:id/mcp', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status === 'running') return res.status(409).json({ error: 'Run still in progress' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const MCP_SERVER = path.join(__dirname, '..', '..', '.bob', 'mcp-servers', 'architecture-repository-mcp', 'server.py');
  const ARCH_ROOT = process.env.ARCHITECTURE_REPOSITORY_ROOT || path.join(process.env.HOME || '/tmp', 'architecture');
  const systemName = path.basename(run.targetRepo);

  const script = `
import json, sys, asyncio
sys.path.insert(0, '${path.dirname(MCP_SERVER)}')

async def main():
    from server import handle_tool_call
    r1 = await handle_tool_call('architecture_ensure_project_rules', {
        'project_root': '${run.targetRepo}',
        'system_name': '${systemName}',
        'mode': 'upsert'
    })
    print(json.dumps({'tool': 'architecture_ensure_project_rules', 'result': r1}))

    r2 = await handle_tool_call('architecture_evaluate_repository', {
        'project_root': '${run.targetRepo}'
    })
    print(json.dumps({'tool': 'architecture_evaluate_repository', 'result': r2}))

asyncio.run(main())
`;

  res.write(`event: log\ndata: ${JSON.stringify({ line: '[MCP] Starting post-processing...' })}\n\n`);

  const proc = spawn('python3', ['-c', script], {
    env: { ...process.env, ARCHITECTURE_REPOSITORY_ROOT: ARCH_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let rem = '';
  function handleChunk(chunk) {
    const combined = rem + chunk;
    const lines = combined.split('\n');
    rem = lines.pop();
    for (const line of lines) {
      if (line.trim()) res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
    }
  }
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', handleChunk);
  proc.stderr.on('data', handleChunk);

  proc.on('close', (code) => {
    if (rem.trim()) res.write(`event: log\ndata: ${JSON.stringify({ line: rem })}\n\n`);
    const status = code === 0 ? 'done' : 'error';
    res.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
    store.updateRun(run.id, { mcpDone: code === 0 });
    res.end();
  });

  req.on('close', () => proc.kill());
});

// ── POST /api/runs/:id/dsl-valid — persist dslValid from UI validate ──────

router.post('/runs/:id/dsl-valid', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const { dslValid } = req.body || {};
  if (typeof dslValid !== 'boolean') return res.status(400).json({ error: 'dslValid must be boolean' });
  store.updateRun(req.params.id, { dslValid });
  res.json({ ok: true, dslValid });
});

// ── Structurizr Lite Docker integration ──────────────────────────────────
//
//  The open-source structurizr/lite image reads a workspace from a directory
//  mounted at /usr/local/structurizr.  We find the workspace.dsl for a run,
//  start a container bound to a random host port, and return that port so the
//  browser can open http://localhost:<port> directly.
//
//  One container per server process — we store state in memory.

// structurizr/lite is deprecated and exits immediately — use the new image with `local` mode.
// See: https://hub.docker.com/r/structurizr/structurizr
const STRUCTURIZR_IMAGE = 'structurizr/structurizr';
const STRUCTURIZR_CMD   = 'local';          // runs the local filesystem workspace server
const STRUCTURIZR_CONTAINER_NAME = 'rev-eng-harness-structurizr';

// in-memory state for the running container
let structurizrState = {
  running: false,
  port: null,
  dslDir: null,
  runId: null,
};

// ── helpers ──

function execDockerSync(args) {
  const { execSync } = require('child_process');
  return execSync(`docker ${args}`, { stdio: 'pipe' }).toString().trim();
}

function dockerAvailable() {
  try { execDockerSync('info --format "{{.ServerVersion}}"'); return true; }
  catch { return false; }
}

// ── Path translation for Docker-in-Docker ────────────────────────────────
//
// When the harness itself runs inside a container, paths like /repos/myapp
// are container-internal.  The Docker daemon is on the HOST, so any -v flag
// we pass to `docker run` must use the real HOST path.
//
// We translate by replacing the REPOS_ROOT container prefix with the
// HOST_REPOS_ROOT env var (the original host path, e.g. ~/Programming).
// If neither env var is set the harness is running natively — no translation.

function toHostPath(containerPath) {
  const reposRoot     = process.env.REPOS_ROOT;       // /repos  (inside container)
  const hostReposRoot = process.env.HOST_REPOS_ROOT;  // /Users/x/Programming (on host)
  if (reposRoot && hostReposRoot && containerPath.startsWith(reposRoot)) {
    return hostReposRoot + containerPath.slice(reposRoot.length);
  }
  return containerPath; // native run — path is already a host path
}

function findWorkspaceDsl(targetRepo) {
  // Prefer architecture/structurizr/workspace.dsl; fall back to any workspace.dsl
  const preferred = path.join(targetRepo, 'architecture', 'structurizr', 'workspace.dsl');
  if (fs.existsSync(preferred)) return { file: preferred, dir: path.dirname(preferred) };
  // walk architecture/structurizr/
  const structDir = path.join(targetRepo, 'architecture', 'structurizr');
  if (fs.existsSync(structDir)) {
    const entries = fs.readdirSync(structDir);
    if (entries.includes('workspace.dsl')) {
      return { file: path.join(structDir, 'workspace.dsl'), dir: structDir };
    }
  }
  return null;
}

function freePort() {
  // Pick a port in 18000-19000 range that is not in use
  const net = require('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function stopExistingContainer() {
  try { execDockerSync(`rm -f ${STRUCTURIZR_CONTAINER_NAME}`); } catch { /* not running */ }
}

// ── GET /api/structurizr/status ───────────────────────────────────────────

router.get('/structurizr/status', (_req, res) => {
  if (!dockerAvailable()) {
    return res.json({ available: false, running: false, message: 'Docker not available on PATH' });
  }
  res.json({
    available: true,
    running: structurizrState.running,
    port: structurizrState.port,
    dslDir: structurizrState.dslDir,
    runId: structurizrState.runId,
  });
});

// ── POST /api/structurizr/start — start Structurizr Lite for a run ────────

router.post('/structurizr/start', async (req, res) => {
  const { runId } = req.body || {};
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  const run = store.getRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  if (!dockerAvailable()) {
    return res.status(503).json({ error: 'Docker is not available. Install Docker Desktop or Docker Engine.' });
  }

  const found = findWorkspaceDsl(run.targetRepo);
  if (!found) {
    return res.status(404).json({
      error: 'No workspace.dsl found. Run the pipeline first — stage 3 (structurizr-c4-dsl) creates it under architecture/structurizr/.',
    });
  }

  // Stop any previously running container
  stopExistingContainer();
  structurizrState = { running: false, port: null, dslDir: null, runId: null };

  let port;
  try { port = await freePort(); }
  catch { return res.status(500).json({ error: 'Could not allocate a free port' }); }

  const { execSync } = require('child_process');
  try {
    // Pull image if not present (silent)
    try { execSync(`docker image inspect ${STRUCTURIZR_IMAGE}`, { stdio: 'ignore' }); }
    catch { execSync(`docker pull ${STRUCTURIZR_IMAGE}`, { stdio: 'pipe' }); }

    const hostDslDir = toHostPath(found.dir);
    execSync(
      `docker run -d --name ${STRUCTURIZR_CONTAINER_NAME} ` +
      `-p ${port}:8080 ` +
      `-v "${hostDslDir}:/usr/local/structurizr" ` +
      `--restart=no ` +
      `${STRUCTURIZR_IMAGE} ${STRUCTURIZR_CMD}`,
      { stdio: 'pipe' }
    );

    structurizrState = { running: true, port, dslDir: found.dir, runId };
    res.json({ port, url: `http://localhost:${port}`, dslDir: found.dir });
  } catch (err) {
    res.status(500).json({ error: `Failed to start Structurizr Lite: ${err.message}` });
  }
});

// ── POST /api/structurizr/stop ────────────────────────────────────────────

router.post('/structurizr/stop', (_req, res) => {
  stopExistingContainer();
  structurizrState = { running: false, port: null, dslDir: null, runId: null };
  res.json({ stopped: true });
});

// ── POST /api/structurizr/validate — validate DSL before preview ──────────
//
//  Runs: docker run --rm -v <dslDir>:/usr/local/structurizr structurizr/structurizr validate -w /usr/local/structurizr/workspace.dsl
//  The -w flag is required by structurizr/structurizr (unlike the deprecated structurizr/lite).
//  Streams output as SSE log lines, emits a done event with pass/fail status.

router.post('/structurizr/validate', (req, res) => {
  const { runId } = req.body || {};
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  const run = store.getRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  if (!dockerAvailable()) {
    return res.status(503).json({ error: 'Docker is not available' });
  }

  const found = findWorkspaceDsl(run.targetRepo);
  if (!found) {
    return res.status(404).json({ error: 'No workspace.dsl found under architecture/structurizr/' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (line) => res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);

  emit(`[validate] Workspace: ${found.file}`);
  emit('[validate] Running: docker run --rm structurizr/structurizr validate -w /usr/local/structurizr/workspace.dsl');

  const { spawn } = require('child_process');
  const hostDslDir = toHostPath(found.dir);
  const proc = spawn('docker', [
    'run', '--rm',
    '-v', `${hostDslDir}:/usr/local/structurizr`,
    STRUCTURIZR_IMAGE, 'validate',
    '-w', '/usr/local/structurizr/workspace.dsl',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let rem = '';
  let output = '';

  function handleChunk(chunk) {
    const combined = rem + chunk;
    const lines = combined.split('\n');
    rem = lines.pop();
    for (const line of lines) {
      output += line + '\n';
      emit(line);
    }
  }

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', handleChunk);
  proc.stderr.on('data', handleChunk);

  proc.on('close', (code) => {
    if (rem.trim()) { output += rem; emit(rem); }
    const passed = code === 0;
    emit(passed ? '[validate] ✓ Workspace is valid' : '[validate] ✗ Validation failed — fix the errors above before previewing');
    res.write(`event: done\ndata: ${JSON.stringify({ passed, code })}\n\n`);
    res.end();
  });

  proc.on('error', (err) => {
    emit(`[validate] ERROR: ${err.message}`);
    res.write(`event: done\ndata: ${JSON.stringify({ passed: false, code: -1 })}\n\n`);
    res.end();
  });

  req.on('close', () => proc.kill());
});

module.exports = router;
