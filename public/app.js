'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Shared utilities
═══════════════════════════════════════════════════════════════════════════ */

function formatDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

function elapsed(start, end) {
  if (!start) return '';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function badgeHtml(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

// Poll a URL with HEAD requests until it responds (or times out after 60s).
// Calls onReady() when the server is up, or onTimeout() if it never starts.
function waitForStructurizr(url, onReady, onTimeout) {
  const MAX_ATTEMPTS = 30;   // 30 × 2s = 60s max
  const INTERVAL_MS  = 2000;
  let attempts = 0;
  let done = false;                          // fire onReady exactly once

  function probe() {
    if (done) return;
    attempts++;

    const img = new Image();
    img.onload = img.onerror = function () {
      if (done) return;
      done = true;
      onReady();
    };
    // Any response from the server (200 or redirect) triggers onerror for a favicon
    // because the content-type is not an image — that's fine, it means the server is up.
    img.src = url + '/favicon.ico?_t=' + Date.now();

    if (attempts < MAX_ATTEMPTS) {
      setTimeout(probe, INTERVAL_MS);
    } else if (!done && onTimeout) {
      onTimeout();
    }
  }

  // Give Spring Boot a head-start before the first probe
  setTimeout(probe, 3000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Markdown renderer  (zero-dependency, inline)
═══════════════════════════════════════════════════════════════════════════ */

function renderMarkdown(md) {
  // Escape HTML
  function h(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Inline formatting — defined first so all branches can call it
  function inline(s) {
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${h(c)}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  // A line is "block-special" when it must be handled by its own branch, not consumed as paragraph text
  function isSpecial(line) {
    return /^(#{1,6}\s|>|[-*+]\s|\d+\.\s|```|\||-{3,}|\*{3,}|_{3,})/.test(line);
  }

  const lines = md.split('\n');
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block  ``` … ```
    if (/^```/.test(line)) {
      let code = '';
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code += lines[i] + '\n';
        i++;
      }
      i++; // consume closing ```
      html += `<pre><code>${h(code)}</code></pre>\n`;
      continue;
    }

    // Heading  # … ######
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      html += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>\n`;
      i++; continue;
    }

    // Horizontal rule  --- / *** / ___  (must come before list check to avoid --- being a list item)
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html += '<hr>\n';
      i++; continue;
    }

    // Blockquote  >
    if (/^>\s?/.test(line)) {
      let bq = '';
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bq += lines[i].replace(/^>\s?/, '') + '\n';
        i++;
      }
      html += `<blockquote>${renderMarkdown(bq)}</blockquote>\n`;
      continue;
    }

    // Unordered list  - / * / +  (requires space after marker)
    if (/^[ \t]*[-*+]\s+/.test(line)) {
      html += '<ul>\n';
      while (i < lines.length && /^[ \t]*[-*+]\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^[ \t]*[-*+]\s+/, ''))}</li>\n`;
        i++;
      }
      html += '</ul>\n';
      continue;
    }

    // Ordered list  1. 2. …
    if (/^\d+\.\s+/.test(line)) {
      html += '<ol>\n';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>\n`;
        i++;
      }
      html += '</ol>\n';
      continue;
    }

    // Table  | col | … |  followed by | --- | separator row
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
      const headers = line.split('|').filter((_, idx, a) => idx > 0 && idx < a.length - 1);
      i += 2; // skip header row + separator row
      html += '<table><thead><tr>';
      headers.forEach((c) => { html += `<th>${inline(c.trim())}</th>`; });
      html += '</tr></thead><tbody>\n';
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].split('|').filter((_, idx, a) => idx > 0 && idx < a.length - 1);
        html += '<tr>';
        cells.forEach((c) => { html += `<td>${inline(c.trim())}</td>`; });
        html += '</tr>\n';
        i++;
      }
      html += '</tbody></table>\n';
      continue;
    }

    // Blank line — skip
    if (line.trim() === '') {
      i++; continue;
    }

    // Paragraph — consume lines until a blank or block-special line.
    // Always advances i by at least 1 to prevent infinite loops.
    let para = line.trim();
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isSpecial(lines[i])) {
      para += ' ' + lines[i].trim();
      i++;
    }
    html += `<p>${inline(para)}</p>\n`;
  }

  return html;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Structurizr DSL syntax highlighter  (zero-dependency, inline)
═══════════════════════════════════════════════════════════════════════════ */

function highlightDsl(source) {
  // Structurizr DSL keyword sets
  const KEYWORDS  = new Set([
    'workspace','model','views','configuration','properties','perspectives',
    'enterprise','group','include','exclude','autoLayout','default',
    'themes','styles','branding','terminology','users','animation',
    'extends','!identifiers','!impliedRelationships',
  ]);
  const TYPES = new Set([
    'person','softwareSystem','container','component','deploymentEnvironment',
    'deploymentNode','infrastructureNode','containerInstance','softwareSystemInstance',
    'systemContext','systemLandscape','dynamic','filtered','image',
    'element','relationship','systemContextView','containerView','componentView',
    'deploymentView','dynamicView','custom',
  ]);
  const PROPS = new Set([
    'tags','description','url','technology','instances',
    'shape','background','color','colour','stroke','fontSize','border',
    'opacity','metadata','icon','width','height','position',
  ]);

  function h(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  const lines = source.split('\n');
  const out = lines.map((line) => {
    // Full-line comment  (#  or  //)
    const commentMatch = line.match(/^(\s*)(#|\/\/)(.*)$/);
    if (commentMatch) {
      return `${h(commentMatch[1])}<span class="dsl-comment">${h(commentMatch[2] + commentMatch[3])}</span>`;
    }

    let result = '';
    let pos = 0;

    while (pos < line.length) {
      // Inline comment  //
      if (line[pos] === '/' && line[pos + 1] === '/') {
        result += `<span class="dsl-comment">${h(line.slice(pos))}</span>`;
        break;
      }
      // Inline comment  #
      if (line[pos] === '#') {
        result += `<span class="dsl-comment">${h(line.slice(pos))}</span>`;
        break;
      }
      // Arrow  ->
      if (line[pos] === '-' && line[pos + 1] === '>') {
        result += `<span class="dsl-arrow">-&gt;</span>`;
        pos += 2; continue;
      }
      // Braces
      if (line[pos] === '{' || line[pos] === '}') {
        result += `<span class="dsl-brace">${h(line[pos])}</span>`;
        pos++; continue;
      }
      // Quoted string
      if (line[pos] === '"') {
        let end = pos + 1;
        while (end < line.length && !(line[end] === '"' && line[end - 1] !== '\\')) end++;
        result += `<span class="dsl-string">${h(line.slice(pos, end + 1))}</span>`;
        pos = end + 1; continue;
      }
      // Word token
      if (/\w/.test(line[pos])) {
        let end = pos;
        while (end < line.length && /[\w.]/.test(line[end])) end++;
        const word = line.slice(pos, end);
        if (KEYWORDS.has(word)) {
          result += `<span class="dsl-keyword">${h(word)}</span>`;
        } else if (TYPES.has(word)) {
          result += `<span class="dsl-type">${h(word)}</span>`;
        } else if (PROPS.has(word)) {
          result += `<span class="dsl-prop">${h(word)}</span>`;
        } else if (/^\d+(\.\d+)?$/.test(word)) {
          result += `<span class="dsl-number">${h(word)}</span>`;
        } else {
          result += `<span class="dsl-ident">${h(word)}</span>`;
        }
        pos = end; continue;
      }
      // Everything else (whitespace, punctuation)
      result += h(line[pos]);
      pos++;
    }
    return result;
  });

  return out.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   INDEX PAGE  (index.html)
═══════════════════════════════════════════════════════════════════════════ */

function initIndexPage() {
  const form = document.getElementById('run-form');
  if (!form) return;

  const submitBtn = document.getElementById('submit-btn');
  const errorBox  = document.getElementById('form-error');

  // ── Form submit ────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';

    const targetRepo = document.getElementById('targetRepo').value.trim();
    const mcpPostProcess = document.getElementById('mcpPostProcess').checked;

    if (!targetRepo) {
      showError(errorBox, 'Please enter a repository path.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Starting…';

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRepo, mcpPostProcess }),
      });

      const data = await res.json();

      if (!res.ok) {
        showError(errorBox, data.error || 'Failed to start run.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Run Pipeline';
        return;
      }

      window.location.href = `run.html?runId=${data.runId}`;
    } catch (err) {
      showError(errorBox, `Network error: ${err.message}`);
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Run Pipeline';
    }
  });

  // ── History list ───────────────────────────────────────────
  loadHistory();
  let historyTimer = null;

  async function loadHistory() {
    try {
      const res = await fetch('/api/runs');
      const runs = await res.json();
      renderHistory(runs);

      const hasRunning = runs.some((r) => r.status === 'running');
      clearTimeout(historyTimer);
      if (hasRunning) {
        historyTimer = setTimeout(loadHistory, 4000);
      }
    } catch {
      document.getElementById('history-container').innerHTML =
        '<p class="empty-state" style="color:#b91c1c;">Could not load run history.</p>';
    }
  }

  function renderHistory(runs) {
    const container = document.getElementById('history-container');
    if (!runs.length) {
      container.innerHTML = '<p class="empty-state">No pipeline runs yet. Start one above!</p>';
      return;
    }

    const rows = runs.map((r) => {
      const dur = r.finishedAt
        ? elapsed(r.startedAt, r.finishedAt)
        : r.status === 'running' ? `<span class="spinner"></span> ${elapsed(r.startedAt)}` : '';

      return `<tr>
        <td><a href="run.html?runId=${r.id}">${r.id.slice(0, 8)}…</a></td>
        <td><span class="repo-path" title="${esc(r.targetRepo)}">${esc(r.targetRepo)}</span></td>
        <td>${badgeHtml(r.status)}</td>
        <td style="font-size:12px;color:#57606a;">${formatDt(r.startedAt)}</td>
        <td style="font-size:12px;color:#57606a;">${dur}</td>
        <td><a href="run.html?runId=${r.id}" class="btn btn-secondary btn-sm">View</a></td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Run ID</th>
            <th>Repository</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   RUN DETAIL PAGE  (run.html)
═══════════════════════════════════════════════════════════════════════════ */

function initRunPage() {
  const logPanel = document.getElementById('log-panel');
  if (!logPanel) return;

  const params = new URLSearchParams(window.location.search);
  const runId  = params.get('runId');
  const errBox = document.getElementById('run-error');

  if (!runId) {
    showError(errBox, 'No runId in URL.');
    return;
  }

  let currentStageName = null;
  let autoScroll = true;

  // ── Log helpers ────────────────────────────────────────────
  function appendLog(stageName, line) {
    if (stageName !== currentStageName) {
      currentStageName = stageName;
      const hdr = document.createElement('span');
      hdr.className = 'log-stage-header';
      hdr.textContent = `\n── ${stageName} ──────────────────────────`;
      logPanel.appendChild(hdr);
    }
    const el = document.createElement('span');
    if (line.startsWith('[ERROR]') || line.startsWith('Error')) el.className = 'log-error';
    el.textContent = line + '\n';
    logPanel.appendChild(el);
    if (autoScroll) logPanel.scrollTop = logPanel.scrollHeight;
  }

  // Pause auto-scroll when user scrolls up
  logPanel.addEventListener('scroll', () => {
    const atBottom = logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight < 40;
    autoScroll = atBottom;
  });

  // ── Copy button ────────────────────────────────────────────
  document.getElementById('copy-log-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(logPanel.innerText).then(() => {
      const btn = document.getElementById('copy-log-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });

  // ── Run header ─────────────────────────────────────────────
  function updateHeader(run) {
    document.title = `Run ${run.id.slice(0, 8)} — Reverse Engineering Harness`;
    document.getElementById('run-repo').textContent = run.targetRepo;
    const badge = document.getElementById('run-status-badge');
    badge.className = `badge badge-${run.status}`;
    badge.textContent = run.status;
    const dur = run.finishedAt ? ` · ${elapsed(run.startedAt, run.finishedAt)}` : '';
    document.getElementById('run-times').textContent =
      `Started: ${formatDt(run.startedAt)}${dur}`;
  }

  // ── Stage tracker ──────────────────────────────────────────
  function updateStageUI(stageName, status) {
    const el    = document.getElementById(`stage-${stageName}`);
    const name  = document.getElementById(`stage-name-${stageName}`);
    const badge = document.getElementById(`stage-badge-${stageName}`);
    if (!el) return;

    // dsl-quality uses 'valid'/'invalid' as status names — map to CSS badge classes
    const cssStatus = status === 'valid'   ? 'completed'
                    : status === 'invalid' ? 'failed'
                    : status;

    el.className   = `stage-item ${cssStatus}`;
    name.className = `stage-name ${cssStatus}`;
    badge.className = `badge badge-${cssStatus}`;
    badge.textContent = status;

    // Mirror DSL quality result into the Structurizr panel badge immediately
    if (stageName === 'dsl-quality') {
      applyDslValidBadge(status === 'valid');
      if (status === 'valid') {
        // Unlock Start Preview
        const sb = document.getElementById('structurizr-start-btn');
        if (sb) { sb.disabled = false; sb.title = ''; }
      }
    }
  }

  // Update the DSL quality badge in the Structurizr panel
  function applyDslValidBadge(isValid) {
    const b = document.getElementById('structurizr-dsl-badge');
    if (!b) return;
    if (isValid === true)  { b.className = 'badge badge-completed'; b.textContent = 'DSL: valid ✓'; }
    else if (isValid === false) { b.className = 'badge badge-failed';  b.textContent = 'DSL: invalid ✗'; }
    else                   { b.className = 'badge badge-pending';  b.textContent = 'DSL: unchecked'; }
  }

  // ── MCP panel ──────────────────────────────────────────────
  function showMcpPanel(run) {
    const card = document.getElementById('mcp-card');
    if (!run.mcpPostProcess) return;
    card.style.display = '';

    if (run.mcpDone) {
      document.getElementById('mcp-run-btn').disabled = true;
      document.getElementById('mcp-run-btn').textContent = 'MCP Done ✓';
      return;
    }

    document.getElementById('mcp-run-btn').addEventListener('click', () => {
      runMcpPostProcess(run.id);
    });
  }

  function runMcpPostProcess(id) {
    const btn = document.getElementById('mcp-run-btn');
    const out = document.getElementById('mcp-output');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Running…';
    out.style.display = 'block';
    out.textContent = '';

    const es = new EventSource(`/api/runs/${id}/mcp`);
    es.addEventListener('log', (e) => {
      const { line } = JSON.parse(e.data);
      out.textContent += line + '\n';
      out.scrollTop = out.scrollHeight;
    });
    es.addEventListener('done', (e) => {
      const { status } = JSON.parse(e.data);
      btn.textContent = status === 'done' ? 'MCP Done ✓' : 'MCP Failed ✗';
      es.close();
    });
    es.onerror = () => {
      out.textContent += '\n[connection closed]\n';
      es.close();
    };
  }

  // ── Artifact browser ───────────────────────────────────────
  async function loadArtifacts(runId) {
    const card = document.getElementById('artifacts-card');
    card.style.display = '';

    try {
      const res = await fetch(`/api/runs/${runId}/artifacts`);
      const { files, root } = await res.json();
      const tree = document.getElementById('artifact-tree');

      if (!files || !files.length) {
        tree.innerHTML = '<p style="padding:8px 12px;font-size:12px;color:#57606a;">No architecture/ artifacts found yet.</p>';
        return;
      }

      tree.innerHTML = '';
      const rootUl = buildTree(runId, files);
      tree.appendChild(rootUl);
    } catch (err) {
      document.getElementById('artifact-tree').innerHTML =
        `<p style="padding:8px 12px;font-size:12px;color:#b91c1c;">${esc(err.message)}</p>`;
    }
  }

  // ── Structurizr Lite panel ─────────────────────────────────
  function initStructurizrPanel(runId) {
    const card = document.getElementById('structurizr-card');
    card.style.display = '';

    const startBtn      = document.getElementById('structurizr-start-btn');
    const stopBtn       = document.getElementById('structurizr-stop-btn');
    const validateBtn   = document.getElementById('structurizr-validate-btn');
    const openLink      = document.getElementById('structurizr-open-link');
    const badge         = document.getElementById('structurizr-status-badge');
    const msgEl         = document.getElementById('structurizr-msg');
    const validateOut   = document.getElementById('structurizr-validate-output');
    const infoEl        = document.getElementById('structurizr-info');
    const dslDirEl      = document.getElementById('structurizr-dsl-dir');
    const urlText       = document.getElementById('structurizr-url-text');

    // Apply persisted dslValid state immediately (from pipeline quality loop)
    fetch(`/api/runs/${runId}`)
      .then((r) => r.json())
      .then((run) => {
        applyDslValidBadge(run.dslValid);
        if (run.dslValid === true) {
          startBtn.disabled = false;
          startBtn.title = '';
        } else if (run.dslValid === false) {
          setMsg('DSL validation failed during the pipeline run. Use "Validate DSL" to see errors, then fix and re-validate.', true);
        }
        // Restore running container state if any
        badge.style.display = '';
      })
      .catch(() => { badge.style.display = ''; });

    function setMsg(text, isError) {
      if (!text) { msgEl.style.display = 'none'; return; }
      msgEl.className = 'alert ' + (isError ? 'alert-error' : 'alert-info');
      msgEl.textContent = text;
      msgEl.style.display = '';
    }

    function setRunning(url, dslDir) {
      badge.className = 'badge badge-running';
      badge.textContent = 'Running';
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
      openLink.href = url;
      openLink.style.display = '';
      dslDirEl.textContent = dslDir;
      urlText.href = url;
      urlText.textContent = url;
      infoEl.style.display = '';
      setMsg('');
    }

    function setStopped() {
      badge.className = 'badge badge-pending';
      badge.textContent = 'Not started';
      startBtn.style.display = '';
      stopBtn.style.display = 'none';
      openLink.style.display = 'none';
      infoEl.style.display = 'none';
    }

    // Check if already running for this run
    fetch('/api/structurizr/status')
      .then((r) => r.json())
      .then((s) => {
        if (!s.available) {
          setMsg('Docker is not available. Install Docker Desktop to use this feature.', true);
          startBtn.disabled = true;
          return;
        }
        if (s.running && s.runId === runId) {
          setRunning(`http://localhost:${s.port}`, s.dslDir);
        }
      })
      .catch(() => {});

    // Validate button
    validateBtn.addEventListener('click', () => {
      validateBtn.disabled = true;
      validateBtn.innerHTML = '<span class="spinner"></span> Validating…';
      validateOut.style.display = '';
      validateOut.textContent = '';
      setMsg('');

      // The validate route is SSE over POST — stream it via fetch body reader
      fetch('/api/structurizr/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      }).then(async (res) => {
        if (!res.ok) {
          const d = await res.json();
          validateOut.textContent = 'Error: ' + d.error;
          validateBtn.disabled = false;
          validateBtn.textContent = '✓ Validate DSL';
          return;
        }
        // Stream SSE manually from the fetch response body
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let passed = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            const eventMatch = part.match(/^event: (\w+)/m);
            const dataMatch  = part.match(/^data: (.+)/m);
            if (!dataMatch) continue;
            const payload = JSON.parse(dataMatch[1]);
            if (eventMatch && eventMatch[1] === 'log') {
              validateOut.textContent += payload.line + '\n';
              validateOut.scrollTop = validateOut.scrollHeight;
            } else if (eventMatch && eventMatch[1] === 'done') {
              passed = payload.passed;
            }
          }
        }

        validateBtn.disabled = false;
        if (passed === true) {
          validateBtn.textContent = '✓ Valid';
          validateBtn.style.background = '#16a34a';
          validateBtn.style.color = '#fff';
          validateBtn.style.borderColor = '#16a34a';
          setMsg('');
          // Unlock preview and persist the valid status
          applyDslValidBadge(true);
          startBtn.disabled = false;
          startBtn.title = '';
          // Persist to store so page refresh keeps the state
          fetch(`/api/runs/${runId}/dsl-valid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dslValid: true }) }).catch(() => {});
        } else {
          validateBtn.textContent = '✗ Invalid';
          validateBtn.style.background = '#b91c1c';
          validateBtn.style.color = '#fff';
          validateBtn.style.borderColor = '#b91c1c';
          setMsg('DSL has errors — see output above. Fix the highlighted lines, then re-validate.', true);
          applyDslValidBadge(false);
          fetch(`/api/runs/${runId}/dsl-valid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dslValid: false }) }).catch(() => {});
        }
        // Reset button appearance after 10s
        setTimeout(() => {
          validateBtn.textContent = '✓ Validate DSL';
          validateBtn.style.background = '';
          validateBtn.style.color = '';
          validateBtn.style.borderColor = '';
        }, 10000);
      }).catch((err) => {
        validateOut.textContent = 'Error: ' + err.message;
        validateBtn.disabled = false;
        validateBtn.textContent = '✓ Validate DSL';
      });
    });

    // Start button
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.innerHTML = '<span class="spinner"></span> Starting…';
      setMsg('Pulling structurizr/structurizr image if needed, then starting container…', false);

      try {
        const res = await fetch('/api/structurizr/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        });
        const data = await res.json();
        if (!res.ok) {
          setMsg(data.error, true);
          startBtn.disabled = false;
          startBtn.innerHTML = '▶ Start Preview';
          return;
        }
        setRunning(data.url, data.dslDir);
        setMsg('Waiting for Structurizr to become ready…', false);
        // Poll until the container responds, then open — Spring Boot typically takes 6–10s
        waitForStructurizr(data.url, () => {
          setMsg('');
          window.open(data.url, '_blank', 'noopener');
        });
      } catch (err) {
        setMsg('Failed to start: ' + err.message, true);
        startBtn.disabled = false;
        startBtn.innerHTML = '▶ Start Preview';
      }
    });

    // Stop button
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
      try {
        await fetch('/api/structurizr/stop', { method: 'POST' });
      } catch { /* ignore */ }
      setStopped();
      stopBtn.disabled = false;
      stopBtn.textContent = '■ Stop';
    });
  }

  function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'md')   return '📝';
    if (ext === 'dsl')  return '🏗️';
    if (ext === 'json') return '📦';
    if (ext === 'yaml' || ext === 'yml') return '⚙️';
    if (ext === 'sh')   return '🖥️';
    return '📄';
  }

  function buildTree(runId, nodes) {
    const ul = document.createElement('ul');
    for (const node of nodes) {
      const li = document.createElement('li');
      if (node.type === 'dir') {
        const dirEl = document.createElement('div');
        dirEl.className = 'tree-dir';
        // collapsible
        const toggle = document.createElement('span');
        toggle.style.cssText = 'cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px;width:100%';
        toggle.innerHTML = `<span class="dir-arrow" style="font-size:10px;transition:transform .15s">▶</span> 📁 ${esc(node.name)}`;
        dirEl.appendChild(toggle);
        li.appendChild(dirEl);
        if (node.children && node.children.length) {
          const sub = buildTree(runId, node.children);
          sub.style.display = 'none'; // collapsed by default
          li.appendChild(sub);
          toggle.addEventListener('click', () => {
            const open = sub.style.display !== 'none';
            sub.style.display = open ? 'none' : '';
            toggle.querySelector('.dir-arrow').style.transform = open ? '' : 'rotate(90deg)';
          });
        }
      } else {
        const fileEl = document.createElement('div');
        fileEl.className = 'tree-file';
        fileEl.dataset.path = node.path;
        fileEl.innerHTML = `${fileIcon(node.name)} ${esc(node.name)}`;
        fileEl.addEventListener('click', () => openArtifact(runId, node.path, node.name, fileEl));
        li.appendChild(fileEl);
      }
      ul.appendChild(li);
    }
    return ul;
  }

  // ── Viewer state ───────────────────────────────────────────
  let currentViewerMode = 'rendered'; // 'rendered' | 'raw'
  let currentViewerContent = '';
  let currentViewerExt = '';

  function renderViewerContent(viewer, ext, content, mode) {
    // Remove any existing content panel
    const old = viewer.querySelector('.artifact-viewer-content, .artifact-viewer-md, .artifact-viewer-dsl');
    if (old) old.remove();

    if (ext === 'md' && mode === 'rendered') {
      const div = document.createElement('div');
      div.className = 'artifact-viewer-md';
      div.innerHTML = renderMarkdown(content);
      viewer.appendChild(div);
    } else if (ext === 'dsl' && mode === 'rendered') {
      const pre = document.createElement('pre');
      pre.className = 'artifact-viewer-dsl';
      pre.innerHTML = highlightDsl(content);
      viewer.appendChild(pre);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'artifact-viewer-content';
      pre.textContent = content;
      viewer.appendChild(pre);
    }
  }

  async function openArtifact(runId, relPath, name, el) {
    document.querySelectorAll('.tree-file.active').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');

    const ext = name.split('.').pop().toLowerCase();
    const hasModes = ext === 'md' || ext === 'dsl';
    currentViewerExt = ext;
    currentViewerMode = 'rendered'; // default to rendered view

    const viewer = document.getElementById('artifact-viewer');

    // Build header with optional mode toggle
    let toggleHtml = '';
    if (ext === 'md') {
      toggleHtml = `<div class="viewer-mode-toggle">
        <button id="vmode-rendered" class="active">Rendered</button>
        <button id="vmode-raw">Raw</button>
      </div>`;
    } else if (ext === 'dsl') {
      toggleHtml = `<div class="viewer-mode-toggle">
        <button id="vmode-rendered" class="active">Highlighted</button>
        <button id="vmode-raw">Raw</button>
      </div>`;
    }

    viewer.innerHTML = `
      <div class="artifact-viewer-header">
        <span class="viewer-path" title="${esc(relPath)}">${esc(relPath)}</span>
        ${toggleHtml}
      </div>
      <pre class="artifact-viewer-content"><span class="spinner"></span> Loading…</pre>`;

    // Attach toggle listeners before fetch completes
    if (hasModes) {
      viewer.querySelector('#vmode-rendered').addEventListener('click', () => {
        if (currentViewerMode === 'rendered') return;
        currentViewerMode = 'rendered';
        viewer.querySelector('#vmode-rendered').classList.add('active');
        viewer.querySelector('#vmode-raw').classList.remove('active');
        renderViewerContent(viewer, currentViewerExt, currentViewerContent, 'rendered');
      });
      viewer.querySelector('#vmode-raw').addEventListener('click', () => {
        if (currentViewerMode === 'raw') return;
        currentViewerMode = 'raw';
        viewer.querySelector('#vmode-raw').classList.add('active');
        viewer.querySelector('#vmode-rendered').classList.remove('active');
        renderViewerContent(viewer, currentViewerExt, currentViewerContent, 'raw');
      });
    }

    try {
      const res = await fetch(`/api/runs/${runId}/artifacts/read?file=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const { error } = await res.json();
        viewer.querySelector('.artifact-viewer-content').textContent = `Error: ${error}`;
        return;
      }
      const { content } = await res.json();
      currentViewerContent = content;
      renderViewerContent(viewer, ext, content, currentViewerMode);
    } catch (err) {
      const el2 = viewer.querySelector('.artifact-viewer-content');
      if (el2) el2.textContent = `Error: ${err.message}`;
    }
  }

  // ── Bootstrap: load run, then open SSE ────────────────────
  async function bootstrap() {
    let run;
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (!res.ok) { showError(errBox, `Run not found: ${runId}`); return; }
      run = await res.json();
    } catch (err) {
      showError(errBox, `Failed to load run: ${err.message}`);
      return;
    }

    updateHeader(run);

    // Replay stage statuses from stored run
    for (const stage of run.stages) {
      if (stage.status !== 'pending') updateStageUI(stage.name, stage.status);
    }

    // Show MCP panel, Structurizr panel & artifacts if run is already finished
    if (run.status !== 'running') {
      showMcpPanel(run);
      initStructurizrPanel(runId);
      loadArtifacts(runId);
    }

    // Open SSE stream
    const es = new EventSource(`/api/runs/${runId}/stream`);

    es.addEventListener('log', (e) => {
      const { stageName, line } = JSON.parse(e.data);
      appendLog(stageName, line);
    });

    es.addEventListener('stage', (e) => {
      const { stageName, status } = JSON.parse(e.data);
      updateStageUI(stageName, status);
    });

    es.addEventListener('run', (e) => {
      const { status } = JSON.parse(e.data);
      // Refresh full run record
      fetch(`/api/runs/${runId}`)
        .then((r) => r.json())
        .then((updated) => {
          updateHeader(updated);
          showMcpPanel(updated);
          initStructurizrPanel(runId);
          loadArtifacts(runId);
          es.close();
        });
    });

    es.onerror = () => {
      // Connection dropped — could be server restart; stop reconnecting
      es.close();
    };
  }

  bootstrap();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Shared helpers
═══════════════════════════════════════════════════════════════════════════ */

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = '';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Boot — detect which page we are on
═══════════════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('run-form')) {
    initIndexPage();
  } else if (document.getElementById('log-panel')) {
    initRunPage();
  }
});
