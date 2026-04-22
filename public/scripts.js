// ── Scripts Page Frontend ──

(() => {
  "use strict";

  // ── State ──
  let scripts = [];
  let runs = [];
  let selectedScriptId = null;
  let selectedRunId = null;
  let ws = null;
  let editingScriptId = null; // null = adding, string = editing
  let autoScroll = true;
  let outputOffset = 0;       // byte offset of earliest content loaded
  let outputHasEarlier = false;
  let loadingOutput = false;

  // ── DOM refs ──
  const scriptListEl = document.getElementById("script-list");
  const scriptsEmpty = document.getElementById("scripts-empty");
  const scriptDetail = document.getElementById("script-detail");
  const detailName = document.getElementById("detail-name");
  const detailDescription = document.getElementById("detail-description");
  const detailCommand = document.getElementById("detail-command");
  const detailCwd = document.getElementById("detail-cwd");
  const runHistoryEl = document.getElementById("run-history");
  const outputLog = document.getElementById("output-log");
  const outputTitle = document.getElementById("output-title");
  const killBtn = document.getElementById("kill-btn");
  const runScriptBtn = document.getElementById("run-script-btn");
  const editScriptBtn = document.getElementById("edit-script-btn");
  const deleteScriptBtn = document.getElementById("delete-script-btn");
  const addScriptBtn = document.getElementById("add-script-btn");
  const emptyAddBtn = document.getElementById("empty-add-btn");

  // Dialog refs
  const scriptDialog = document.getElementById("script-dialog");
  const scriptDialogTitle = document.getElementById("script-dialog-title");
  const scriptName = document.getElementById("script-name");
  const scriptDescription = document.getElementById("script-description");
  const scriptPath = document.getElementById("script-path");
  const scriptArgs = document.getElementById("script-args");
  const scriptCwd = document.getElementById("script-cwd");
  const scriptDialogCancel = document.getElementById("script-dialog-cancel");
  const scriptDialogSave = document.getElementById("script-dialog-save");

  // ── WebSocket ──
  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWsMessage(msg);
      } catch {}
    };

    ws.onclose = () => setTimeout(connectWs, 2000);
    ws.onerror = () => ws.close();
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "script_run_started":
        runs.push(msg.run);
        if (msg.run.scriptId === selectedScriptId) {
          selectedRunId = msg.run.id;
          renderRunHistory();
          // Reset output for this new run — will stream via WS
          outputLog.textContent = "";
          outputOffset = 0;
          outputHasEarlier = false;
          updateKillButton();
          updateOutputTitle();
        }
        renderScriptList();
        break;
      case "script_run_output":
        if (msg.runId === selectedRunId) {
          appendOutputLine(msg.line);
        }
        break;
      case "script_run_done": {
        const doneRun = runs.find(r => r.id === msg.runId);
        if (doneRun) {
          doneRun.status = msg.status;
          doneRun.exitCode = msg.exitCode;
          doneRun.completedAt = new Date().toISOString();
        }
        if (msg.runId === selectedRunId) {
          renderRunHistory();
          updateKillButton();
          updateOutputTitle();
        }
        renderScriptList();
        break;
      }
    }
  }

  // ── API helpers ──
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...opts.headers },
      ...opts,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function loadScripts() {
    scripts = await api("/api/scripts");
    renderScriptList();
    updateEmptyState();
  }

  async function loadRuns() {
    runs = await api("/api/scripts/runs");
  }

  // ── Rendering ──
  function renderScriptList() {
    scriptListEl.innerHTML = "";
    for (const s of scripts) {
      const el = document.createElement("div");
      el.className = "script-item" + (s.id === selectedScriptId ? " active" : "");
      const activeRun = runs.find(r => r.scriptId === s.id && r.status === "running");
      el.innerHTML = `
        <div class="script-item-info">
          <div class="script-item-name">${esc(s.name)}</div>
          ${s.description ? `<div class="script-item-desc">${esc(s.description)}</div>` : ""}
        </div>
        ${activeRun ? '<span class="script-item-status running">● running</span>' : ""}
      `;
      el.onclick = () => selectScript(s.id);
      scriptListEl.appendChild(el);
    }
  }

  function selectScript(id) {
    selectedScriptId = id;
    const scriptRuns = runs.filter(r => r.scriptId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    selectedRunId = scriptRuns.length > 0 ? scriptRuns[0].id : null;
    renderScriptList();
    renderDetail();
    updateEmptyState();
    // Close sidebar on mobile after selection
    const sb = document.getElementById("scripts-sidebar");
    if (sb) sb.classList.remove("open");
  }

  function renderDetail() {
    const s = scripts.find(s => s.id === selectedScriptId);
    if (!s) {
      scriptDetail.style.display = "none";
      return;
    }
    scriptDetail.style.display = "flex";
    detailName.textContent = s.name;
    detailDescription.textContent = s.description || "";
    detailCommand.textContent = s.path + (s.args?.length ? " " + s.args.join(" ") : "");
    detailCwd.textContent = s.cwd ? `📁 ${s.cwd}` : "";
    renderRunHistory();
    renderOutput();
  }

  function renderRunHistory() {
    const scriptRunsSorted = runs
      .filter(r => r.scriptId === selectedScriptId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    runHistoryEl.innerHTML = "";
    for (const r of scriptRunsSorted) {
      const chip = document.createElement("span");
      chip.className = "run-chip" + (r.id === selectedRunId ? " active" : "");
      const time = formatTime(r.startedAt);
      chip.innerHTML = `<span class="dot ${r.status}"></span> ${time}`;
      chip.title = `${r.status}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`;
      chip.onclick = () => {
        selectedRunId = r.id;
        renderRunHistory();
        renderOutput();
      };
      runHistoryEl.appendChild(chip);
    }
  }

  async function renderOutput() {
    outputLog.textContent = "";
    autoScroll = true;
    outputOffset = 0;
    outputHasEarlier = false;
    hideLoadMoreBtn();
    const run = runs.find(r => r.id === selectedRunId);
    if (!run) {
      updateKillButton();
      updateOutputTitle();
      return;
    }
    // Load last page of output (tail)
    await loadOutputTail();
    updateKillButton();
    updateOutputTitle();
    // Scroll to bottom
    outputLog.scrollTop = outputLog.scrollHeight;
  }

  async function loadOutputTail() {
    if (!selectedRunId || loadingOutput) return;
    loadingOutput = true;
    try {
      const data = await api(`/api/scripts/runs/${selectedRunId}/output?tail=65536`);
      for (const line of data.lines) {
        appendOutputLine(line);
      }
      outputOffset = data.startByte;
      outputHasEarlier = data.startByte > 0;
      if (outputHasEarlier) {
        showLoadEarlierBtn();
      }
    } catch (e) {
      appendOutputLine(`[error loading output: ${e.message}]`);
    } finally {
      loadingOutput = false;
    }
  }

  async function loadEarlierOutput() {
    if (!selectedRunId || loadingOutput || outputOffset <= 0) return;
    loadingOutput = true;
    try {
      const chunkSize = 65536;
      const start = Math.max(0, outputOffset - chunkSize);
      const limit = outputOffset - start;
      const data = await api(`/api/scripts/runs/${selectedRunId}/output?offset=${start}&limit=${limit}`);

      // Save scroll position relative to bottom
      const prevHeight = outputLog.scrollHeight;
      const prevTop = outputLog.scrollTop;

      // Prepend lines at the top
      const frag = document.createDocumentFragment();
      for (const line of data.lines) {
        frag.appendChild(document.createTextNode(line + "\n"));
      }
      outputLog.insertBefore(frag, outputLog.firstChild);

      // Restore scroll position
      const newHeight = outputLog.scrollHeight;
      outputLog.scrollTop = prevTop + (newHeight - prevHeight);

      outputOffset = start;
      outputHasEarlier = start > 0;
      if (!outputHasEarlier) {
        hideLoadMoreBtn();
      }
    } catch (e) {
      appendOutputLine(`[error loading earlier output: ${e.message}]`);
    } finally {
      loadingOutput = false;
    }
  }

  function showLoadEarlierBtn() {
    let btn = document.getElementById("load-more-output");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "load-more-output";
      btn.className = "dialog-btn dialog-btn-secondary";
      btn.style.cssText = "margin: 8px 20px; font-size: 12px;";
      outputLog.parentElement.insertBefore(btn, outputLog);
    }
    btn.textContent = "Load earlier output…";
    btn.onclick = loadEarlierOutput;
    btn.style.display = "";
  }

  function hideLoadMoreBtn() {
    const btn = document.getElementById("load-more-output");
    if (btn) btn.style.display = "none";
  }

  function appendOutputLine(line) {
    const lineEl = document.createTextNode(line + "\n");
    outputLog.appendChild(lineEl);
    if (autoScroll) {
      outputLog.scrollTop = outputLog.scrollHeight;
    }
  }

  function updateKillButton() {
    const run = runs.find(r => r.id === selectedRunId);
    killBtn.style.display = run && run.status === "running" ? "" : "none";
  }

  function updateOutputTitle() {
    const run = runs.find(r => r.id === selectedRunId);
    if (!run) {
      outputTitle.textContent = "Output";
      return;
    }
    const statusText = run.status === "running" ? "Running…"
      : run.status === "done" ? `Done (exit 0)`
      : run.status === "failed" ? `Failed (exit ${run.exitCode ?? "?"})`
      : "Killed";
    outputTitle.textContent = `Output — ${statusText}`;
  }

  function updateEmptyState() {
    if (scripts.length === 0) {
      scriptsEmpty.style.display = "flex";
      scriptDetail.style.display = "none";
    } else {
      scriptsEmpty.style.display = selectedScriptId ? "none" : "flex";
    }
  }

  // ── Script CRUD dialog ──
  function openScriptDialog(scriptId) {
    editingScriptId = scriptId;
    const s = scriptId ? scripts.find(x => x.id === scriptId) : null;
    scriptDialogTitle.textContent = s ? "Edit Script" : "Add Script";
    scriptName.value = s?.name || "";
    scriptDescription.value = s?.description || "";
    scriptPath.value = s?.path || "";
    scriptArgs.value = s?.args?.join("\n") || "";
    scriptCwd.value = s?.cwd || "";
    scriptDialog.style.display = "flex";
    scriptName.focus();
  }

  function closeScriptDialog() {
    scriptDialog.style.display = "none";
    editingScriptId = null;
  }

  async function saveScript() {
    const name = scriptName.value.trim();
    const path = scriptPath.value.trim();
    if (!name || !path) { alert("Name and Process Path are required"); return; }

    const body = {
      name,
      description: scriptDescription.value.trim(),
      path,
      args: scriptArgs.value.split("\n").map(s => s.trim()).filter(Boolean),
      cwd: scriptCwd.value.trim(),
    };

    try {
      if (editingScriptId) {
        await api(`/api/scripts/${editingScriptId}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        const created = await api("/api/scripts", { method: "POST", body: JSON.stringify(body) });
        selectedScriptId = created.id;
      }
      await loadScripts();
      renderDetail();
      closeScriptDialog();
    } catch (e) {
      alert("Error saving script: " + e.message);
    }
  }

  async function deleteScript(id) {
    if (!confirm("Delete this script configuration?")) return;
    try {
      await api(`/api/scripts/${id}`, { method: "DELETE" });
      if (selectedScriptId === id) {
        selectedScriptId = null;
        selectedRunId = null;
      }
      await loadScripts();
      renderDetail();
      updateEmptyState();
    } catch (e) {
      alert("Error: " + e.message);
    }
  }

  async function runScript(id) {
    try {
      await api(`/api/scripts/${id}/run`, { method: "POST" });
    } catch (e) {
      alert("Error starting script: " + e.message);
    }
  }

  async function killRun(runId) {
    try {
      await api(`/api/scripts/runs/${runId}/kill`, { method: "POST" });
    } catch (e) {
      alert("Error killing process: " + e.message);
    }
  }

  // ── Event bindings ──
  const sidebar = document.getElementById("scripts-sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  const menuBtn = document.getElementById("menu-btn");

  function openSidebar() { sidebar.classList.add("open"); }
  function closeSidebar() { sidebar.classList.remove("open"); }

  menuBtn.onclick = openSidebar;
  const emptyMenuBtn = document.getElementById("empty-menu-btn");
  emptyMenuBtn.onclick = openSidebar;
  sidebarOverlay.onclick = closeSidebar;

  addScriptBtn.onclick = () => openScriptDialog(null);
  emptyAddBtn.onclick = () => openScriptDialog(null);
  editScriptBtn.onclick = () => openScriptDialog(selectedScriptId);
  deleteScriptBtn.onclick = () => deleteScript(selectedScriptId);
  runScriptBtn.onclick = () => runScript(selectedScriptId);
  killBtn.onclick = () => killRun(selectedRunId);
  scriptDialogCancel.onclick = closeScriptDialog;
  scriptDialogSave.onclick = saveScript;

  // Close dialog on overlay click
  scriptDialog.onclick = (e) => { if (e.target === scriptDialog) closeScriptDialog(); };

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeScriptDialog();
    if (e.key === "Enter" && scriptDialog.style.display !== "none") {
      e.preventDefault();
      saveScript();
    }
  });

  // Auto-scroll detection
  outputLog.addEventListener("scroll", () => {
    autoScroll = outputLog.scrollTop + outputLog.clientHeight >= outputLog.scrollHeight - 30;
  });

  // ── Util ──
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ── Init ──
  async function init() {
    connectWs();
    await loadRuns();
    await loadScripts();
    // If scripts exist, auto-select first
    if (scripts.length > 0 && !selectedScriptId) {
      selectScript(scripts[0].id);
    }
  }

  init();
})();
