import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfidentialClientApplication } from "@azure/msal-node";
import dotenv from "dotenv";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";

// Load .env from project root
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

// ── Config ──

const PORT = parseInt(process.env.PORT || "3847", 10);
const DEFAULT_CWD = process.env.COPILOT_CWD || process.cwd();

// ── Auth config ──

const AUTH_TENANT_ID = process.env.AUTH_TENANT_ID || "";
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "";
const AUTH_ALLOWED_USER = process.env.AUTH_ALLOWED_USER?.toLowerCase() || "";

if (!AUTH_TENANT_ID || !AUTH_CLIENT_ID || !AUTH_ALLOWED_USER) {
  console.error(`
❌  Missing required auth environment variables.
    Set AUTH_TENANT_ID, AUTH_CLIENT_ID, and AUTH_ALLOWED_USER
    in your environment or in a .env file.
`);
  process.exit(1);
}

// Secret for signing session tokens — random per server start
const SESSION_SECRET = crypto.randomBytes(32);
// In-memory session store: token → { email, expiresAt }
const authSessions = new Map<string, { email: string; expiresAt: number }>();

const msalConfig = {
  auth: {
    clientId: AUTH_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${AUTH_TENANT_ID}`,
  },
};
const msalClient = new ConfidentialClientApplication({
  ...msalConfig,
  auth: { ...msalConfig.auth, clientSecret: "unused" },
});

// PKCE helpers
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// Temporary store for PKCE verifiers keyed by state
const pkceStore = new Map<string, { verifier: string; createdAt: number }>();

function createSessionToken(email: string): string {
  const token = base64url(crypto.randomBytes(32));
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h
  authSessions.set(token, { email, expiresAt });
  return token;
}

function validateSessionToken(token: string): string | null {
  const session = authSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    authSessions.delete(token);
    return null;
  }
  return session.email;
}

function getSessionTokenFromReq(req: http.IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = parseCookie(cookieHeader);
  return cookies["session_token"] || null;
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  const token = getSessionTokenFromReq(req);
  if (!token) return false;
  return validateSessionToken(token) !== null;
}

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

// Per-session metadata (model) — persisted to disk so it survives restarts.
// cwd is stored as a fallback cache; the SDK's SessionMetadata.context.cwd is
// the preferred source (so sessions created by the CLI are handled correctly).
const SESSION_META_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "session-meta.json");
const sessionMeta = new Map<string, { model: string; cwd?: string; name?: string }>();

function loadSessionMeta() {
  try {
    if (fs.existsSync(SESSION_META_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_META_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        const entry = v as { model?: string; cwd?: string };
        sessionMeta.set(k, { model: entry.model ?? "", cwd: entry.cwd, name: (entry as any).name });
      }
      console.log(`[meta] loaded ${sessionMeta.size} session(s) from disk`);
    }
  } catch (e: any) {
    console.warn(`[meta] failed to load: ${e.message}`);
  }
}

function saveSessionMeta() {
  try {
    const obj: Record<string, { model: string; cwd?: string }> = {};
    for (const [k, v] of sessionMeta) obj[k] = v;
    fs.writeFileSync(SESSION_META_FILE, JSON.stringify(obj, null, 2));
  } catch (e: any) {
    console.warn(`[meta] failed to save: ${e.message}`);
  }
}

/** Fetch the working directory for a session. Prefers SDK metadata, falls back to local cache. */
async function getSessionCwd(sessionId: string): Promise<string> {
  try {
    const sdkMeta = await copilot.getSessionMetadata(sessionId);
    if (sdkMeta?.context?.cwd) return sdkMeta.context.cwd;
  } catch (e: any) {
    console.warn(`[meta] could not fetch cwd for ${sessionId}: ${e.message}`);
  }
  return sessionMeta.get(sessionId)?.cwd ?? "";
}

loadSessionMeta();

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

// Pending user input / elicitation requests waiting for UI response
// requestId → { resolve }
const pendingUserRequests = new Map<string, { resolve: (value: any) => void }>();
let requestIdCounter = 0;

// ── Express + HTTP server ──

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Auth routes (before any middleware) ──

app.get("/auth/login", (_req, res) => {
  const state = base64url(crypto.randomBytes(16));
  const { verifier, challenge } = generatePkce();
  pkceStore.set(state, { verifier, createdAt: Date.now() });

  // Determine redirect URI from request
  const proto = _req.headers["x-forwarded-proto"] || _req.protocol || "http";
  const host = _req.headers["x-forwarded-host"] || _req.headers.host || `127.0.0.1:${PORT}`;
  const redirectUri = `${proto}://${host}/auth/callback`;

  const authUrl = `https://login.microsoftonline.com/${AUTH_TENANT_ID}/oauth2/v2.0/authorize?`
    + `client_id=${AUTH_CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent("openid profile email")}`
    + `&state=${state}`
    + `&code_challenge=${challenge}`
    + `&code_challenge_method=S256`
    + `&response_mode=query`;

  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(403).send(`Authentication error: ${error_description || error}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("Missing code or state parameter");
    return;
  }

  const pkce = pkceStore.get(state);
  if (!pkce) {
    res.status(400).send("Invalid or expired state");
    return;
  }
  pkceStore.delete(state);

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`;
  const redirectUri = `${proto}://${host}/auth/callback`;

  try {
    const result = await msalClient.acquireTokenByCode({
      code,
      redirectUri,
      scopes: ["openid", "profile", "email"],
      codeVerifier: pkce.verifier,
    });

    const claims = result?.idTokenClaims as any;
    const email = (claims?.preferred_username || claims?.email || claims?.upn || "").toLowerCase();

    if (!email) {
      res.status(403).send("Could not determine user email from token");
      return;
    }

    if (email !== AUTH_ALLOWED_USER) {
      console.warn(`[auth] denied login for: ${email} (allowed: ${AUTH_ALLOWED_USER})`);
      res.status(403).send(`Access denied. User ${email} is not authorized.`);
      return;
    }

    const token = createSessionToken(email);
    console.log(`[auth] user authenticated: ${email}`);

    res.setHeader("Set-Cookie", serializeCookie("session_token", token, {
      httpOnly: true,
      secure: proto === "https",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    }));
    res.redirect("/");
  } catch (e: any) {
    console.error("[auth] token exchange failed:", e.message);
    res.status(500).send("Authentication failed: " + e.message);
  }
});

app.get("/auth/logout", (_req, res) => {
  const token = getSessionTokenFromReq(_req);
  if (token) authSessions.delete(token);
  res.setHeader("Set-Cookie", serializeCookie("session_token", "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  }));
  res.redirect("/auth/login");
});

// ── Auth middleware — gate everything except /auth/* ──

app.use((req, res, next) => {
  if (req.path.startsWith("/auth/")) return next();
  // Allow login page assets
  if (req.path === "/login.html") return next();
  if (!isAuthenticated(req)) {
    // API calls get 401, page requests get redirected
    if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
      res.status(401).json({ error: "Not authenticated" });
    } else {
      res.redirect("/login.html");
    }
    return;
  }
  next();
});

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

// ── WebSocket server (with auth gate on upgrade) ──

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Only handle /ws path
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!isAuthenticated(req)) {
    console.warn("[ws] rejected unauthenticated WebSocket upgrade");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

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

function createUserInputHandler(sessionId: string) {
  return (request: any, _invocation: any) => {
    return new Promise<any>((resolve) => {
      const reqId = `uir_${++requestIdCounter}`;
      pendingUserRequests.set(reqId, { resolve });
      broadcast(sessionId, {
        type: "user_input_request",
        sessionId,
        requestId: reqId,
        question: request.question ?? "",
        choices: request.choices ?? [],
        allowFreeform: request.allowFreeform ?? true,
      });
    });
  };
}

function createElicitationHandler(sessionId: string) {
  return (context: any) => {
    return new Promise<any>((resolve) => {
      const reqId = `elic_${++requestIdCounter}`;
      pendingUserRequests.set(reqId, { resolve });
      broadcast(sessionId, {
        type: "elicitation_request",
        sessionId,
        requestId: reqId,
        message: context.message ?? "",
        schema: context.requestedSchema ?? null,
        mode: context.mode ?? "form",
        source: context.elicitationSource ?? "",
      });
    });
  };
}

/**
 * Wire up SDK session events to broadcast to ALL subscribed clients.
 * This is called once per session (not per client).
 */
function bindSessionEvents(session: CopilotSession, sessionId: string) {
  session.on((event: SessionEvent) => {
    const data = event.data as any;

    switch (event.type) {
      // ── Streaming reasoning deltas ──
      case "assistant.reasoning_delta":
        broadcast(sessionId, {
          type: "reasoning_delta",
          sessionId,
          reasoningId: data.reasoningId,
          delta: data.deltaContent ?? "",
        });
        break;

      // ── Complete reasoning block ──
      case "assistant.reasoning":
        broadcast(sessionId, {
          type: "reasoning",
          sessionId,
          reasoningId: data.reasoningId,
          content: data.content ?? "",
        });
        break;

      // ── Context window usage ──
      case "session.usage_info":
        broadcast(sessionId, {
          type: "usage_info",
          sessionId,
          currentTokens: data.currentTokens,
          tokenLimit: data.tokenLimit,
        });
        break;

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
          name: data.toolName ?? data.name ?? "unknown",
          args: data.arguments ?? data.args ?? data.input ?? {},
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
          name: data.toolName ?? data.name ?? "unknown",
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
          name: data.toolName ?? data.name ?? "unknown",
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

// Server-side heartbeat: ping every client every 30s, terminate if no pong within 10s
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;

setInterval(() => {
  wss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) {
      console.log("[ws] terminating unresponsive client");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on("connection", (ws: any) => {
  console.log("[ws] client connected");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (raw: any) => {
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
        // ── Heartbeat ──
        case "ping":
          send(ws, { type: "pong" });
          return;

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
            onUserInputRequest: createUserInputHandler(msg.sessionId || "pending"),
            onElicitationRequest: createElicitationHandler(msg.sessionId || "pending"),
          });

          const sessionId = session.sessionId;
          // Re-wire handlers with the real sessionId
          session.registerUserInputHandler(createUserInputHandler(sessionId));
          session.registerElicitationHandler(createElicitationHandler(sessionId));
          activeSessions.set(sessionId, session);
          sessionMeta.set(sessionId, { model, cwd });
          saveSessionMeta();
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
            const errMsg = sendErr?.message ?? String(sendErr);

            // If CLI lost the session, clear stale state and auto-retry resume + send
            if (errMsg.includes("Session not found") || errMsg.includes("session not found")) {
              console.log(`[message] session lost in CLI — attempting re-resume...`);
              activeSessions.delete(msg.sessionId);
              try {
                const reSession = await copilot.resumeSession(msg.sessionId, {
                  streaming: true,
                  onPermissionRequest: approveAll,
                  onUserInputRequest: createUserInputHandler(msg.sessionId),
                  onElicitationRequest: createElicitationHandler(msg.sessionId),
                });
                activeSessions.set(msg.sessionId, reSession);
                bindSessionEvents(reSession, msg.sessionId);
                console.log(`[message] re-resumed, retrying send...`);

                const retryResult = await reSession.sendAndWait(
                  { prompt: msg.content },
                  600_000,
                );
                const retryData = retryResult?.data as any;
                const retryContent = retryData?.content ?? "";
                const evH = turnDeliveredByEvents.get(msg.sessionId) ?? false;
                turnDeliveredByEvents.set(msg.sessionId, false);
                if (!evH && retryContent) {
                  broadcast(msg.sessionId, { type: "assistant_message", sessionId: msg.sessionId, content: retryContent });
                  broadcast(msg.sessionId, { type: "done", sessionId: msg.sessionId });
                }
                break;
              } catch (retryErr: any) {
                console.error(`[message] re-resume failed:`, retryErr);
                send(ws, {
                  type: "error",
                  sessionId: msg.sessionId,
                  message: `Session lost and could not recover: ${retryErr?.message ?? retryErr}`,
                });
                break;
              }
            }

            send(ws, {
              type: "error",
              sessionId: msg.sessionId,
              message: `Send error: ${errMsg}`,
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
              title: meta?.name ?? s.title ?? s.name ?? "Session",
              cwd: s.context?.cwd ?? "",
              model: meta?.model ?? s.model ?? "",
              createdAt: s.startTime ?? s.createdAt ?? "",
              updatedAt: s.lastActiveTime ?? s.updatedAt ?? "",
            };
          }).sort((a: any, b: any) => {
            const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return tb - ta;
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
            try {
              session = await copilot.resumeSession(sessionId, {
                streaming: true,
                onPermissionRequest: approveAll,
                onUserInputRequest: createUserInputHandler(sessionId),
                onElicitationRequest: createElicitationHandler(sessionId),
              });
            } catch (resumeErr: any) {
              console.error(`[session] resume failed:`, resumeErr);
              send(ws, {
                type: "error",
                sessionId,
                message: `Could not resume session: ${resumeErr?.message ?? resumeErr}`,
              });
              break;
            }
            activeSessions.set(sessionId, session);
            bindSessionEvents(session, sessionId);
          }

          // Subscribe this client to the session's broadcasts
          subscribeToSession(ws, sessionId);

          // Fetch and send history (retry on transient "Session not found" errors)
          // If all retries fail, do a fresh re-resume to fully activate the session and try once more.
          {
            const maxAttempts = 4;
            const retryDelayMs = 800;
            let historyFetched = false;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                const events = await session.getMessages();
                const history = eventsToHistory(events);
                send(ws, { type: "session_history", sessionId, messages: history });
                historyFetched = true;
                break;
              } catch (e: any) {
                const isNotFound = e.message?.includes("Session not found") || e.message?.includes("session not found");
                if (isNotFound && attempt < maxAttempts) {
                  console.warn(`[session] getMessages attempt ${attempt} failed ("Session not found"), retrying in ${retryDelayMs}ms...`);
                  await new Promise(res => setTimeout(res, retryDelayMs));
                } else {
                  console.warn(`[session] getMessages retries exhausted: ${e.message} — trying fresh re-resume...`);
                  // Fresh re-resume: create a new session object to fully activate the CLI connection
                  try {
                    const reSession = await copilot.resumeSession(sessionId, {
                      streaming: true,
                      onPermissionRequest: approveAll,
                      onUserInputRequest: createUserInputHandler(sessionId),
                      onElicitationRequest: createElicitationHandler(sessionId),
                    });
                    activeSessions.set(sessionId, reSession);
                    bindSessionEvents(reSession, sessionId);
                    const events2 = await reSession.getMessages();
                    const history2 = eventsToHistory(events2);
                    send(ws, { type: "session_history", sessionId, messages: history2 });
                    historyFetched = true;
                    console.log(`[session] history fetched after fresh re-resume`);
                  } catch (reErr: any) {
                    console.warn(`[session] fresh re-resume getMessages also failed: ${reErr.message}`);
                    send(ws, { type: "session_history", sessionId, messages: [] });
                  }
                  break;
                }
              }
            }
          }

          const meta = sessionMeta.get(sessionId);
          const cwd = await getSessionCwd(sessionId);
          send(ws, {
            type: "session_resumed",
            sessionId,
            cwd,
            model: meta?.model ?? "",
          });
          console.log(`[session] resumed: ${sessionId}, cwd=${cwd}, model=${meta?.model}`);
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
              title: meta2?.name ?? s.title ?? s.name ?? "Session",
              cwd: s.context?.cwd ?? "",
              model: meta2?.model ?? s.model ?? "",
              createdAt: s.startTime ?? s.createdAt ?? "",
              updatedAt: s.lastActiveTime ?? s.updatedAt ?? "",
            };
          }).sort((a: any, b: any) => {
            const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return tb - ta;
          });
          send(ws, { type: "session_list", sessions: sessionList2 });
          break;
        }

        // ── Rename a session ──
        case "rename_session": {
          const { sessionId, name } = msg;
          const meta = sessionMeta.get(sessionId) ?? { model: "" };
          meta.name = name?.trim() || undefined;
          sessionMeta.set(sessionId, meta);
          saveSessionMeta();
          broadcast(sessionId, { type: "title_changed", sessionId, title: meta.name ?? "Session" });
          console.log(`[session] renamed: ${sessionId.substring(0, 8)} → "${meta.name}"`);
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
            if (meta) { meta.model = newModel; saveSessionMeta(); }
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

        // -- Abort current turn --
        case "abort": {
          const session = activeSessions.get(msg.sessionId);
          if (session) {
            try {
              await session.abort();
              broadcast(msg.sessionId, { type: "done", sessionId: msg.sessionId });
            } catch (e: any) {
              console.warn("[abort] error:", e.message);
            }
          }
          break;
        }

        // ── Git diff for workspace ──
        case "get_diff": {
          const cwd = await getSessionCwd(msg.sessionId);
          if (!cwd) {
            send(ws, {
              type: "diff_result",
              sessionId: msg.sessionId,
              diff: "",
              stat: "",
              error: "Could not determine workspace directory for this session",
              cwd: "",
            });
            break;
          }
          try {
            // git diff HEAD shows both staged and unstaged vs last commit
            const diff = execSync("git diff HEAD", {
              cwd,
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024,
              timeout: 15000,
            });
            // Also get a summary of changed files
            const stat = execSync("git diff HEAD --stat", {
              cwd,
              encoding: "utf-8",
              maxBuffer: 1024 * 1024,
              timeout: 5000,
            });
            send(ws, {
              type: "diff_result",
              sessionId: msg.sessionId,
              diff,
              stat,
              cwd,
            });
          } catch (e: any) {
            send(ws, {
              type: "diff_result",
              sessionId: msg.sessionId,
              diff: "",
              stat: "",
              error: e?.message ?? "Failed to get diff",
              cwd,
            });
          }
          break;
        }

        // ── User input response (from UI) ──
        case "user_input_response": {
          const pending = pendingUserRequests.get(msg.requestId);
          if (pending) {
            pendingUserRequests.delete(msg.requestId);
            pending.resolve({
              answer: msg.answer ?? "",
              wasFreeform: msg.wasFreeform ?? true,
            });
          }
          break;
        }

        // ── Elicitation response (from UI) ──
        case "elicitation_response": {
          const pending = pendingUserRequests.get(msg.requestId);
          if (pending) {
            pendingUserRequests.delete(msg.requestId);
            pending.resolve({
              action: msg.action ?? "cancel",
              content: msg.content ?? {},
            });
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
🚀 Copilot Sessions bridge running!
   ─────────────────────────────────
   Web UI:     http://127.0.0.1:${PORT}
   WebSocket:  ws://127.0.0.1:${PORT}/ws
   Default CWD:   ${DEFAULT_CWD}
   Default model: ${defaultModel || '(auto-detect on first use)'}
   Auth:       Entra ID (tenant: ${AUTH_TENANT_ID.substring(0, 8)}…)
   Allowed:    ${AUTH_ALLOWED_USER}

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

// ── Crash protection ──
// Prevent unhandled errors from killing the server process.

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandled rejection:", reason);
});
