// ── Copilot Sessions – Web Client ──

(function () {
  "use strict";

  // ── Config ──

  const WS_PATH = "/ws";
  // Unique ID for this browser tab — used for server-side connection deduplication
  const CLIENT_ID = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ── State ──

  let ws = null;
  let currentSessionId = null;
  let sessions = [];
  let isStreaming = false;
  const streamingSessionIds = new Set(); // track which sessions are actively streaming
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const seenMessageIds = new Set();
  const reasoningBlocks = new Map(); // reasoningId → { block, contentEl, streaming }
  const trackedProcesses = new Map(); // processId → process object
  let sendMode = "normal"; // "normal" or "loop"
  let loopActive = false;
  const loopingSessions = new Set(); // sessionIds with active loops
  let menuHideTimer = null;

  // ── DOM refs ──

  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  const menuBtn = document.getElementById("menu-btn");
  const newSessionBtn = document.getElementById("new-session-btn");
  const sessionListEl = document.getElementById("session-list");
  const chatTitle = document.getElementById("chat-title");
  const messagesEl = document.getElementById("messages");
  const messageInput = document.getElementById("message-input");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const headerCwd = document.getElementById("header-cwd");
  const headerModelSelect = document.getElementById("header-model-select");
  const newSessionDialog = document.getElementById("new-session-dialog");
  const newCwdInput = document.getElementById("new-cwd-input");
  const newModelSelect = document.getElementById("new-model-select");
  const newSessionCancel = document.getElementById("new-session-cancel");
  const newSessionCreate = document.getElementById("new-session-create");
  const contextBar = document.getElementById("context-bar");
  const contextBarFill = document.getElementById("context-bar-fill");
  const contextBarLabel = document.getElementById("context-bar-label");
  const diffBtn = document.getElementById("diff-btn");
  const diffPanel = document.getElementById("diff-panel");
  const diffOverlay = document.getElementById("diff-overlay");
  const diffCloseBtn = document.getElementById("diff-close-btn");
  const diffRefreshBtn = document.getElementById("diff-refresh-btn");
  const diffStatEl = document.getElementById("diff-stat");
  const diffContentEl = document.getElementById("diff-content");
  const processesBtn = document.getElementById("processes-btn");
  const processesPanel = document.getElementById("processes-panel");
  const processesOverlay = document.getElementById("processes-overlay");
  const processesCloseBtn = document.getElementById("processes-close-btn");
  const processesListEl = document.getElementById("processes-list");
  const processesBadge = document.getElementById("processes-badge");
  const sendModeMenu = document.getElementById("send-mode-menu");
  const sendBtnWrapper = document.querySelector(".send-btn-wrapper");
  const loopIndicator = document.getElementById("loop-indicator");
  const loopIndicatorText = document.getElementById("loop-indicator-text");
  const loopStopBtn = document.getElementById("loop-stop-btn");

  // ── Markdown setup ──

  marked.use({ breaks: true, gfm: true });

  // Syntax highlight after rendering
  function highlightRenderedCode(el) {
    el.querySelectorAll("pre code").forEach((block) => {
      if (!block.dataset.highlighted) hljs.highlightElement(block);
    });
  }

  // ── WebSocket ──

  function getWsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${WS_PATH}`;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Kill any lingering old connection to prevent duplicate message handlers
    if (ws) {
      const oldWs = ws;
      oldWs.onclose = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      try { oldWs.close(); } catch {}
      ws = null;
    }

    const newWs = new WebSocket(getWsUrl());
    ws = newWs;

    newWs.onopen = () => {
      if (ws !== newWs) return; // stale connection
      console.log("[ws] connected");
      reconnectAttempts = 0;
      updateConnectionStatus(true);
      startHeartbeat();
      // Reset streaming state on reconnect — if the turn finished while we were
      // disconnected, we won't get another turn_end
      isStreaming = false;
      hideThinkingIndicator();
      updateSendState();
      wsSend({ type: "list_sessions" });
      wsSend({ type: "list_processes" });
      // Re-fetch current session history to pick up messages missed while disconnected
      if (currentSessionId) {
        console.log("[ws] reconnected — re-fetching session history");
        wsSend({ type: "resume_session", sessionId: currentSessionId });
      }
    };

    newWs.onmessage = (event) => {
      if (ws !== newWs) return; // stale connection — ignore
      try {
        const msg = JSON.parse(event.data);
        handleServerEvent(msg);
      } catch (e) {
        console.error("[ws] parse error:", e);
      }
    };

    newWs.onclose = (event) => {
      if (ws !== newWs) return; // already replaced
      console.log("[ws] disconnected, code:", event.code);
      stopHeartbeat();
      updateConnectionStatus(false);
      // If server rejected with 401, redirect to login
      if (event.code === 1006 && reconnectAttempts >= 2) {
        window.location.href = "/login.html";
        return;
      }
      scheduleReconnect();
    };

    newWs.onerror = (err) => {
      console.error("[ws] error:", err);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
    reconnectAttempts++;
    console.log(`[ws] reconnecting in ${delay}ms...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // Client-side heartbeat: send a ping every 25s, expect pong within 10s
  let heartbeatInterval = null;
  let heartbeatTimeout = null;

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: "ping" });
        heartbeatTimeout = setTimeout(() => {
          console.log("[ws] heartbeat timeout — forcing reconnect");
          if (ws) { try { ws.close(); } catch {} }
        }, 10000);
      }
    }, 25000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  }

  function onPong() {
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
    if (visibilityProbeTimeout) { clearTimeout(visibilityProbeTimeout); visibilityProbeTimeout = null; }
    lastPongTime = Date.now();
  }

  // Reconnect when tab regains focus — always verify with a ping
  // because readyState can still say OPEN on a dead connection after phone sleep
  let visibilityProbeTimeout = null;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (visibilityProbeTimeout) { clearTimeout(visibilityProbeTimeout); visibilityProbeTimeout = null; }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log("[ws] tab visible — connection dead, reconnecting");
        connect();
      } else {
        // Connection *looks* alive — verify with a quick ping
        console.log("[ws] tab visible — verifying connection...");
        wsSend({ type: "ping" });
        visibilityProbeTimeout = setTimeout(() => {
          visibilityProbeTimeout = null;
          console.log("[ws] tab visible — ping timeout, forcing reconnect");
          stopHeartbeat();
          if (ws) { try { ws.close(); } catch {} ws = null; }
          updateConnectionStatus(false);
          connect();
        }, 5000);
      }
    }
  });

  // ── Connection watchdog ──
  // Runs every 3s. When phone sleeps, timers freeze; on wake the callback fires
  // and detects the gap. This catches cases visibilitychange misses.
  let lastPongTime = Date.now();
  let lastWatchdogTime = Date.now();

  setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastWatchdogTime;
    lastWatchdogTime = now;

    // If >10s elapsed since last tick, we probably just woke from sleep
    const wokeFromSleep = elapsed > 10000;

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      updateConnectionStatus(false);
      if (!reconnectTimer) {
        console.log("[watchdog] connection dead, reconnecting");
        connect();
      }
    } else if (wokeFromSleep && ws.readyState === WebSocket.OPEN) {
      // Just woke up — force a probe
      console.log(`[watchdog] woke from sleep (${Math.round(elapsed/1000)}s gap), probing...`);
      wsSend({ type: "ping" });
      // Give it 5s to respond, otherwise force reconnect
      if (!visibilityProbeTimeout) {
        visibilityProbeTimeout = setTimeout(() => {
          visibilityProbeTimeout = null;
          console.log("[watchdog] ping timeout after wake, forcing reconnect");
          stopHeartbeat();
          if (ws) { try { ws.close(); } catch {} ws = null; }
          updateConnectionStatus(false);
          connect();
        }, 5000);
      }
    }
  }, 3000);

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...msg, clientId: CLIENT_ID }));
    }
  }

  function updateConnectionStatus(connected) {
    let dot = document.querySelector(".connection-dot");
    if (!dot) {
      dot = document.createElement("div");
      dot.className = "connection-dot";
      document.querySelector(".chat-header").appendChild(dot);
    }
    dot.classList.toggle("connected", connected);
    dot.title = connected ? "Connected" : "Disconnected";

    // Show/hide a disconnected banner at the top of the chat
    let banner = document.getElementById("disconnect-banner");
    if (!connected) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "disconnect-banner";
        banner.textContent = "Disconnected — reconnecting…";
        const chatArea = document.querySelector(".chat-messages");
        chatArea.parentNode.insertBefore(banner, chatArea);
      }
      banner.style.display = "block";
    } else if (banner) {
      banner.style.display = "none";
    }
  }

  // ── Server event handlers ──

  function handleServerEvent(msg) {
    // Deduplicate: if the server tagged this message with _mid, skip if already seen
    if (msg._mid != null) {
      if (seenMessageIds.has(msg._mid)) {
        console.log("[dedup] skipping duplicate _mid:", msg._mid, msg.type);
        return;
      }
      seenMessageIds.add(msg._mid);
      // Keep the set from growing unbounded
      if (seenMessageIds.size > 500) {
        const iter = seenMessageIds.values();
        for (let i = 0; i < 250; i++) iter.next();
        // Can't easily trim a Set; just clear old ones
        const keep = new Set();
        for (const v of seenMessageIds) keep.add(v);
        // Actually just let it grow to 500, it's fine
      }
    }
    switch (msg.type) {
      case "pong":
        onPong();
        return;
      case "session_list":
        sessions = msg.sessions || [];
        renderSessionList();
        break;

      case "session_created":
        currentSessionId = msg.sessionId;
        console.log("[ui] session created:", msg.sessionId);
        sessions.unshift({
          sessionId: msg.sessionId,
          title: msg.title || "New session",
          cwd: msg.cwd || "",
          model: msg.model || "",
          createdAt: msg.createdAt,
          updatedAt: msg.createdAt,
        });
        renderSessionList();
        clearMessages();
        chatTitle.textContent = msg.title || "New session";
        updateHeaderMeta(msg.cwd, msg.model);
        closeSidebar();
        messageInput.focus();
        updateSendState();
        break;

      case "session_history":
        if (msg.sessionId === currentSessionId) {
          clearMessages();
          renderHistory(msg.messages || []);
        }
        break;

      case "token":
        if (msg.sessionId === currentSessionId) {
          appendToken(msg.text);
        }
        break;

      // User message from another device — render it locally
      case "user_message":
        if (msg.sessionId === currentSessionId) {
          appendUserMessage(msg.content);
        }
        break;

      case "assistant_message":
        // Full message received — only render if we weren't already streaming it
        if (msg.sessionId === currentSessionId) {
          if (!streamingBubble) {
            // No streaming happened, render the full message
            if (msg.content) {
              appendAssistantMessage(msg.content);
            }
          }
          // If we were streaming, the content is already visible — just finalize
          finishStreaming(msg.sessionId);
        }
        break;

      case "turn_start":
        streamingSessionIds.add(msg.sessionId);
        if (msg.sessionId === currentSessionId) {
          isStreaming = true;
          reasoningBlocks.clear();
          showThinkingIndicator();
          updateSendState();
        }
        break;

      case "reasoning_delta":
        if (msg.sessionId === currentSessionId) {
          hideThinkingIndicator();
          appendReasoningDelta(msg.reasoningId, msg.delta);
        }
        break;

      case "reasoning":
        if (msg.sessionId === currentSessionId) {
          finalizeReasoning(msg.reasoningId, msg.content);
        }
        break;

      case "usage_info":
        if (msg.sessionId === currentSessionId) {
          updateContextBar(msg.currentTokens, msg.tokenLimit);
        }
        break;

      case "tool_start":
        if (msg.sessionId === currentSessionId) {
          hideThinkingIndicator();
          appendToolStart(msg.name, msg.args, msg.callId, msg.intention);
        }
        break;

      case "tool_result":
        if (msg.sessionId === currentSessionId) {
          updateToolResult(msg.callId, msg.result, msg.name);
        }
        break;

      case "tool_partial":
        if (msg.sessionId === currentSessionId) {
          appendToolPartial(msg.callId, msg.output);
        }
        break;

      case "permission_requested":
        if (msg.sessionId === currentSessionId) {
          enrichToolWithPermission(msg);
        }
        break;

      case "permission_completed":
        // permission approved/denied — tool_result handles the UI update
        break;

      case "session_info":
        if (msg.sessionId === currentSessionId) {
          appendSessionInfo(msg.infoType, msg.message);
        }
        break;

      case "process_update":
        if (msg.process) {
          trackedProcesses.set(msg.process.id, msg.process);
          updateProcessBadge();
          renderProcessList();
        }
        break;

      case "process_list":
        trackedProcesses.clear();
        for (const proc of (msg.processes || [])) {
          trackedProcesses.set(proc.id, proc);
        }
        updateProcessBadge();
        renderProcessList();
        break;

      case "loop_started":
        loopingSessions.add(msg.sessionId);
        if (msg.sessionId === currentSessionId) {
          loopActive = true;
          loopIndicator.style.display = "flex";
          loopIndicatorText.textContent = "Loop mode — iteration 1";
        }
        break;

      case "loop_iteration":
        if (msg.sessionId === currentSessionId) {
          loopIndicatorText.textContent = `Loop mode — iteration ${msg.iteration}` + (msg.delay > 5000 ? ` (waiting ${Math.round(msg.delay / 1000)}s)` : "");
        }
        break;

      case "loop_ended":
        loopingSessions.delete(msg.sessionId);
        if (msg.sessionId === currentSessionId) {
          loopActive = false;
          loopIndicator.style.display = "none";
          const statusMsg = msg.status === "done" ? "completed" :
            msg.status === "blocked" ? `blocked: ${msg.reason}` :
            msg.status === "aborted" ? "stopped by user" :
            `error: ${msg.reason}`;
          appendSessionInfo("loop", `Loop ${statusMsg} after ${msg.iterations} iteration(s)`);
        }
        break;

      case "done":
        // Always clear streaming state for the session, even if not current
        streamingSessionIds.delete(msg.sessionId);
        // Bump this session to the top of the sidebar list
        {
          const doneSession = sessions.find(s => s.sessionId === msg.sessionId);
          if (doneSession) { doneSession.updatedAt = new Date().toISOString(); renderSessionList(); }
        }
        if (msg.sessionId === currentSessionId) {
          hideThinkingIndicator();
          finishStreaming(msg.sessionId);
        }
        break;

      case "session_resumed":
        if (msg.sessionId === currentSessionId) {
          console.log("[ui] session resumed:", msg.sessionId);
          updateHeaderMeta(msg.cwd, msg.model);
          closeSidebar();
          messageInput.focus();
          updateSendState();
        }
        break;

      case "title_changed":
        if (msg.sessionId === currentSessionId) {
          chatTitle.textContent = msg.title;
        }
        // Update in session list too
        {
          const s = sessions.find((s) => s.sessionId === msg.sessionId);
          if (s) {
            s.title = msg.title;
            renderSessionList();
          }
        }
        break;

      case "model_changed":
        {
          const s = sessions.find((s) => s.sessionId === msg.sessionId);
          if (s) s.model = msg.model;
          if (msg.sessionId === currentSessionId) {
            updateHeaderMeta(null, msg.model);
          }
        }
        break;

      case "info":
        if (msg.sessionId === currentSessionId) {
          appendInfoMessage(msg.message);
        }
        break;

      case "tool_progress":
        if (msg.sessionId === currentSessionId) {
          updateToolProgress(msg.callId, msg.progress);
        }
        break;

      case "subagent_start":
        if (msg.sessionId === currentSessionId) {
          appendInfoMessage(`Delegating to ${msg.agent}...`);
        }
        break;

      case "subagent_done":
        if (msg.sessionId === currentSessionId) {
          appendInfoMessage(`${msg.agent} finished`);
        }
        break;

      case "error":
        console.error("[server]", msg.message);
        if (!msg.sessionId || msg.sessionId === currentSessionId) {
          appendErrorMessage(msg.message);
          finishStreaming(msg.sessionId);
        }
        break;

      case "diff_result":
        renderDiffResult(msg);
        break;

      case "user_input_request":
        if (msg.sessionId === currentSessionId) {
          renderUserInputRequest(msg);
        }
        break;

      case "elicitation_request":
        if (msg.sessionId === currentSessionId) {
          renderElicitationRequest(msg);
        }
        break;
    }
  }

  // ── Session management ──

  function updateHeaderMeta(cwd, model) {
    if (cwd != null) {
      // On mobile, show just the folder name; on desktop show full path
      const displayCwd = window.innerWidth <= 768 ? cwd.split(/[/\\]/).filter(Boolean).pop() || cwd : cwd;
      headerCwd.textContent = displayCwd;
      headerCwd.title = cwd;
    }
    if (model != null) {
      headerModelSelect.style.display = "";
      // Set selected value (options already populated by fetchModels)
      headerModelSelect.value = model;
    }
    if (!currentSessionId) {
      headerCwd.textContent = "";
      headerModelSelect.style.display = "none";
      diffBtn.style.display = "none";
    } else {
      diffBtn.style.display = "";
    }
  }

  function renderSessionList() {
    sessionListEl.innerHTML = "";
    const sorted = [...sessions].sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    for (const s of sorted) {
      const div = document.createElement("div");
      div.className = "session-item" + (s.sessionId === currentSessionId ? " active" : "");

      const titleRow = document.createElement("div");
      titleRow.className = "session-title-row";

      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = s.title || "Session";
      titleRow.appendChild(title);

      const time = document.createElement("span");
      time.className = "session-time";
      time.textContent = formatRelativeTime(s.updatedAt || s.createdAt);
      titleRow.appendChild(time);

      const renameBtn = document.createElement("button");
      renameBtn.className = "session-rename";
      renameBtn.textContent = "✎";
      renameBtn.title = "Rename session";
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        startRenameSession(title, s);
      };
      titleRow.appendChild(renameBtn);

      const del = document.createElement("button");
      del.className = "session-delete";
      del.textContent = "×";
      del.title = "Delete session";
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm("Delete this session?")) {
          wsSend({ type: "delete_session", sessionId: s.sessionId });
          if (s.sessionId === currentSessionId) {
            currentSessionId = null;
            clearMessages();
            chatTitle.textContent = "Copilot Sessions";
          }
        }
      };
      titleRow.appendChild(del);

      div.appendChild(titleRow);

      // Show CWD as subtitle if available
      if (s.cwd) {
        const cwdEl = document.createElement("div");
        cwdEl.className = "session-cwd";
        const shortCwd = s.cwd.split(/[/\\]/).filter(Boolean).pop() || s.cwd;
        cwdEl.textContent = shortCwd;
        cwdEl.title = s.cwd;
        div.appendChild(cwdEl);
      }

      div.onclick = () => resumeSession(s.sessionId);
      sessionListEl.appendChild(div);
    }
  }

  function startRenameSession(titleEl, session) {
    const input = document.createElement("input");
    input.className = "session-rename-input";
    input.value = session.title || "";
    input.maxLength = 100;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const newName = input.value.trim();
      if (newName && newName !== session.title) {
        session.title = newName;
        wsSend({ type: "rename_session", sessionId: session.sessionId, name: newName });
        if (session.sessionId === currentSessionId) {
          chatTitle.textContent = newName;
        }
      }
      renderSessionList();
    }

    input.onblur = commit;
    input.onkeydown = (e) => {
      if (e.key === "Enter") { input.blur(); }
      if (e.key === "Escape") { input.onblur = null; renderSessionList(); }
    };
  }

  function resumeSession(sessionId) {
    currentSessionId = sessionId;
    // Sync streaming state to the target session
    isStreaming = streamingSessionIds.has(sessionId);
    hideThinkingIndicator();
    // Sync loop indicator to the target session
    loopActive = loopingSessions.has(sessionId);
    loopIndicator.style.display = loopActive ? "flex" : "none";
    updateSendState();
    const session = sessions.find((s) => s.sessionId === sessionId);
    chatTitle.textContent = session?.title || "Session";
    updateHeaderMeta(session?.cwd || "", session?.model || "");
    renderSessionList();
    closeSidebar();
    wsSend({ type: "resume_session", sessionId });
  }

  function formatRelativeTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d`;
    return d.toLocaleDateString();
  }

  // ── Message rendering ──

  function clearMessages() {
    messagesEl.innerHTML = "";
  }

  function renderHistory(messages) {
    clearMessages();

    let lastRole = null;
    for (const msg of messages) {
      switch (msg.role) {
        case "user":
          appendUserMessage(msg.content, msg.timestamp);
          break;
        case "assistant":
          if (msg.content) {
            const showTs = lastRole !== "assistant";
            appendAssistantMessage(msg.content, showTs ? msg.timestamp : null);
          }
          break;
        case "tool_call":
          appendToolStart(msg.name, msg.args, msg.callId, msg.intention);
          break;
        case "tool_result":
          updateToolResult(msg.parentId || msg.callId, msg.result, msg.name);
          break;
      }
      lastRole = msg.role;
    }

    scrollToBottom();
  }

  function formatTimestamp(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function appendUserMessage(text, timestamp) {
    const div = document.createElement("div");
    div.className = "message message-user";
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = renderMarkdown(text);
    div.appendChild(bubble);
    const ts = document.createElement("span");
    ts.className = "message-timestamp";
    ts.textContent = formatTimestamp(timestamp);
    div.appendChild(ts);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendAssistantMessage(markdown, timestamp) {
    const div = document.createElement("div");
    div.className = "message message-assistant";
    if (timestamp) {
      const ts = document.createElement("span");
      ts.className = "message-timestamp";
      ts.textContent = formatTimestamp(timestamp);
      div.appendChild(ts);
    }
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = renderMarkdown(markdown);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    highlightRenderedCode(bubble);
    addCopyButtons(bubble);
    scrollToBottom();
  }

  function appendErrorMessage(text) {
    const div = document.createElement("div");
    div.className = "message message-assistant";
    div.innerHTML = `<div class="message-bubble" style="color: var(--danger);">Error: ${escapeHtml(text)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendInfoMessage(text) {
    const div = document.createElement("div");
    div.className = "message message-assistant";
    div.innerHTML = `<div class="message-bubble" style="color: var(--text-muted); font-size: 12px; font-style: italic;">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function updateToolProgress(callId, progress) {
    const block = document.getElementById(`tool-${callId}`);
    if (block) {
      const status = block.querySelector(".tool-status");
      if (status) status.textContent = progress || "running...";
    }
  }

  // ── Thinking indicator ──

  let thinkingEl = null;

  function showThinkingIndicator() {
    hideThinkingIndicator();
    const div = document.createElement("div");
    div.className = "thinking-indicator";
    div.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div><span class="thinking-text">Thinking</span>`;
    messagesEl.appendChild(div);
    thinkingEl = div;
    scrollToBottom();
  }

  function hideThinkingIndicator() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  // ── Streaming ──

  let streamingBubble = null;
  let streamingBuffer = "";

  function appendToken(text) {
    hideThinkingIndicator();
    if (!streamingBubble) {
      isStreaming = true;
      const div = document.createElement("div");
      div.className = "message message-assistant";
      const ts = document.createElement("span");
      ts.className = "message-timestamp";
      ts.textContent = formatTimestamp();
      div.appendChild(ts);
      const bubble = document.createElement("div");
      bubble.className = "message-bubble streaming-cursor";
      div.appendChild(bubble);
      messagesEl.appendChild(div);
      streamingBubble = bubble;
      streamingBuffer = "";
      updateSendState();
    }

    streamingBuffer += text;
    streamingBubble.innerHTML = renderMarkdown(streamingBuffer);
    highlightRenderedCode(streamingBubble);
    addCopyButtons(streamingBubble);
    scrollToBottom();
  }

  function finishStreaming(sessionId) {
    if (sessionId) streamingSessionIds.delete(sessionId);
    if (streamingBubble) {
      streamingBubble.classList.remove("streaming-cursor");
      streamingBubble.innerHTML = renderMarkdown(streamingBuffer);
      highlightRenderedCode(streamingBubble);
      addCopyButtons(streamingBubble);
      streamingBubble = null;
      streamingBuffer = "";
    }
    // Finalize any still-streaming reasoning blocks
    for (const [, rb] of reasoningBlocks) {
      if (rb.streaming) {
        rb.streaming = false;
        const statusEl = rb.block.querySelector(".reasoning-status");
        if (statusEl) statusEl.textContent = "done";
      }
    }
    isStreaming = false;
    updateSendState();

    // Auto-generate title from first user message if still "New session"
    // (The CLI will also send title_changed events, but this is a fallback)
    const session = sessions.find((s) => s.sessionId === currentSessionId);
    if (session && (session.title === "New session" || !session.title)) {
      const firstUserMsg = messagesEl.querySelector(".message-user .message-bubble");
      if (firstUserMsg) {
        const title = firstUserMsg.textContent.trim().substring(0, 60);
        session.title = title || "New session";
        chatTitle.textContent = session.title;
        renderSessionList();
      }
    }
  }

  // ── Reasoning blocks ──

  function appendReasoningDelta(reasoningId, delta) {
    let rb = reasoningBlocks.get(reasoningId);
    if (!rb) {
      const block = document.createElement("div");
      block.className = "reasoning-block expanded";
      block.innerHTML = `
        <div class="reasoning-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="reasoning-icon">🧠</span>
          <span class="reasoning-label">Thinking</span>
          <span class="reasoning-status"><span class="spinner"></span></span>
          <span class="reasoning-chevron">▶</span>
        </div>
        <div class="reasoning-body">
          <div class="reasoning-content"></div>
        </div>`;
      messagesEl.appendChild(block);
      const contentEl = block.querySelector(".reasoning-content");
      rb = { block, contentEl, streaming: true };
      reasoningBlocks.set(reasoningId, rb);
      scrollToBottom();
    }
    rb.contentEl.textContent += delta;
    // Auto-scroll reasoning body if expanded
    const body = rb.block.querySelector(".reasoning-body");
    if (body) body.scrollTop = body.scrollHeight;
  }

  function finalizeReasoning(reasoningId, content) {
    let rb = reasoningBlocks.get(reasoningId);
    if (!rb) {
      // Received complete event without deltas (non-streaming path) — create it
      appendReasoningDelta(reasoningId, "");
      rb = reasoningBlocks.get(reasoningId);
    }
    if (rb) {
      rb.contentEl.textContent = content || rb.contentEl.textContent;
      rb.streaming = false;
      const statusEl = rb.block.querySelector(".reasoning-status");
      if (statusEl) statusEl.textContent = "done";
      // Collapse after done so it's out of the way
      rb.block.classList.remove("expanded");
    }
  }

  // ── Context window bar ──

  function updateContextBar(currentTokens, tokenLimit) {
    if (!tokenLimit) return;
    const pct = Math.min(currentTokens / tokenLimit, 1);
    const pctDisplay = Math.round(pct * 100);
    contextBar.style.display = "";
    contextBarFill.style.width = `${pct * 100}%`;
    // Color: green → yellow → red
    const color = pct < 0.6 ? "var(--success)" : pct < 0.85 ? "#e0a020" : "var(--danger)";
    contextBarFill.style.background = color;
    contextBarLabel.textContent = `${pctDisplay}% · ${formatTokens(currentTokens)} / ${formatTokens(tokenLimit)}`;
  }

  function formatTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  }

  // ── Tool call rendering ──

  // Tools that render as a simple inline text line (no expandable box)
  const INLINE_TOOLS = new Set([
    "read_file", "view",
    "edit", "edit_file", "replace_string_in_file", "multi_replace_string_in_file",
    "create", "create_file", "delete_file",
    "ask_user", "glob", "sql", "session_store_sql",
  ]);

  // Lookup for tool display info: { icon, label(args), resultLabel }
  const TOOL_DISPLAY = {
    read_file:      { icon: "📄", label: a => `Read ${shortPath(a.filePath || a.path || a.file || "")}` },
    view:           { icon: "📄", label: a => `Read ${shortPath(a.path || a.filePath || a.file || "")}` },
    edit:           { icon: "✏️", label: a => `Edited ${shortPath(a.filePath || a.path || a.file || a.old_str && "(file)" || "")}` },
    edit_file:      { icon: "✏️", label: a => `Edited ${shortPath(a.filePath || a.path || a.file || "")}` },
    create:         { icon: "📝", label: a => `Created ${shortPath(a.path || a.filePath || a.file || "")}` },
    create_file:    { icon: "📝", label: a => `Created ${shortPath(a.filePath || a.path || a.file || "")}` },
    replace_string_in_file: { icon: "✏️", label: a => `Edited ${shortPath(a.filePath || "")}` },
    multi_replace_string_in_file: { icon: "✏️", label: a => `Edited files` },
    delete_file:    { icon: "🗑️", label: a => `Deleted ${shortPath(a.filePath || a.path || "")}` },
    list_dir:       { icon: "📁", label: a => `List ${shortPath(a.path || a.directory || "")}` },
    list_directory: { icon: "📁", label: a => `List ${shortPath(a.path || a.directory || "")}` },
    grep_search:    { icon: "🔍", label: a => `Search: ${truncate(a.query || a.pattern || "", 60)}` },
    grep:           { icon: "🔍", label: a => `Search: ${truncate(a.pattern || a.query || "", 60)}` },
    file_search:    { icon: "🔍", label: a => `Find files: ${truncate(a.query || a.pattern || "", 60)}` },
    semantic_search:{ icon: "🔍", label: a => `Search: ${truncate(a.query || "", 60)}` },
    run_in_terminal:{ icon: "⚡", label: a => truncate(a.command || a.cmd || "Run command", 80) },
    powershell:     { icon: "⚡", label: a => truncate(a.command || a.cmd || "Run command", 80) },
    shell:          { icon: "⚡", label: a => truncate(a.command || a.cmd || "Run command", 80) },
    report_intent:  { icon: "💡", label: a => `${truncate(a.intention || a.intent || "Thinking...", 80)}` },
    fetch_copilot_cli_documentation: { icon: "📚", label: () => "Reading docs" },
    get_errors:     { icon: "⚠️", label: a => `Check errors${a.filePaths ? ": " + shortPath(a.filePaths[0] || "") : ""}` },
    test_failure:   { icon: "🧪", label: () => "Analyzing test failure" },
    manage_todo_list: { icon: "📋", label: () => "Update TODO list" },
    runSubagent:    { icon: "🤖", label: a => `Delegate: ${truncate(a.description || "", 60)}` },
    create_and_run_task: { icon: "🤖", label: a => `Run task: ${truncate(a.description || a.title || "", 60)}` },
    ask_user:       { icon: "❓", label: a => truncate(a.question || "Question", 80) },
    sql:            { icon: "🗄️", label: a => truncate(a.description || a.query || "SQL query", 80) },
    web_fetch:      { icon: "🌐", label: a => `Fetch ${truncate(a.url || "", 60)}` },
    glob:           { icon: "📂", label: a => `Find files: ${truncate(a.pattern || "", 60)}` },
    task:           { icon: "🤖", label: a => `${truncate(a.description || a.name || "Sub-agent", 60)}` },
    session_store_sql: { icon: "🗄️", label: a => truncate(a.description || "Session store query", 80) },
  };

  function shortPath(p) {
    if (!p) return "";
    // Show last 2 path segments
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : parts.join("/");
  }

  function truncate(s, n) {
    return s.length > n ? s.substring(0, n) + "…" : s;
  }

  function flushStreamingBubble() {
    if (streamingBubble && streamingBuffer.trim()) {
      streamingBubble.classList.remove("streaming-cursor");
      streamingBubble.innerHTML = renderMarkdown(streamingBuffer);
      addCopyButtons(streamingBubble);
      streamingBubble = null;
      streamingBuffer = "";
    }
  }

  function appendToolStart(name, args, callId, intention) {
    flushStreamingBubble();

    const normalizedName = (name || "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const display = TOOL_DISPLAY[normalizedName] || TOOL_DISPLAY[name] || null;
    const parsedArgs = typeof args === "string" ? tryParseJSON(args) : (args || {});

    const icon = display?.icon || "⚡";
    const label = display?.label?.(parsedArgs) || name;

    // report_intent: show as a plain italic status line, no box
    if (normalizedName === "report_intent") {
      const intentText = parsedArgs.intention || parsedArgs.intent || intention || "Thinking...";
      const el = document.createElement("div");
      el.className = "intent-line";
      el.id = `tool-${callId}`;
      el.textContent = intentText;
      messagesEl.appendChild(el);
      scrollToBottom();
      return;
    }

    // File read/edit tools: render as a simple inline text line, no expandable box
    if (INLINE_TOOLS.has(normalizedName)) {
      const el = document.createElement("div");
      el.className = "tool-inline";
      el.id = `tool-${callId}`;
      el.dataset.toolName = normalizedName;
      el.innerHTML = `<span class="tool-inline-icon">${icon}</span><span>${escapeHtml(label)}</span>`;
      messagesEl.appendChild(el);
      scrollToBottom();
      return;
    }

    // Build compact summary line for command-like tools
    let summaryHtml = "";
    if (intention) {
      summaryHtml = `<div class="tool-intention">${escapeHtml(intention)}</div>`;
    }

    const block = document.createElement("div");
    block.className = "tool-block";
    block.id = `tool-${callId}`;
    block.dataset.toolName = normalizedName;
    block.dataset.callId = callId || "";

    block.innerHTML = `
      <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${escapeHtml(label)}</span>
        <span class="tool-status"><span class="spinner"></span> Running</span>
        <span class="tool-chevron">▶</span>
      </div>
      ${summaryHtml}
      <div class="tool-body">
        <div class="tool-output-stream" style="display:none"></div>
        <div class="tool-detail-section">
          <div class="tool-section-label">Details</div>
          <pre><code class="tool-args-code">${escapeHtml(formatToolArgs(normalizedName, parsedArgs))}</code></pre>
        </div>
        <div class="tool-result-section" style="display:none">
          <div class="tool-section-label">Result</div>
          <pre><code class="tool-result-code"></code></pre>
        </div>
      </div>
    `;
    messagesEl.appendChild(block);
    scrollToBottom();
  }

  function formatToolArgs(toolName, args) {
    // For certain tools, show a more readable summary instead of raw JSON
    if (!args || Object.keys(args).length === 0) return "(no arguments)";
    switch (toolName) {
      case "read_file":
        return `File: ${args.filePath || args.path || "?"}\nLines: ${args.startLine || "start"}-${args.endLine || "end"}`;
      case "edit_file":
      case "replace_string_in_file":
        return `File: ${args.filePath || args.path || "?"}\n${args.oldString ? "Replace: " + truncate(args.oldString, 100) + "\nWith: " + truncate(args.newString || "", 100) : ""}`;
      case "create_file":
        return `File: ${args.filePath || args.path || "?"}\nContent: ${truncate(args.content || "", 200)}`;
      case "grep":
      case "grep_search":
        return `Pattern: ${args.pattern || args.query || "?"}\nPath: ${args.path || args.includePattern || "all files"}`;
      case "run_in_terminal":
      case "powershell":
      case "shell":
        return `$ ${args.command || args.cmd || "?"}`;
      case "manage_todo_list":
        return JSON.stringify(args.todoList || args, null, 2);
      default:
        return JSON.stringify(args, null, 2);
    }
  }

  function updateToolResult(callId, result, name) {
    // Try matching by callId first, then by parentId pattern
    let block = document.getElementById(`tool-${callId}`);
    if (!block) {
      // tool.execution_complete sometimes has a different ID than tool.execution_start
      // Try to find the last unfinished tool block
      const blocks = messagesEl.querySelectorAll(".tool-block:not(.tool-done)");
      if (blocks.length > 0) block = blocks[blocks.length - 1];
    }
    if (!block) return;

    block.classList.add("tool-done");
    const status = block.querySelector(".tool-status");
    const toolName = block.dataset.toolName || "";
    const isSuccess = !result?.startsWith?.("Error") && !result?.startsWith?.("FAILED");

    if (status) {
      status.innerHTML = isSuccess
        ? `<span class="status-done">✓ Done</span>`
        : `<span class="status-error">✗ Failed</span>`;
    }

    const resultSection = block.querySelector(".tool-result-section");
    const resultCode = block.querySelector(".tool-result-code");
    if (resultSection && resultCode && result) {
      resultSection.style.display = "block";
      const display = result.length > 8000 ? result.substring(0, 8000) + "\n\n… (truncated)" : result;
      resultCode.textContent = display;
    }
  }

  function appendToolPartial(callId, output) {
    let block = document.getElementById(`tool-${callId}`);
    if (!block) {
      // Try to find the last running tool block (for mismatched IDs)
      const blocks = messagesEl.querySelectorAll(".tool-block:not(.tool-done)");
      if (blocks.length > 0) block = blocks[blocks.length - 1];
    }
    if (!block) return;

    const streamEl = block.querySelector(".tool-output-stream");
    if (streamEl) {
      streamEl.style.display = "block";
      // Append output incrementally
      const line = document.createElement("span");
      line.textContent = output;
      streamEl.appendChild(line);
      // Keep auto-scroll if near bottom
      if (streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 100) {
        streamEl.scrollTop = streamEl.scrollHeight;
      }
    }
    scrollToBottom();
  }

  function enrichToolWithPermission(msg) {
    // Permission events carry richer data (command text, file names, diffs)
    // Try to find the tool block to enrich
    const toolCallId = msg.toolCallId;
    let block = toolCallId ? document.getElementById(`tool-${toolCallId}`) : null;
    if (!block) {
      // Find last running tool block or inline element
      const blocks = messagesEl.querySelectorAll(".tool-block:not(.tool-done), .tool-inline");
      if (blocks.length > 0) block = blocks[blocks.length - 1];
    }
    if (!block) return;

    const toolName = block.dataset.toolName || "";

    // Update command display for shell tools
    if (msg.commandText && (msg.kind === "shell" || toolName.includes("terminal") || toolName.includes("shell") || toolName.includes("powershell"))) {
      let cmdEl = block.querySelector(".tool-command code");
      if (cmdEl) {
        cmdEl.textContent = msg.commandText;
      } else {
        const header = block.querySelector(".tool-header");
        if (header) {
          const cmdDiv = document.createElement("div");
          cmdDiv.className = "tool-command";
          cmdDiv.innerHTML = `<code>${escapeHtml(msg.commandText)}</code>`;
          header.insertAdjacentElement("afterend", cmdDiv);
        }
      }
    }

    // Update file name for write/edit tools
    if (msg.fileName && (msg.kind === "write" || msg.kind === "edit")) {
      // Inline tool (no box)
      const inlineSpan = block.querySelector("span:last-child");
      if (block.classList.contains("tool-inline") && inlineSpan) {
        inlineSpan.textContent = `Edited ${shortPath(msg.fileName)}`;
      } else {
        const nameEl = block.querySelector(".tool-name");
        if (nameEl) nameEl.textContent = `Edited ${shortPath(msg.fileName)}`;
      }
    }

    // Diff stats (+N -N) for inline edit elements
    if (msg.diff && block.classList.contains("tool-inline")) {
      const lines = msg.diff.split("\n");
      const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
      const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
      if ((added || removed) && !block.querySelector(".diff-stats")) {
        const stats = document.createElement("span");
        stats.className = "diff-stats";
        stats.innerHTML = (added ? `<span class="diff-add">+${added}</span>` : "") +
                          (removed ? `<span class="diff-del">-${removed}</span>` : "");
        block.appendChild(stats);
      }
    }

    // Show diff if available
    if (msg.diff) {
      let diffSection = block.querySelector(".tool-diff-section");
      if (!diffSection) {
        const body = block.querySelector(".tool-body");
        if (body) {
          diffSection = document.createElement("div");
          diffSection.className = "tool-diff-section";
          diffSection.innerHTML = `<div class="tool-section-label">Changes</div><pre><code class="tool-diff-code"></code></pre>`;
          body.insertBefore(diffSection, body.firstChild);
        }
      }
      if (diffSection) {
        const diffCode = diffSection.querySelector(".tool-diff-code");
        if (diffCode) diffCode.textContent = msg.diff;
      }
    }
  }

  function appendSessionInfo(infoType, message) {
    if (!message) return;
    const div = document.createElement("div");
    div.className = "message message-info";
    const icon = infoType === "file_created" ? "📄" : "ℹ️";
    div.innerHTML = `<div class="info-pill">${icon} ${escapeHtml(message)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function tryParseJSON(s) {
    try { return JSON.parse(s); } catch { return {}; }
  }

  // ── Markdown → HTML ──

  function renderMarkdown(text) {
    try {
      return marked.parse(text);
    } catch(e) {
      console.error("[markdown] render error:", e);
      return escapeHtml(text);
    }
  }

  function escapeHtml(text) {
    const el = document.createElement("span");
    el.textContent = text;
    return el.innerHTML;
  }

  function addCopyButtons(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.onclick = () => {
        const code = pre.querySelector("code");
        navigator.clipboard.writeText(code?.textContent || pre.textContent).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy"), 1500);
        });
      };
      pre.style.position = "relative";
      pre.appendChild(btn);
    });
  }

  // ── Scrolling ──

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── Input handling ──

  function updateSendState() {
    const hasContent = messageInput.value.trim().length > 0;
    sendBtn.disabled = !hasContent || isStreaming || !currentSessionId;
    sendBtn.style.display = isStreaming ? "none" : "";
    stopBtn.style.display = isStreaming ? "" : "none";
  }

  function handleSend() {
    const content = messageInput.value.trim();
    if (!content || isStreaming || !currentSessionId) {
      console.log("[ui] send blocked:", { hasContent: !!content, isStreaming, currentSessionId });
      return;
    }

    const isLoop = sendMode === "loop";
    console.log("[ui] sending:", content.substring(0, 80), isLoop ? "[LOOP]" : "");
    appendUserMessage(content);
    wsSend({ type: "message", sessionId: currentSessionId, content, loopMode: isLoop });
    messageInput.value = "";
    sendMode = "normal"; // reset per-message
    sendBtn.classList.remove("loop-mode");
    sendBtn.title = "Send";
    autoResizeTextarea();
    updateSendState();
  }

  function autoResizeTextarea() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
  }

  // ── Sidebar ──

  function openSidebar() {
    sidebar.classList.add("open");
    sidebarOverlay.classList.add("open");
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.remove("open");
  }

  // ── Event listeners ──

  menuBtn.addEventListener("click", () => {
    sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
  });

  sidebarOverlay.addEventListener("click", closeSidebar);

  newSessionBtn.addEventListener("click", () => {
    newSessionDialog.style.display = "";
    newCwdInput.focus();
  });

  newSessionCancel.addEventListener("click", () => {
    newSessionDialog.style.display = "none";
  });

  newSessionCreate.addEventListener("click", () => {
    const cwd = newCwdInput.value.trim() || undefined;
    const model = newModelSelect.value;
    wsSend({ type: "new_session", cwd, model });
    newSessionDialog.style.display = "none";
  });

  // Close dialog on overlay click
  newSessionDialog.addEventListener("click", (e) => {
    if (e.target === newSessionDialog) newSessionDialog.style.display = "none";
  });

  // Header model change
  headerModelSelect.addEventListener("change", () => {
    if (!currentSessionId) return;
    wsSend({ type: "set_model", sessionId: currentSessionId, model: headerModelSelect.value });
  });

  sendBtn.addEventListener("click", handleSend);

  // Send mode menu — hover (desktop) and long-press (mobile)
  let longPressTimer = null;

  function showSendMenu() {
    if (sendBtn.disabled) return;
    sendModeMenu.style.display = "block";
  }

  function hideSendMenu() {
    sendModeMenu.style.display = "none";
  }

  // Desktop: show on right-click or hover with delay
  sendBtnWrapper.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSendMenu();
  });

  sendBtnWrapper.addEventListener("mouseenter", () => {
    if (menuHideTimer) { clearTimeout(menuHideTimer); menuHideTimer = null; }
  });

  sendBtnWrapper.addEventListener("mouseleave", () => {
    menuHideTimer = setTimeout(hideSendMenu, 300);
  });

  sendModeMenu.addEventListener("mouseenter", () => {
    if (menuHideTimer) { clearTimeout(menuHideTimer); menuHideTimer = null; }
  });

  sendModeMenu.addEventListener("mouseleave", () => {
    menuHideTimer = setTimeout(hideSendMenu, 300);
  });

  // Mobile: long press on send button
  sendBtn.addEventListener("touchstart", (e) => {
    longPressTimer = setTimeout(() => {
      e.preventDefault();
      showSendMenu();
    }, 500);
  }, { passive: false });

  sendBtn.addEventListener("touchend", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  sendBtn.addEventListener("touchmove", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  // Menu option clicks
  sendModeMenu.addEventListener("click", (e) => {
    const option = e.target.closest(".send-mode-option");
    if (!option) return;
    const mode = option.dataset.mode;
    if (mode === "loop") {
      sendMode = "loop";
      sendBtn.classList.add("loop-mode");
      sendBtn.title = "Send (Loop mode)";
    } else {
      sendMode = "normal";
      sendBtn.classList.remove("loop-mode");
      sendBtn.title = "Send";
    }
    hideSendMenu();
  });

  // Close menu on click outside
  document.addEventListener("click", (e) => {
    if (!sendBtnWrapper.contains(e.target) && !sendModeMenu.contains(e.target)) {
      hideSendMenu();
    }
  });

  // Loop stop button
  loopStopBtn.addEventListener("click", () => {
    if (currentSessionId) {
      wsSend({ type: "abort", sessionId: currentSessionId });
    }
  });

  stopBtn.addEventListener("click", () => {
    if (currentSessionId) {
      wsSend({ type: "abort", sessionId: currentSessionId });
    }
  });

  messageInput.addEventListener("input", () => {
    autoResizeTextarea();
    updateSendState();
  });

  messageInput.addEventListener("keydown", (e) => {
    const isMobile = window.innerWidth <= 768;
    if (e.key === "Enter" && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  });

  // ── User input / Elicitation requests ──

  function renderUserInputRequest(msg) {
    flushStreamingBubble();

    const card = document.createElement("div");
    card.className = "prompt-card";
    card.id = `prompt-${msg.requestId}`;

    const question = document.createElement("div");
    question.className = "prompt-question";
    question.innerHTML = renderMarkdown(msg.question);
    card.appendChild(question);

    const choices = msg.choices || [];
    if (choices.length > 0) {
      const choicesDiv = document.createElement("div");
      choicesDiv.className = "prompt-choices";
      for (const choice of choices) {
        const btn = document.createElement("button");
        btn.className = "prompt-choice-btn";
        btn.textContent = choice;
        btn.onclick = () => {
          wsSend({
            type: "user_input_response",
            requestId: msg.requestId,
            answer: choice,
            wasFreeform: false,
          });
          card.classList.add("prompt-answered");
          card.innerHTML = `<div class="prompt-answered-text">✓ ${escapeHtml(choice)}</div>`;
        };
        choicesDiv.appendChild(btn);
      }
      card.appendChild(choicesDiv);
    }

    if (msg.allowFreeform !== false) {
      const inputRow = document.createElement("div");
      inputRow.className = "prompt-input-row";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "prompt-input";
      input.placeholder = "Type your answer...";
      const submitBtn = document.createElement("button");
      submitBtn.className = "prompt-submit-btn";
      submitBtn.textContent = "Send";
      const submit = () => {
        const val = input.value.trim();
        if (!val) return;
        wsSend({
          type: "user_input_response",
          requestId: msg.requestId,
          answer: val,
          wasFreeform: true,
        });
        card.classList.add("prompt-answered");
        card.innerHTML = `<div class="prompt-answered-text">✓ ${escapeHtml(val)}</div>`;
      };
      submitBtn.onclick = submit;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      inputRow.appendChild(input);
      inputRow.appendChild(submitBtn);
      card.appendChild(inputRow);
      setTimeout(() => input.focus(), 50);
    }

    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function renderElicitationRequest(msg) {
    flushStreamingBubble();

    const card = document.createElement("div");
    card.className = "prompt-card";
    card.id = `prompt-${msg.requestId}`;

    if (msg.message) {
      const question = document.createElement("div");
      question.className = "prompt-question";
      question.innerHTML = renderMarkdown(msg.message);
      card.appendChild(question);
    }

    const schema = msg.schema;
    const fields = schema?.properties || {};
    const fieldEntries = Object.entries(fields);
    const formValues = {};

    for (const [key, field] of fieldEntries) {
      const fieldDiv = document.createElement("div");
      fieldDiv.className = "prompt-field";

      if (field.title || field.description) {
        const label = document.createElement("label");
        label.className = "prompt-label";
        label.textContent = field.title || field.description || key;
        fieldDiv.appendChild(label);
      }

      // Enum or oneOf = dropdown/buttons
      const options = field.enum || (field.oneOf || []).map(o => o.const);
      const optionLabels = field.enumNames || (field.oneOf || []).map(o => o.title);

      if (options && options.length > 0 && options.length <= 5) {
        // Render as buttons for small choice sets
        const choicesDiv = document.createElement("div");
        choicesDiv.className = "prompt-choices";
        for (let i = 0; i < options.length; i++) {
          const btn = document.createElement("button");
          btn.className = "prompt-choice-btn";
          btn.textContent = optionLabels?.[i] || options[i];
          btn.onclick = () => {
            choicesDiv.querySelectorAll(".prompt-choice-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            formValues[key] = options[i];
          };
          if (field.default === options[i]) {
            btn.classList.add("selected");
            formValues[key] = options[i];
          }
          choicesDiv.appendChild(btn);
        }
        fieldDiv.appendChild(choicesDiv);
      } else if (options && options.length > 5) {
        // Render as select dropdown
        const select = document.createElement("select");
        select.className = "prompt-select";
        for (let i = 0; i < options.length; i++) {
          const opt = document.createElement("option");
          opt.value = options[i];
          opt.textContent = optionLabels?.[i] || options[i];
          if (field.default === options[i]) opt.selected = true;
          select.appendChild(opt);
        }
        formValues[key] = field.default || options[0];
        select.onchange = () => { formValues[key] = select.value; };
        fieldDiv.appendChild(select);
      } else {
        // Text input
        const input = document.createElement("input");
        input.type = "text";
        input.className = "prompt-input";
        input.value = field.default || "";
        formValues[key] = field.default || "";
        input.oninput = () => { formValues[key] = input.value; };
        fieldDiv.appendChild(input);
      }

      card.appendChild(fieldDiv);
    }

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "prompt-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "prompt-submit-btn";
    acceptBtn.textContent = "Submit";
    acceptBtn.onclick = () => {
      wsSend({
        type: "elicitation_response",
        requestId: msg.requestId,
        action: "accept",
        content: formValues,
      });
      card.classList.add("prompt-answered");
      card.innerHTML = `<div class="prompt-answered-text">✓ Submitted</div>`;
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "prompt-choice-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => {
      wsSend({
        type: "elicitation_response",
        requestId: msg.requestId,
        action: "cancel",
        content: {},
      });
      card.classList.add("prompt-answered");
      card.innerHTML = `<div class="prompt-answered-text">✗ Cancelled</div>`;
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(acceptBtn);
    card.appendChild(actions);

    messagesEl.appendChild(card);
    scrollToBottom();
  }

  // ── Diff panel ──

  function openDiffPanel() {
    diffPanel.style.display = "flex";
    diffOverlay.style.display = "block";
    diffContentEl.innerHTML = '<div class="diff-loading">Loading diff…</div>';
    diffStatEl.textContent = "";
    wsSend({ type: "get_diff", sessionId: currentSessionId });
  }

  function closeDiffPanel() {
    diffPanel.style.display = "none";
    diffOverlay.style.display = "none";
  }

  diffBtn.addEventListener("click", openDiffPanel);
  diffCloseBtn.addEventListener("click", closeDiffPanel);
  diffOverlay.addEventListener("click", closeDiffPanel);
  diffRefreshBtn.addEventListener("click", () => {
    diffContentEl.innerHTML = '<div class="diff-loading">Loading diff…</div>';
    diffStatEl.textContent = "";
    wsSend({ type: "get_diff", sessionId: currentSessionId });
  });

  // ── Processes panel ──

  function openProcessesPanel() {
    processesPanel.style.display = "flex";
    processesOverlay.style.display = "block";
    wsSend({ type: "list_processes" });
  }

  function closeProcessesPanel() {
    processesPanel.style.display = "none";
    processesOverlay.style.display = "none";
  }

  processesBtn.addEventListener("click", openProcessesPanel);
  processesCloseBtn.addEventListener("click", closeProcessesPanel);
  processesOverlay.addEventListener("click", closeProcessesPanel);

  function updateProcessBadge() {
    const running = [...trackedProcesses.values()].filter(p => p.status === "running").length;
    if (running > 0) {
      processesBadge.textContent = running;
      processesBadge.style.display = "flex";
    } else {
      processesBadge.style.display = "none";
    }
  }

  function formatProcessTime(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatDuration(startIso, endIso) {
    if (!startIso) return "";
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    const secs = Math.round((end - start) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}m ${remSecs}s`;
  }

  function renderProcessList() {
    if (trackedProcesses.size === 0) {
      processesListEl.innerHTML = '<div class="processes-empty">No processes yet</div>';
      return;
    }

    const sorted = [...trackedProcesses.values()].sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));

    // Preserve expanded state
    const expandedIds = new Set();
    processesListEl.querySelectorAll(".process-item.expanded").forEach(el => {
      expandedIds.add(el.dataset.processId);
    });

    processesListEl.innerHTML = "";
    for (const proc of sorted) {
      const item = document.createElement("div");
      item.className = "process-item" + (expandedIds.has(proc.id) ? " expanded" : "");
      item.dataset.processId = proc.id;

      const header = document.createElement("div");
      header.className = "process-item-header";

      const statusDot = document.createElement("span");
      statusDot.className = `process-status-dot ${proc.status}`;

      const info = document.createElement("div");
      info.className = "process-info";

      const cmdLine = document.createElement("div");
      cmdLine.className = "process-command";
      const cmdText = proc.command || "unknown command";
      cmdLine.textContent = cmdText.length > 120 ? cmdText.slice(0, 117) + "…" : cmdText;
      cmdLine.title = cmdText;

      const meta = document.createElement("div");
      meta.className = "process-meta";
      const statusLabel = proc.status === "running" ? "Running" : proc.status === "done" ? "Completed" : proc.status === "detached" ? "Detached" : "Failed";
      const duration = formatDuration(proc.startedAt, proc.completedAt);
      meta.innerHTML = `<span>${statusLabel}</span><span>${formatProcessTime(proc.startedAt)}</span>${duration ? `<span>${duration}</span>` : ""}`;

      if (proc.intention) {
        const intentionSpan = document.createElement("span");
        intentionSpan.textContent = proc.intention;
        intentionSpan.style.fontStyle = "italic";
        meta.appendChild(intentionSpan);
      }

      info.appendChild(cmdLine);
      info.appendChild(meta);

      const chevron = document.createElement("span");
      chevron.className = "process-chevron";
      chevron.textContent = "▶";

      header.appendChild(statusDot);
      header.appendChild(info);
      header.appendChild(chevron);

      const output = document.createElement("div");
      output.className = "process-output";
      const pre = document.createElement("pre");
      const outputText = (proc.output || []).join("");
      pre.textContent = outputText || (proc.result || "(no output)");
      output.appendChild(pre);

      header.addEventListener("click", () => {
        item.classList.toggle("expanded");
        // Auto-scroll output to bottom when expanding
        if (item.classList.contains("expanded")) {
          requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; });
        }
      });

      item.appendChild(header);
      item.appendChild(output);
      processesListEl.appendChild(item);
    }
  }

  function renderDiffResult(msg) {
    if (msg.error) {
      diffContentEl.innerHTML = `<div class="diff-empty">Error: ${escapeHtml(msg.error)}</div>`;
      return;
    }
    if (!msg.diff || !msg.diff.trim()) {
      diffContentEl.innerHTML = '<div class="diff-empty">No local changes</div>';
      diffStatEl.textContent = "";
      return;
    }

    diffStatEl.textContent = msg.stat || "";

    // Parse unified diff into file sections
    const files = parseDiff(msg.diff);
    diffContentEl.innerHTML = "";

    for (const file of files) {
      const section = document.createElement("div");
      section.className = "diff-file";

      // Count additions/deletions
      let added = 0, removed = 0;
      for (const line of file.lines) {
        if (line.type === "added") added++;
        else if (line.type === "removed") removed++;
      }

      const header = document.createElement("div");
      header.className = "diff-file-header";
      header.innerHTML = `
        <span class="diff-file-chevron">▶</span>
        <span class="diff-file-name">${escapeHtml(file.name)}</span>
        <span class="diff-file-stats">
          ${added ? `<span class="diff-add">+${added}</span>` : ""}
          ${removed ? `<span class="diff-del">-${removed}</span>` : ""}
        </span>
      `;
      header.onclick = () => section.classList.toggle("expanded");
      section.appendChild(header);

      const body = document.createElement("div");
      body.className = "diff-file-body";

      for (const line of file.lines) {
        if (line.type === "hunk") {
          const hunk = document.createElement("div");
          hunk.className = "diff-hunk-header";
          hunk.textContent = line.content;
          body.appendChild(hunk);
        } else {
          const row = document.createElement("div");
          row.className = `diff-line ${line.type}`;

          const numOld = document.createElement("span");
          numOld.className = "diff-line-number";
          numOld.textContent = line.oldNum ?? "";

          const numNew = document.createElement("span");
          numNew.className = "diff-line-number";
          numNew.textContent = line.newNum ?? "";

          const content = document.createElement("span");
          content.className = "diff-line-content";
          content.textContent = line.content;

          row.appendChild(numOld);
          row.appendChild(numNew);
          row.appendChild(content);
          body.appendChild(row);
        }
      }

      section.appendChild(body);
      diffContentEl.appendChild(section);
    }
  }

  function parseDiff(raw) {
    const files = [];
    let current = null;
    let oldLine = 0, newLine = 0;

    for (const line of raw.split("\n")) {
      if (line.startsWith("diff --git")) {
        // Extract filename from "diff --git a/path b/path"
        const match = line.match(/b\/(.+)$/);
        current = { name: match ? match[1] : line, lines: [] };
        files.push(current);
        continue;
      }
      if (!current) continue;

      if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
        continue; // skip meta lines
      }

      if (line.startsWith("@@")) {
        // Parse hunk header: @@ -oldStart,count +newStart,count @@
        const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          oldLine = parseInt(hunkMatch[1]);
          newLine = parseInt(hunkMatch[2]);
        }
        current.lines.push({ type: "hunk", content: line });
        continue;
      }

      if (line.startsWith("+")) {
        current.lines.push({ type: "added", content: line.substring(1), newNum: newLine++ });
      } else if (line.startsWith("-")) {
        current.lines.push({ type: "removed", content: line.substring(1), oldNum: oldLine++ });
      } else if (line.startsWith(" ")) {
        current.lines.push({ type: "context", content: line.substring(1), oldNum: oldLine++, newNum: newLine++ });
      }
    }

    return files;
  }

  // ── Init ──

  connect();
  updateSendState();
  fetchModels();

  // Fetch available models from the server and populate dropdowns
  async function fetchModels() {
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      if (data.models && data.models.length > 0) {
        // Populate both the new-session dialog and the header model selector
        for (const selectEl of [newModelSelect, headerModelSelect]) {
          selectEl.innerHTML = "";
          for (const m of data.models) {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            if (m.id === data.default) opt.selected = true;
            selectEl.appendChild(opt);
          }
        }
      } else {
        newModelSelect.innerHTML = '<option value="">No models available</option>';
      }
    } catch (e) {
      console.warn("Could not fetch models:", e);
      newModelSelect.innerHTML = '<option value="">Failed to load models</option>';
    }
  }
})();
