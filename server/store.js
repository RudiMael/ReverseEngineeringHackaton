'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'runs.json');

const STAGE_NAMES = [
  'legacy-architecture-discovery',
  'derive-architecture-folder',
  'structurizr-c4-dsl',
];

function loadRuns() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveRuns(runs) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(runs, null, 2), 'utf8');
}

function createRun(targetRepo, mcpPostProcess) {
  const runs = loadRuns();
  const run = {
    id: crypto.randomUUID(),
    targetRepo,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    mcpPostProcess: !!mcpPostProcess,
    mcpDone: false,
    // null = not yet validated, true = valid, false = invalid after repair attempts
    dslValid: null,
    dslRepairAttempts: 0,
    stages: STAGE_NAMES.map((name) => ({
      name,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    })),
  };
  runs.push(run);
  saveRuns(runs);
  return run;
}

function updateRun(id, patch) {
  const runs = loadRuns();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`Run ${id} not found`);
  Object.assign(runs[idx], patch);
  saveRuns(runs);
  return runs[idx];
}

function updateStage(runId, stageName, patch) {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const stage = run.stages.find((s) => s.name === stageName);
  if (!stage) throw new Error(`Stage ${stageName} not found`);
  Object.assign(stage, patch);
  saveRuns(runs);
  return run;
}

function getRun(id) {
  const runs = loadRuns();
  return runs.find((r) => r.id === id) || null;
}

function listRuns() {
  return loadRuns().slice().reverse(); // newest first
}

module.exports = { createRun, updateRun, updateStage, getRun, listRuns, STAGE_NAMES };
