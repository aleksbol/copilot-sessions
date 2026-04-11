import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Config ──

const PORT = parseInt(process.env.PORT || "3847", 10);
const DEFAULT_CWD = process.env.COPILOT_CWD || process.cwd();

// ── Copilot SDK client ──

const copilot = new CopilotClient();
let clientReady = false;
let availableModels: Array<{ id: string; name: string }> = [];
let defaultModel = process.env.COPILOT_MODEL || "";

/** Ensure the SDK client is started before any SDK call. */
async function ensureClient() {
  if (clientReady) return;
  await copilot.start();
  clientReady = true;

  // Fetch available models and pick a sensible default
  try {
    const models = await copilot.listModels();
    availableModels = models.map((m: any) => ({ id: m.id ?? m.modelId, name: m.name ?? m.displayName ?? m.id }));
    console.log(`[models] available: ${availableModels.map(m => m.id).join(", ")}`);

    if (!defaultModel) {
      // Prefer Claude Sonnet, fall back to first available
      const preferred = availableModels.find(m => /claude.*sonnet/i.test(m.id))
        ?? availableModels.find(m => /gpt-4/i.test(m.id))
        ?? availableModels[0];
      defaultModel = preferred?.id ?? "";
    }
    console.log(`[models] default: ${defaultModel}`);
  } catch (e: any) {
    console.warn(`[models] could not list models: ${e.message}`);
    // Fall back to a reasonable guess
    if (!defaultModel) defaultModel = "claude-sonnet-4";
  }
}

// Track active SDK sessions: sessionId → CopilotSession
const activeSessions = new Map<string, CopilotSession>();

// Per-session metadata (cwd, model) — persists for the lifetime of the server
const sessionMeta = new Map<string, { cwd: string; model: string }>();

// Track whether the event listener already delivered content for the current turn
// sessionId → boolean
const turnDeliveredByEvents = new Map<string, boolean>();

// Track which WebSocket clients are subscribed to which sessions
// sessionId → Set<WebSocket>
const sessionSubscribers = new Map<string, Set<WebSocket>>();

// Track which session each WS client is currently viewing
// WebSocket → sessionId
const clientSession = new Map<WebSocket, string>();

// Track clientId → WebSocket to deduplicate connections from the same browser tab
const clientConnections = new Map<string, WebSocket>();

// ── Express + HTTP server ──

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

