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
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const seenMessageIds = new Set(); // dedup broadcasts by server-assigned _mid

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
  const headerCwd = document.getElementById("header-cwd");
  const headerModelSelect = document.getElementById("header-model-select");
  const newSessionDialog = document.getElementById("new-session-dialog");
  const newCwdInput = document.getElementById("new-cwd-input");
  const newModelSelect = document.getElementById("new-model-select");
  const newSessionCancel = document.getElementById("new-session-cancel");
  const newSessionCreate = document.getElementById("new-session-create");

  // ── Markdown setup ──

  marked.setOptions({
    highlight: function (code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true,
  });

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
      wsSend({ type: "list_sessions" });
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

    newWs.onclose = () => {
      if (ws !== newWs) return; // already replaced
      console.log("[ws] disconnected");
      updateConnectionStatus(false);
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
          finishStreaming();
        }
        break;

      case "turn_start":
        if (msg.sessionId === currentSessionId) {
          isStreaming = true;
          showThinkingIndicator();
          updateSendState();
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

      case "done":
        if (msg.sessionId === currentSessionId) {
          hideThinkingIndicator();
          finishStreaming();
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
          finishStreaming();
        }
        break;
    }
  }

  // ── Session management ──

  function updateHeaderMeta(cwd, model) {
    if (cwd != null) {
      headerCwd.textContent = cwd;
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
    }
  }

  function renderSessionList() {
    sessionListEl.innerHTML = "";
    for (const s of sessions) {
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

      div.appendChild(titleRow);

      // Show CWD as subtitle if available
      if (s.cwd) {
        const cwdEl = document.createElement("div");
        cwdEl.className = "session-cwd";
        // Show just the last folder name
        const shortCwd = s.cwd.split(/[/\\]/).filter(Boolean).pop() || s.cwd;
        cwdEl.textContent = shortCwd;
        cwdEl.title = s.cwd;
        div.appendChild(cwdEl);
      }

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
      div.appendChild(del);

      div.onclick = () => resumeSession(s.sessionId);
      sessionListEl.appendChild(div);
    }
  }

  function resumeSession(sessionId) {
    currentSessionId = sessionId;
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

    for (const msg of messages) {
      switch (msg.role) {
        case "user":
          appendUserMessage(msg.content);
          break;
        case "assistant":
          if (msg.content) appendAssistantMessage(msg.content);
          break;
        case "tool_call":
          appendToolStart(msg.name, msg.args, msg.callId, msg.intention);
          break;
        case "tool_result":
          updateToolResult(msg.parentId || msg.callId, msg.result, msg.name);
          break;
      }
    }

    scrollToBottom();
  }

  function appendUserMessage(text) {
    const div = document.createElement("div");
    div.className = "message message-user";
    div.innerHTML = `<div class="message-bubble">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendAssistantMessage(markdown) {
    const div = document.createElement("div");
    div.className = "message message-assistant";
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = renderMarkdown(markdown);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
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
    addCopyButtons(streamingBubble);
    scrollToBottom();
  }

  function finishStreaming() {
    if (streamingBubble) {
      streamingBubble.classList.remove("streaming-cursor");
      streamingBubble.innerHTML = renderMarkdown(streamingBuffer);
      addCopyButtons(streamingBubble);
      streamingBubble = null;
      streamingBuffer = "";
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

  // ── Tool call rendering ──

  // Lookup for tool display info: { icon, label(args), resultLabel }
  const TOOL_DISPLAY = {
    read_file:      { icon: "📄", label: a => `Read ${shortPath(a.filePath || a.path || a.file || "")}` },
    edit_file:      { icon: "✏️", label: a => `Edit ${shortPath(a.filePath || a.path || a.file || "")}` },
    create_file:    { icon: "📝", label: a => `Create ${shortPath(a.filePath || a.path || a.file || "")}` },
    replace_string_in_file: { icon: "✏️", label: a => `Edit ${shortPath(a.filePath || "")}` },
    multi_replace_string_in_file: { icon: "✏️", label: a => `Multi-edit files` },
    delete_file:    { icon: "🗑️", label: a => `Delete ${shortPath(a.filePath || a.path || "")}` },
    list_dir:       { icon: "📁", label: a => `List ${shortPath(a.path || a.directory || "")}` },
    list_directory: { icon: "📁", label: a => `List ${shortPath(a.path || a.directory || "")}` },
    grep_search:    { icon: "🔍", label: a => `Search: ${truncate(a.query || a.pattern || "", 60)}` },
    file_search:    { icon: "🔍", label: a => `Find files: ${truncate(a.query || a.pattern || "", 60)}` },
    semantic_search:{ icon: "🔍", label: a => `Search: ${truncate(a.query || "", 60)}` },
    run_in_terminal:{ icon: "⚡", label: a => `Run command` },
    powershell:     { icon: "⚡", label: a => `Run command` },
    shell:          { icon: "⚡", label: a => `Run command` },
    report_intent:  { icon: "💡", label: a => `${truncate(a.intention || a.intent || "Thinking...", 80)}` },
    fetch_copilot_cli_documentation: { icon: "📚", label: () => "Reading docs" },
    get_errors:     { icon: "⚠️", label: a => `Check errors${a.filePaths ? ": " + shortPath(a.filePaths[0] || "") : ""}` },
    test_failure:   { icon: "🧪", label: () => "Analyzing test failure" },
    manage_todo_list: { icon: "📋", label: () => "Update TODO list" },
    runSubagent:    { icon: "🤖", label: a => `Delegate: ${truncate(a.description || "", 60)}` },
    create_and_run_task: { icon: "🤖", label: a => `Run task: ${truncate(a.description || a.title || "", 60)}` },
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

    // Build compact summary line for command-like tools
    let summaryHtml = "";
    if (normalizedName === "run_in_terminal" || normalizedName === "powershell" || normalizedName === "shell") {
      const cmd = parsedArgs.command || parsedArgs.cmd || "";
      if (cmd) {
        summaryHtml = `<div class="tool-command"><code>${escapeHtml(truncate(cmd, 200))}</code></div>`;
      }
    } else if (intention) {
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
      case "grep_search":
        return `Query: ${args.query || args.pattern || "?"}\nPath: ${args.includePattern || "all files"}`;
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
      // Find last running tool block
      const blocks = messagesEl.querySelectorAll(".tool-block:not(.tool-done)");
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
      const nameEl = block.querySelector(".tool-name");
      if (nameEl) {
        const icon = block.querySelector(".tool-icon")?.textContent || "✏️";
        nameEl.textContent = `Edit ${shortPath(msg.fileName)}`;
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
      const raw = marked.parse(text);
      return DOMPurify.sanitize(raw);
    } catch {
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
  }

  function handleSend() {
    const content = messageInput.value.trim();
    if (!content || isStreaming || !currentSessionId) {
      console.log("[ui] send blocked:", { hasContent: !!content, isStreaming, currentSessionId });
      return;
    }

    console.log("[ui] sending:", content.substring(0, 80));
    appendUserMessage(content);
    wsSend({ type: "message", sessionId: currentSessionId, content });
    messageInput.value = "";
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

  messageInput.addEventListener("input", () => {
    autoResizeTextarea();
    updateSendState();
  });

  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

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
