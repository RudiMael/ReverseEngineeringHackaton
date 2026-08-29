'use strict';

const express = require('express');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4200;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ─────────────────────────────────────────────────────────────────
const apiRoutes = require('./server/routes');
app.use('/api', apiRoutes);

// ── Catch-all: serve index.html for non-API GET requests ──────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup checks ─────────────────────────────────────────────────────────
function checkPrerequisites() {
  console.log('\n── Reverse Engineering Harness ────────────────────────────────');

  // Check claude CLI
  try {
    const version = execSync('claude --version', { stdio: 'pipe' }).toString().trim();
    console.log(`  ✓ claude CLI found: ${version}`);
  } catch {
    console.warn('  ⚠  claude CLI not found on PATH. Pipeline runs will fail.');
    console.warn('     Install: https://docs.anthropic.com/claude/cli');
  }

  // Check auth — accept either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (route33 / custom gateway)
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('  ✓ ANTHROPIC_API_KEY is set');
  } else if (process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('  ✓ ANTHROPIC_AUTH_TOKEN is set (will be forwarded as ANTHROPIC_API_KEY to claude CLI)');
  } else {
    console.warn('  ⚠  Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set. Pipeline runs will fail.');
    console.warn('     Set one: export ANTHROPIC_API_KEY=sk-ant-...  OR  export ANTHROPIC_AUTH_TOKEN=...');
  }

  // Report custom gateway settings (route33 / ANTHROPIC_BASE_URL)
  if (process.env.ANTHROPIC_BASE_URL) {
    console.log(`  ✓ ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL}`);
  }
  if (process.env.ANTHROPIC_MODEL) {
    console.log(`  ✓ ANTHROPIC_MODEL: ${process.env.ANTHROPIC_MODEL}`);
  }

  console.log('───────────────────────────────────────────────────────────────\n');
}

// ── Start ──────────────────────────────────────────────────────────────────
checkPrerequisites();

app.listen(PORT, () => {
  console.log(`  Reverse Engineering Harness running at http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop.\n');
});