// API endpoint: list available models
app.get("/api/models", async (_req, res) => {
  try {
    await ensureClient();
    res.json({ models: availableModels, default: defaultModel });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);

// ── WebSocket server ──

const wss = new WebSocketServer({ server, path: "/ws" });
let msgSeq = 0; // monotonic message ID for deduplication

function send(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** Send a message to ALL clients subscribed to a session. */
function broadcast(sessionId: string, data: Record<string, unknown>, excludeWs?: WebSocket) {
  const subs = sessionSubscribers.get(sessionId);
  if (!subs) return;
  const tagged = { ...data, _mid: ++msgSeq };
  const json = JSON.stringify(tagged);
  console.log(`[broadcast] ${data.type} to ${subs.size} client(s), mid=${tagged._mid}`);
  for (const ws of subs) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

/** Subscribe a WS client to a session's events. */
function subscribeToSession(ws: WebSocket, sessionId: string) {
  // Unsubscribe from previous session if any
  const prev = clientSession.get(ws);
  if (prev && prev !== sessionId) {
    sessionSubscribers.get(prev)?.delete(ws);
  }
  clientSession.set(ws, sessionId);
  if (!sessionSubscribers.has(sessionId)) {
    sessionSubscribers.set(sessionId, new Set());
  }
  sessionSubscribers.get(sessionId)!.add(ws);
}

/** Unsubscribe a WS client from all sessions (on disconnect). */
function unsubscribeAll(ws: WebSocket) {
  const sessionId = clientSession.get(ws);
  if (sessionId) {
    sessionSubscribers.get(sessionId)?.delete(ws);
    // Clean up empty sets
    if (sessionSubscribers.get(sessionId)?.size === 0) {
      sessionSubscribers.delete(sessionId);
    }
  }
  clientSession.delete(ws);
}

/** Register a client connection by clientId; evict any stale connection from the same tab. */
function registerClient(ws: WebSocket, clientId: string) {
  const existing = clientConnections.get(clientId);
  if (existing && existing !== ws) {
    console.log(`[ws] evicting stale connection for client ${clientId}`);
    unsubscribeAll(existing);
    // Null out handlers so it doesn't trigger reconnect cascades
    try { existing.close(); } catch {}
  }
  clientConnections.set(clientId, ws);
}

/**
 * Wire up SDK session events to broadcast to ALL subscribed clients.
 * This is called once per session (not per client).
 */
function bindSessionEvents(session: CopilotSession, sessionId: string) {
  session.on((event: SessionEvent) => {
    const data = event.data as any;

    switch (event.type) {
      // ── Streaming text tokens ──
      case "assistant.message_delta":
        turnDeliveredByEvents.set(sessionId, true);
        broadcast(sessionId, {
          type: "token",
          sessionId,
          text: data.deltaContent ?? data.content ?? "",
        });
        break;

      // ── Streaming byte-level deltas (extract text if available) ──
      case "assistant.streaming_delta":
        if (data.text || data.delta || data.content) {
          broadcast(sessionId, {
            type: "token",
            sessionId,
            text: data.text ?? data.delta ?? data.content ?? "",
          });
        }
        break;

      // ── Complete assistant message ──
      // Suppressed: sendAndWait() return value already broadcasts this.
      // Forwarding here too would cause duplicates.
      case "assistant.message":
        break;

      // ── Turn start/end for UI state management ──
      case "assistant.turn_start":
        broadcast(sessionId, { type: "turn_start", sessionId });
        break;

      case "assistant.turn_end":
        turnDeliveredByEvents.set(sessionId, true);
        broadcast(sessionId, { type: "done", sessionId });
        break;

      // ── Tool execution start ──
      case "tool.execution_start":
        broadcast(sessionId, {
          type: "tool_start",
          sessionId,
          name: data.name ?? data.toolName ?? "unknown",
          args: data.args ?? data.input ?? data,
          callId: event.id,
          intention: data.intention ?? "",
        });
        break;

      // ── Tool execution complete ──
      case "tool.execution_complete": {
        const result = data.result ?? data.output ?? "";
        broadcast(sessionId, {
          type: "tool_result",
          sessionId,
          name: data.name ?? data.toolName ?? "unknown",
          result: typeof result === "string" ? result : JSON.stringify(result),
          callId: event.id,
          parentId: event.parentId ?? undefined,
        });
        break;
      }

      // ── Tool execution progress ──
      case "tool.execution_progress":
        broadcast(sessionId, {
          type: "tool_progress",
          sessionId,
          name: data.name ?? "unknown",
          progress: data.progress ?? "",
          callId: event.id,
        });
        break;

      // ── Tool partial results (e.g. streaming shell output) ──
      case "tool.execution_partial_result":
        broadcast(sessionId, {
          type: "tool_partial",
          sessionId,
          callId: data.toolCallId ?? event.id,
          output: data.partialOutput ?? "",
        });
        break;

      // ── Permission events (contain rich context: commands, filenames, diffs) ──
      case "permission.requested":
        broadcast(sessionId, {
          type: "permission_requested",
          sessionId,
          requestId: data.requestId,
          kind: data.permissionRequest?.kind ?? "unknown",
          toolCallId: data.permissionRequest?.toolCallId ?? "",
          intention: data.permissionRequest?.intention ?? "",
          commandText: data.permissionRequest?.fullCommandText ?? "",
          fileName: data.permissionRequest?.fileName ?? "",
          diff: data.permissionRequest?.diff ?? "",
          commands: data.permissionRequest?.commands ?? [],
        });
        break;

      case "permission.completed":
        broadcast(sessionId, {
          type: "permission_completed",
          sessionId,
          requestId: data.requestId,
          result: data.result?.kind ?? "unknown",
        });
        break;

      // ── Session info (file_created, etc.) ──
      case "session.info":
        broadcast(sessionId, {
          type: "session_info",
          sessionId,
          infoType: data.infoType ?? "",
          message: data.message ?? "",
        });
        break;

      // ── Session idle (turn complete) ──
      case "session.idle":
        break;

      // ── Title changed ──
      case "session.title_changed":
        broadcast(sessionId, {
          type: "title_changed",
          sessionId,
          title: data.title ?? "",
        });
        break;

      // ── Session error ──
      case "session.error":
        broadcast(sessionId, {
          type: "error",
          sessionId,
          message: data.message ?? "Unknown error",
        });
        break;

      // ── Subagent events ──
      case "subagent.started":
        broadcast(sessionId, {
          type: "subagent_start",
          sessionId,
          agent: data.agentName ?? data.name ?? "subagent",
        });
        break;

      case "subagent.completed":
        broadcast(sessionId, {
          type: "subagent_done",
          sessionId,
          agent: data.agentName ?? data.name ?? "subagent",
        });
        break;

      // ── Compaction ──
      case "session.compaction_start":
        broadcast(sessionId, { type: "info", sessionId, message: "Compacting context..." });
        break;

      case "session.compaction_complete":
        broadcast(sessionId, { type: "info", sessionId, message: "Context compaction complete" });
        break;

      // ── Mode change ──
      case "session.mode_changed":
        broadcast(sessionId, {
          type: "mode_changed",
          sessionId,
          mode: data.mode ?? "unknown",
        });
        break;

      default:
        console.log(`[event] ${event.type}`, JSON.stringify(data).substring(0, 300));
        break;
    }
  });
}

// ── WebSocket message handler ──

wss.on("connection", (ws) => {
  console.log("[ws] client connected");

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    // Register/deduplicate client connections by unique tab ID
    if (msg.clientId) {
      registerClient(ws, msg.clientId);
    }

    try {
      switch (msg.type) {
        // ── Create new session ──
        case "new_session": {
          await ensureClient();
          const cwd = msg.cwd || DEFAULT_CWD;
          const model = msg.model || defaultModel;

          console.log(`[session] creating: model=${model} cwd=${cwd}`);
          const session = await copilot.createSession({
            model,
            streaming: true,
            workingDirectory: cwd,
            onPermissionRequest: approveAll,
          });

          const sessionId = session.sessionId;
          activeSessions.set(sessionId, session);
          sessionMeta.set(sessionId, { cwd, model });
          bindSessionEvents(session, sessionId);
          subscribeToSession(ws, sessionId);

          send(ws, {
            type: "session_created",
            sessionId,
            title: "New session",
            cwd,
            model,
            createdAt: new Date().toISOString(),
          });

          console.log(`[session] created: ${sessionId}`);
          break;
        }

        // ── Send message to session ──
        case "message": {
          const session = activeSessions.get(msg.sessionId);
          if (!session) {
            send(ws, {
              type: "error",
              sessionId: msg.sessionId,
              message: "Session not active. Try resuming it first.",
            });
            break;
          }

          console.log(`[message] → ${msg.sessionId.substring(0, 8)}: ${msg.content.substring(0, 80)}...`);

          // Broadcast the user message to all OTHER clients watching this session
          broadcast(msg.sessionId, {
            type: "user_message",
            sessionId: msg.sessionId,
            content: msg.content,
          }, ws); // exclude sender — they already rendered it locally

          // sendAndWait blocks until the turn completes and returns the final message.
          // The session.on() listener does NOT receive assistant.message/turn_start/turn_end
          // in current SDK versions — so we rely on the return value for the response.
          try {
            const result = await session.sendAndWait(
              { prompt: msg.content },
              600_000, // 10 minute timeout
            );

            const resultData = result?.data as any;
            const content = resultData?.content ?? "";
            console.log(`[message] ← sendAndWait resolved, type: ${result?.type}, length: ${content.length}`);

            // Only broadcast from sendAndWait if the event listener didn't already handle this turn
            const eventsHandled = turnDeliveredByEvents.get(msg.sessionId) ?? false;
            turnDeliveredByEvents.set(msg.sessionId, false); // reset for next turn
            console.log(`[message] eventsHandled=${eventsHandled}`);

            if (!eventsHandled) {
              // Event listener didn't fire — send the response from sendAndWait return value
              if (content) {
                broadcast(msg.sessionId, {
                  type: "assistant_message",
                  sessionId: msg.sessionId,
                  content,
                });
              }
              broadcast(msg.sessionId, { type: "done", sessionId: msg.sessionId });
            }
          } catch (sendErr: any) {
            console.error(`[message] sendAndWait error:`, sendErr);
            send(ws, {
              type: "error",
              sessionId: msg.sessionId,
              message: `Send error: ${sendErr?.message ?? sendErr}`,
            });
          }
          break;
        }

        // ── List all sessions (from CLI's own storage) ──
        case "list_sessions": {
          await ensureClient();
          const cliSessions = await copilot.listSessions();
          const sessionList = cliSessions.map((s: any) => {
            const meta = sessionMeta.get(s.sessionId ?? s.id);
            return {
              sessionId: s.sessionId ?? s.id,
              title: s.title ?? s.name ?? "Session",
              cwd: meta?.cwd ?? s.context?.cwd ?? s.cwd ?? "",
              model: meta?.model ?? s.model ?? "",
              createdAt: s.startTime ?? s.createdAt ?? "",
              updatedAt: s.lastActiveTime ?? s.updatedAt ?? "",
            };
          });
          send(ws, { type: "session_list", sessions: sessionList });
          break;
        }

        // ── Resume an existing session ──
        case "resume_session": {
          const sessionId = msg.sessionId;
          console.log(`[session] resuming: ${sessionId}`);

          // If already active in memory, just send history
          let session = activeSessions.get(sessionId);

          if (!session) {
            // Resume via SDK — this reconnects to the CLI's persisted session
            session = await copilot.resumeSession(sessionId, {
              streaming: true,
              onPermissionRequest: approveAll,
            });
            activeSessions.set(sessionId, session);
            bindSessionEvents(session, sessionId);
          }

          // Subscribe this client to the session's broadcasts
          subscribeToSession(ws, sessionId);

          // Fetch and send history
          try {
            const events = await session.getMessages();
            const history = eventsToHistory(events);
            send(ws, { type: "session_history", sessionId, messages: history });
          } catch (e: any) {
            console.warn(`[session] could not get messages: ${e.message}`);
            send(ws, { type: "session_history", sessionId, messages: [] });
          }

          const meta = sessionMeta.get(sessionId);
          send(ws, {
            type: "session_resumed",
            sessionId,
            cwd: meta?.cwd ?? "",
            model: meta?.model ?? "",
          });
          console.log(`[session] resumed: ${sessionId}`);
          break;
        }

        // ── Delete session ──
        case "delete_session": {
          const sessionId = msg.sessionId;
          const session = activeSessions.get(sessionId);
          if (session) {
            try { await session.disconnect(); } catch {}
            activeSessions.delete(sessionId);
          }
          try {
            await copilot.deleteSession(sessionId);
          } catch (e: any) {
            console.warn(`[session] delete error: ${e.message}`);
          }
          // Send updated list
          const cliSessions2 = await copilot.listSessions();
          const sessionList2 = cliSessions2.map((s: any) => {
            const meta2 = sessionMeta.get(s.sessionId ?? s.id);
            return {
              sessionId: s.sessionId ?? s.id,
              title: s.title ?? s.name ?? "Session",
              cwd: meta2?.cwd ?? s.context?.cwd ?? s.cwd ?? "",
              model: meta2?.model ?? s.model ?? "",
              createdAt: s.startTime ?? s.createdAt ?? "",
              updatedAt: s.lastActiveTime ?? s.updatedAt ?? "",
            };
          });
          send(ws, { type: "session_list", sessions: sessionList2 });
          break;
        }

        // ── Change model for an active session ──
        case "set_model": {
          const session = activeSessions.get(msg.sessionId);
          if (!session) {
            send(ws, { type: "error", sessionId: msg.sessionId, message: "Session not active." });
            break;
          }
          const newModel = msg.model;
          console.log(`[session] changing model: ${msg.sessionId.substring(0, 8)} → ${newModel}`);
          try {
            await session.setModel(newModel);
            const meta = sessionMeta.get(msg.sessionId);
            if (meta) meta.model = newModel;
            // Notify all subscribers
            broadcast(msg.sessionId, {
              type: "model_changed",
              sessionId: msg.sessionId,
              model: newModel,
            });
          } catch (e: any) {
            send(ws, { type: "error", sessionId: msg.sessionId, message: `Model change failed: ${e.message}` });
          }
          break;
        }

        default:
          send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
      }
    } catch (err: any) {
      console.error("[ws] handler error:", err);
      send(ws, {
        type: "error",
        sessionId: msg?.sessionId,
        message: err?.message ?? "Internal error",
      });
    }
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    unsubscribeAll(ws);
    // Clean up clientId mapping if this was the active connection
    for (const [cid, cws] of clientConnections) {
      if (cws === ws) {
        clientConnections.delete(cid);
        break;
      }
    }
  });
});

/**
 * Convert SDK SessionEvent[] into a simplified history for the web client.
 */
function eventsToHistory(events: SessionEvent[]): any[] {
  const messages: any[] = [];

  for (const event of events) {
    const data = event.data as any;

    switch (event.type) {
      case "user.message":
        messages.push({
          role: "user",
          content: data.content ?? data.text ?? "",
          timestamp: event.timestamp,
        });
        break;

      case "assistant.message":
        messages.push({
          role: "assistant",
          content: data.content ?? "",
          timestamp: event.timestamp,
        });
        break;

      case "tool.execution_start":
        messages.push({
          role: "tool_call",
          name: data.name ?? data.toolName ?? "unknown",
          args: data.args ?? data.input ?? {},
          callId: event.id,
          timestamp: event.timestamp,
        });
        break;

      case "tool.execution_complete": {
        const result = data.result ?? data.output ?? "";
        messages.push({
          role: "tool_result",
          name: data.name ?? data.toolName ?? "unknown",
          result: typeof result === "string" ? result : JSON.stringify(result),
          callId: event.id,
          parentId: event.parentId ?? undefined,
          timestamp: event.timestamp,
        });
        break;
      }
    }
  }

  return messages;
}

// ── Start ──

server.listen(PORT, () => {
  console.log(`
🚀 Copilot Sessions bridge running!
   ─────────────────────────────────
   Web UI:     http://localhost:${PORT}
   WebSocket:  ws://localhost:${PORT}/ws
   Default CWD:   ${DEFAULT_CWD}
   Default model: ${defaultModel || '(auto-detect on first use)'}

   For phone access, run in another terminal:
     devtunnel host
`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[shutdown] cleaning up...");
  for (const [, session] of activeSessions) {
    try { await session.disconnect(); } catch {}
  }
  try { await copilot.stop(); } catch {}
  process.exit(0);
});
