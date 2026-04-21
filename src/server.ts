import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync, spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Load .env from project root
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

// ── Config ──

const PORT = parseInt(process.env.PORT || "3847", 10);
const DEFAULT_CWD = process.env.COPILOT_CWD || process.cwd();

// ── MCP server config ──

function loadMcpServers(): Record<string, any> | undefined {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "mcp-config.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const servers = raw.mcpServers || {};
      const count = Object.keys(servers).length;
      if (count > 0) {
        console.log(`[mcp] Loaded ${count} MCP server(s) from ${configPath}: ${Object.keys(servers).join(", ")}`);
        return servers;
      }
    }
  } catch (err: any) {
    console.warn(`[mcp] Failed to load MCP config from ${configPath}: ${err.message}`);
  }
  return undefined;
}

const mcpServers = loadMcpServers();

// ── Snapshots ──

interface Snapshot {
  id: string;
  name: string;
  description?: string;
  systemMessage: string;
  model?: string;
  cwd?: string;
  sourceSessionId?: string;
  createdAt: string;
}

const SNAPSHOTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "snapshots");

function ensureSnapshotsDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function loadSnapshots(): Snapshot[] {
  ensureSnapshotsDir();
  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".json"));
  const snaps: Snapshot[] = [];
  for (const f of files) {
    try {
      snaps.push(JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), "utf-8")));
    } catch {}
  }
  return snaps.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function saveSnapshot(snap: Snapshot) {
  ensureSnapshotsDir();
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, `${snap.id}.json`), JSON.stringify(snap, null, 2));
}

function deleteSnapshot(id: string): boolean {
  const file = path.join(SNAPSHOTS_DIR, `${id}.json`);
  if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
  return false;
}

function historyToSystemMessage(history: any[]): string {
  const MAX_CHARS = 30_000;
  const SUMMARY_BUDGET = 10_000;  // chars for topic summary section
  const RECENT_BUDGET = 18_000;   // chars for recent messages section

  // 1) Build a topic summary from ALL user messages (condensed)
  const topics: string[] = [];
  for (const msg of history) {
    if (msg.role === "user" && msg.content) {
      // First 200 chars of each user message captures the ask
      const line = msg.content.substring(0, 200).replace(/\n+/g, " ").trim();
      if (line) topics.push(`- ${line}${msg.content.length > 200 ? "..." : ""}`);
    }
  }
  let summarySection = "## Topics discussed\n" + topics.join("\n");
  if (summarySection.length > SUMMARY_BUDGET) {
    // Keep the last topics that fit
    summarySection = "## Topics discussed (most recent)\n";
    let built = "";
    for (let i = topics.length - 1; i >= 0; i--) {
      const candidate = topics[i] + "\n" + built;
      if (candidate.length > SUMMARY_BUDGET - 50) break;
      built = candidate;
    }
    summarySection += built;
  }

  // 2) Build detailed recent messages (user + assistant, skip tool noise)
  const recentParts: string[] = [];
  for (const msg of history) {
    if (msg.role === "user" && msg.content) {
      const content = msg.content.substring(0, 2000);
      recentParts.push(`**User:** ${content}${msg.content.length > 2000 ? "..." : ""}`);
    } else if (msg.role === "assistant" && msg.content) {
      const content = msg.content.substring(0, 2000);
      recentParts.push(`**Assistant:** ${content}${msg.content.length > 2000 ? "..." : ""}`);
    } else if (msg.role === "tool_call") {
      recentParts.push(`[Tool: ${msg.name}]`);
    }
    // Skip tool_result — too large
  }

  // Take as many recent messages as fit in budget (from the end)
  let recentSection = "";
  for (let i = recentParts.length - 1; i >= 0; i--) {
    const candidate = recentParts[i] + "\n\n" + recentSection;
    if (candidate.length > RECENT_BUDGET) break;
    recentSection = candidate;
  }

  const omitted = recentParts.length - recentSection.split("\n\n").filter(Boolean).length;

  const preamble = `You are continuing from a previous session snapshot.
The snapshot contains a summary of all topics discussed followed by the most recent messages in full detail.
${omitted > 0 ? `(${omitted} earlier messages omitted for space)\n` : ""}`;

  let result = preamble + "\n" + summarySection.trim() + "\n\n## Recent conversation\n" + recentSection.trim();

  // Hard cap safety
  if (result.length > MAX_CHARS) {
    result = result.substring(result.length - MAX_CHARS);
  }

  return result;
}

// ── Search index ──

interface SearchIndexEntry {
  title: string;
  model: string;
  cwd: string;
  updatedAt: string;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>;
}

const SEARCH_INDEX_FILE = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "search-index.json");
const searchIndex = new Map<string, SearchIndexEntry>();
let searchIndexReady = false;

function loadSearchIndex() {
  try {
    if (fs.existsSync(SEARCH_INDEX_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEARCH_INDEX_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        searchIndex.set(k, v as SearchIndexEntry);
      }
      console.log(`[search] loaded index with ${searchIndex.size} session(s)`);
    }
  } catch (e: any) {
    console.warn(`[search] failed to load index: ${e.message}`);
  }
}

function saveSearchIndex() {
  try {
    const dir = path.dirname(SEARCH_INDEX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, SearchIndexEntry> = {};
    for (const [k, v] of searchIndex) obj[k] = v;
    fs.writeFileSync(SEARCH_INDEX_FILE, JSON.stringify(obj));
  } catch (e: any) {
    console.warn(`[search] failed to save index: ${e.message}`);
  }
}

/** Extract user/assistant messages from SDK message array */
function extractSearchMessages(msgs: any[]): SearchIndexEntry["messages"] {
  const result: SearchIndexEntry["messages"] = [];
  for (const m of msgs) {
    if ((m.role === "user" || m.role === "assistant") && m.content) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      // Truncate to 2000 chars per message for index size management
      result.push({
        role: m.role,
        content: content.substring(0, 2000),
        timestamp: m.timestamp,
      });
    }
  }
  return result;
}

/** Update the search index for a single session */
async function indexSession(sessionId: string, sessionInfo?: any): Promise<boolean> {
  try {
    // Check if already indexed and up-to-date
    const existing = searchIndex.get(sessionId);
    const updatedAt = sessionInfo?.lastActiveTime ?? sessionInfo?.updatedAt ?? "";
    if (existing && existing.updatedAt && updatedAt && existing.updatedAt === updatedAt) {
      return false; // already current
    }

    // Resume session temporarily to get messages
    let session = activeSessions.get(sessionId);
    let tempSession = false;
    if (!session) {
      try {
        session = await copilot.resumeSession(sessionId, {
          streaming: true,
          onPermissionRequest: approveAll,
        });
        tempSession = true;
      } catch {
        return false;
      }
    }

    let msgs: any[];
    try {
      msgs = await session.getMessages();
    } catch (e: any) {
      console.warn(`[search] getMessages failed for ${sessionId.substring(0, 8)}: ${e.message}`);
      msgs = [];
    }
    if (tempSession) {
      try { await session.disconnect(); } catch {}
    }

    const extracted = extractSearchMessages(msgs);
    console.log(`[search] session ${sessionId.substring(0, 8)}: raw=${msgs.length} events, extracted=${extracted.length} msgs`);

    // Skip if no messages retrieved (don't overwrite existing data with empty)
    if (extracted.length === 0 && existing && existing.messages.length > 0) {
      return false;
    }
    if (extracted.length === 0) {
      return false; // nothing to index
    }

    const meta = sessionMeta.get(sessionId);
    const entry: SearchIndexEntry = {
      title: meta?.name ?? sessionInfo?.title ?? sessionInfo?.name ?? "Session",
      model: meta?.model ?? sessionInfo?.model ?? "",
      cwd: meta?.cwd ?? sessionInfo?.context?.cwd ?? "",
      updatedAt,
      messages: extracted,
    };

    searchIndex.set(sessionId, entry);
    return true;
  } catch (e: any) {
    console.warn(`[search] failed to index session ${sessionId}: ${e.message}`);
    return false;
  }
}

/** Background: index all sessions. Runs without blocking startup. */
async function buildSearchIndex() {
  try {
    await ensureClient();
    const allSessions = await copilot.listSessions();
    console.log(`[search] indexing ${allSessions.length} session(s) in background...`);

    let indexed = 0;
    let skipped = 0;
    for (const s of allSessions) {
      const sid = (s as any).sessionId ?? (s as any).id;
      try {
        const wasNew = await indexSession(sid, s);
        if (wasNew) indexed++;
        else skipped++;
      } catch {
        // continue with next session
      }
      // Yield to event loop every 3 sessions to avoid blocking
      if ((indexed + skipped) % 3 === 0) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // Remove entries for sessions that no longer exist
    const validIds = new Set(allSessions.map((s: any) => s.sessionId ?? s.id));
    for (const id of searchIndex.keys()) {
      if (!validIds.has(id)) searchIndex.delete(id);
    }

    saveSearchIndex();
    searchIndexReady = true;
    console.log(`[search] index complete: ${indexed} new, ${skipped} unchanged, ${searchIndex.size} total`);
  } catch (e: any) {
    console.error(`[search] background indexing failed: ${e.message}`);
    searchIndexReady = true; // mark ready even on failure so searches work with partial data
  }
}

/** Incrementally update index for a session after a turn completes */
function updateSearchIndexForSession(sessionId: string, userContent?: string, assistantContent?: string) {
  const entry = searchIndex.get(sessionId);
  const meta = sessionMeta.get(sessionId);
  if (entry) {
    if (userContent) {
      entry.messages.push({ role: "user", content: userContent.substring(0, 2000) });
    }
    if (assistantContent) {
      entry.messages.push({ role: "assistant", content: assistantContent.substring(0, 2000) });
    }
    entry.updatedAt = new Date().toISOString();
    entry.title = meta?.name ?? entry.title;
  } else {
    // New session — create minimal entry, full index will catch up
    searchIndex.set(sessionId, {
      title: meta?.name ?? "Session",
      model: meta?.model ?? "",
      cwd: meta?.cwd ?? "",
      updatedAt: new Date().toISOString(),
      messages: [
        ...(userContent ? [{ role: "user" as const, content: userContent.substring(0, 2000) }] : []),
        ...(assistantContent ? [{ role: "assistant" as const, content: assistantContent.substring(0, 2000) }] : []),
      ],
    });
  }
  // Debounced save — don't write on every turn
  scheduleIndexSave();
}

let indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleIndexSave() {
  if (indexSaveTimer) return;
  indexSaveTimer = setTimeout(() => {
    indexSaveTimer = null;
    saveSearchIndex();
  }, 10_000); // save at most every 10 seconds
}

/** Keyword search across the index */
function keywordSearch(query: string, scope: "all" | "current", currentSessionId?: string): any[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: any[] = [];

  for (const [sessionId, entry] of searchIndex) {
    if (scope === "current" && sessionId !== currentSessionId) continue;

    for (let i = 0; i < entry.messages.length; i++) {
      const msg = entry.messages[i];
      const lc = msg.content.toLowerCase();
      if (terms.every(t => lc.includes(t))) {
        // Build snippet around the first match
        const firstTermIdx = Math.min(...terms.map(t => lc.indexOf(t)).filter(idx => idx >= 0));
        const snippetStart = Math.max(0, firstTermIdx - 60);
        const snippetEnd = Math.min(msg.content.length, firstTermIdx + 200);
        const snippet = (snippetStart > 0 ? "…" : "") +
          msg.content.substring(snippetStart, snippetEnd) +
          (snippetEnd < msg.content.length ? "…" : "");

        results.push({
          sessionId,
          title: entry.title,
          model: entry.model,
          role: msg.role,
          messageIndex: i,
          snippet,
          timestamp: msg.timestamp,
        });
      }
    }
  }

  // Sort by relevance (title matches first, then recency)
  return results.slice(0, 50);
}

// Load existing index from disk on startup
loadSearchIndex();

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

// In-memory session store: token → { email, expiresAt }
const authSessions = new Map<string, { email: string; expiresAt: number }>();

// OIDC nonce store: nonce → expiresAt (short-lived, prevents token replay)
const pendingNonces = new Map<string, number>();

// Azure AD JWKS endpoint for JWT signature verification
const JWKS = createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${AUTH_TENANT_ID}/discovery/v2.0/keys`)
);
const AUTH_ISSUER = `https://login.microsoftonline.com/${AUTH_TENANT_ID}/v2.0`;

// Simple rate limiter for auth endpoints
const authRateLimiter = (() => {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const MAX_REQUESTS = 10;
  const WINDOW_MS = 60_000; // 1 minute
  return (ip: string): boolean => {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    entry.count++;
    return entry.count <= MAX_REQUESTS;
  };
})();

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

// ── Process tracking store ──

interface TrackedProcess {
  id: string;           // tool call ID from the SDK
  sessionId: string;
  name: string;         // tool name (e.g. "powershell", "bash")
  command: string;      // the command that was run
  intention: string;    // AI's stated intention
  status: "running" | "done" | "failed" | "detached";
  output: string[];     // accumulated output lines
  startedAt: string;    // ISO timestamp
  completedAt?: string;
  result?: string;      // final result summary
}

const processStore = new Map<string, TrackedProcess>();
const MAX_PROCESSES = 100; // retain last N processes

function pruneProcesses() {
  if (processStore.size <= MAX_PROCESSES) return;
  // Remove oldest completed processes first
  const sorted = [...processStore.entries()]
    .filter(([, p]) => p.status !== "running")
    .sort((a, b) => (a[1].startedAt < b[1].startedAt ? -1 : 1));
  while (processStore.size > MAX_PROCESSES && sorted.length > 0) {
    const [id] = sorted.shift()!;
    processStore.delete(id);
  }
}

function broadcastToAll(data: Record<string, unknown>) {
  const tagged = { ...data, _mid: ++msgSeq };
  const json = JSON.stringify(tagged);
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

// ── Loop mode state ──

interface LoopState {
  active: boolean;
  iteration: number;
  throttleDelay: number;  // current delay in ms
  sessionId: string;
}

const LOOP_INITIAL_DELAY = 5_000;   // 5 seconds
const LOOP_MAX_DELAY = 3_600_000;   // 1 hour

const activeLoops = new Map<string, LoopState>(); // sessionId → LoopState

const LOOP_INSTRUCTION = `\n\n---\n\n[LOOP MODE IS ON] You must keep working on this task until it is fully complete. When you are done or fully blocked, you MUST include the following JSON block at the very end of your response:\n{"loop_status": "done"}\nor\n{"loop_status": "blocked", "reason": "description of what is blocking you"}\nDo NOT include this JSON block until you are truly finished or blocked. If you still have work to do, just continue working without the JSON block.`;

const LOOP_CONTINUATION = `---\n\n[LOOP MODE] Continue working on the original task. You have more work to do. When finished or blocked, include at the very end of your response:\n{"loop_status": "done"}\nor\n{"loop_status": "blocked", "reason": "description of what is blocking you"}`;

function parseLoopStatus(content: string): { status: string; reason?: string } | null {
  // Look for {"loop_status": "done"} or {"loop_status": "blocked", "reason": "..."} at the end
  const match = content.match(/\{\s*"loop_status"\s*:\s*"(done|blocked)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?\s*\}\s*$/);
  if (match) {
    return { status: match[1], reason: match[2] };
  }
  return null;
}

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

/** Fetch the working directory for a session. Prefers local cache (set at creation), falls back to SDK metadata. */
async function getSessionCwd(sessionId: string): Promise<string> {
  // Local cache is set at creation time with the correct cwd
  const localCwd = sessionMeta.get(sessionId)?.cwd;
  if (localCwd) return localCwd;
  // Fall back to SDK metadata for sessions created before local caching
  try {
    const sdkMeta = await copilot.getSessionMetadata(sessionId);
    if (sdkMeta?.context?.cwd) return sdkMeta.context.cwd;
  } catch (e: any) {
    console.warn(`[meta] could not fetch cwd for ${sessionId}: ${e.message}`);
  }
  return "";
}

loadSessionMeta();

// Track whether the event listener already delivered content for the current turn
// sessionId → boolean
const turnDeliveredByEvents = new Map<string, boolean>();

// Per-session event ring buffer for instant replay on session switch
const EVENT_BUFFER_SIZE = 500;
const sessionEventBuffers = new Map<string, any[]>();

// Full message history cache for pagination (sessionId → history array)
const HISTORY_PAGE_SIZE = 100;
const sessionHistoryCache = new Map<string, any[]>();

function appendToEventBuffer(sessionId: string, event: Record<string, unknown>) {
  let buf = sessionEventBuffers.get(sessionId);
  if (!buf) {
    buf = [];
    sessionEventBuffers.set(sessionId, buf);
  }
  buf.push(event);
  if (buf.length > EVENT_BUFFER_SIZE) {
    buf.splice(0, buf.length - EVENT_BUFFER_SIZE);
  }
}

// Track which sessions have had events bound (prevent duplicate listeners)
const boundSessionIds = new Set<string>();

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

// Track the most recent pending prompt per session so it can be re-sent on session switch
// sessionId → the broadcast message object
const pendingPrompts = new Map<string, any>();

// ── Express + HTTP server ──

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Auth routes (before any middleware) ──

// Rate-limit middleware for auth routes
app.use("/auth", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!authRateLimiter(ip)) {
    res.status(429).send("Too many requests. Try again later.");
    return;
  }
  next();
});

// /auth/login — serves an HTML page that generates PKCE in the browser,
// stores the verifier in sessionStorage, and redirects to Azure AD.
// Also generates a server-side nonce to prevent token replay.
app.get("/auth/login", (_req, res) => {
  const proto = _req.headers["x-forwarded-proto"] || _req.protocol || "http";
  const host = _req.headers["x-forwarded-host"] || _req.headers.host || `127.0.0.1:${PORT}`;
  const redirectUri = `${proto}://${host}/auth/callback`;

  // Generate server-side nonce and store it (valid for 10 minutes)
  const nonce = base64url(crypto.randomBytes(32));
  pendingNonces.set(nonce, Date.now() + 10 * 60 * 1000);
  // Prune expired nonces
  for (const [n, exp] of pendingNonces) {
    if (Date.now() > exp) pendingNonces.delete(n);
  }

  res.type("html").send(`<!DOCTYPE html>
<html><head><title>Signing in…</title></head><body>
<p>Redirecting to Microsoft login…</p>
<script>
(async () => {
  // Generate PKCE verifier + challenge in the browser
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const verifier = btoa(String.fromCharCode(...buf))
    .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");

  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");

  // Random state
  const stateBuf = new Uint8Array(16);
  crypto.getRandomValues(stateBuf);
  const state = btoa(String.fromCharCode(...stateBuf))
    .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");

  // Store verifier and nonce so /auth/callback page can use them
  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("pkce_state", state);
  sessionStorage.setItem("oidc_nonce", ${JSON.stringify(nonce)});

  const params = new URLSearchParams({
    client_id: ${JSON.stringify(AUTH_CLIENT_ID)},
    response_type: "code",
    redirect_uri: ${JSON.stringify(redirectUri)},
    scope: "openid profile email",
    state,
    nonce: ${JSON.stringify(nonce)},
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_mode: "query",
  });

  location.href = "https://login.microsoftonline.com/${AUTH_TENANT_ID}/oauth2/v2.0/authorize?" + params;
})();
</script>
</body></html>`);
});

// /auth/callback — serves an HTML page that exchanges the code for tokens
// via browser-side fetch (cross-origin, required by Azure AD SPA platform).
app.get("/auth/callback", (_req, res) => {
  const proto = _req.headers["x-forwarded-proto"] || _req.protocol || "http";
  const host = _req.headers["x-forwarded-host"] || _req.headers.host || `127.0.0.1:${PORT}`;
  const redirectUri = `${proto}://${host}/auth/callback`;

  res.type("html").send(`<!DOCTYPE html>
<html><head><title>Completing sign-in…</title></head><body>
<p id="status">Completing sign-in…</p>
<script>
(async () => {
  const status = document.getElementById("status");
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDesc = params.get("error_description");

    if (error) { status.textContent = "Auth error: " + (errorDesc || error); return; }
    if (!code || !state) { status.textContent = "Missing code or state"; return; }

    const savedState = sessionStorage.getItem("pkce_state");
    if (state !== savedState) { status.textContent = "State mismatch"; return; }

    const verifier = sessionStorage.getItem("pkce_verifier");
    if (!verifier) { status.textContent = "Missing PKCE verifier"; return; }

    // Exchange code for tokens — browser-side fetch (cross-origin to Azure AD)
    const tokenRes = await fetch(
      "https://login.microsoftonline.com/${AUTH_TENANT_ID}/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ${JSON.stringify(AUTH_CLIENT_ID)},
          grant_type: "authorization_code",
          code,
          redirect_uri: ${JSON.stringify(redirectUri)},
          code_verifier: verifier,
          scope: "openid profile email",
        }),
      }
    );
    const tokenJson = await tokenRes.json();
    if (tokenJson.error) throw new Error(tokenJson.error_description || tokenJson.error);

    const idToken = tokenJson.id_token;
    if (!idToken) throw new Error("No id_token in response");

    // Retrieve the nonce to send to server for validation
    const nonce = sessionStorage.getItem("oidc_nonce");
    if (!nonce) throw new Error("Missing OIDC nonce");

    // Send id_token to our server to create a session
    const verifyRes = await fetch("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken, nonce }),
    });
    if (!verifyRes.ok) {
      const text = await verifyRes.text();
      throw new Error(text);
    }

    // Clean up
    sessionStorage.removeItem("pkce_verifier");
    sessionStorage.removeItem("pkce_state");
    sessionStorage.removeItem("oidc_nonce");

    // Redirect to app
    location.href = "/";
  } catch (e) {
    status.textContent = "Authentication failed: " + e.message;
  }
})();
</script>
</body></html>`);
});

// /auth/verify — accepts an id_token from the browser, cryptographically
// verifies the JWT signature against Azure AD's JWKS, validates all claims,
// and sets a session cookie.
app.use(express.json());
app.post("/auth/verify", async (req, res) => {
  try {
    const { id_token, nonce } = req.body;
    if (!id_token) { res.status(400).send("Missing id_token"); return; }
    if (!nonce) { res.status(400).send("Missing nonce"); return; }

    // Validate nonce was issued by this server and hasn't expired
    const nonceExpiry = pendingNonces.get(nonce);
    if (!nonceExpiry || Date.now() > nonceExpiry) {
      pendingNonces.delete(nonce);
      res.status(403).send("Invalid or expired nonce"); return;
    }
    // Delete nonce immediately — single use
    pendingNonces.delete(nonce);

    // Cryptographically verify JWT signature against Azure AD's public keys
    // and validate issuer, audience, and expiration claims
    const { payload } = await jwtVerify(id_token, JWKS, {
      issuer: AUTH_ISSUER,
      audience: AUTH_CLIENT_ID,
    });

    // Validate the nonce claim in the token matches what we sent
    if (payload.nonce !== nonce) {
      res.status(403).send("Token nonce mismatch"); return;
    }

    const email = ((payload.preferred_username || payload.email || payload.upn || "") as string).toLowerCase();
    if (!email) { res.status(403).send("Could not determine user email from token"); return; }

    if (email !== AUTH_ALLOWED_USER) {
      console.warn(`[auth] denied login for: ${email} (allowed: ${AUTH_ALLOWED_USER})`);
      res.status(403).send(`Access denied. User ${email} is not authorized.`);
      return;
    }

    const token = createSessionToken(email);
    console.log(`[auth] user authenticated: ${email}`);

    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    res.setHeader("Set-Cookie", serializeCookie("session_token", token, {
      httpOnly: true,
      secure: proto === "https",
      sameSite: "strict",
      path: "/",
      maxAge: 24 * 60 * 60,
    }));
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[auth] verify failed:", e.message);
    res.status(500).send("Verification failed");
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

// Route /scripts to scripts.html
app.get("/scripts", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "scripts.html"));
});

// API endpoint: list available models
app.get("/api/models", async (_req, res) => {
  try {
    await ensureClient();
    res.json({ models: availableModels, default: defaultModel });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// API endpoints: snapshots
app.get("/api/snapshots", (_req, res) => {
  res.json(loadSnapshots().map(s => ({ id: s.id, name: s.name, description: s.description, model: s.model, cwd: s.cwd, createdAt: s.createdAt })));
});

app.delete("/api/snapshots/:id", (req, res) => {
  if (deleteSnapshot(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: "Snapshot not found" });
});

// ── Search API endpoints ──

app.get("/api/search", (req, res) => {
  const q = (req.query.q as string || "").trim();
  const scope = (req.query.scope as string) === "current" ? "current" : "all";
  const sessionId = req.query.sessionId as string | undefined;
  if (!q) { res.json({ results: [] }); return; }
  const results = keywordSearch(q, scope, sessionId);
  res.json({ results, indexed: searchIndex.size, ready: searchIndexReady });
});

app.post("/api/search/ai", async (req, res) => {
  const { query, scope, sessionId } = req.body;
  if (!query?.trim()) { res.json({ results: [], answer: "" }); return; }

  try {
    await ensureClient();

    // Build condensed context from index
    const entries: string[] = [];
    let totalChars = 0;
    const MAX_CONTEXT = 80_000; // stay well within token limits

    for (const [sid, entry] of searchIndex) {
      if (scope === "current" && sid !== sessionId) continue;
      // Condense each session to ~200 chars per message
      const condensed = entry.messages.map(m =>
        `[${m.role}] ${m.content.substring(0, 200)}`
      ).join("\n");

      const sessionBlock = `\n### Session: "${entry.title}" (id: ${sid})\n${condensed}\n`;
      if (totalChars + sessionBlock.length > MAX_CONTEXT) break;
      entries.push(sessionBlock);
      totalChars += sessionBlock.length;
    }

    const systemPrompt = `You are a search assistant for a conversation history tool. The user wants to find relevant conversations from their past sessions.

Below are condensed transcripts of their sessions. For each session, messages are prefixed with [user] or [assistant].

${entries.join("\n")}

Based on the user's query, return a JSON array of the most relevant sessions. Each result should have:
- "sessionId": the session ID
- "title": the session title
- "relevance": a brief explanation of why this session is relevant
- "snippet": a short excerpt from the most relevant message

Return ONLY valid JSON, no other text. Example:
[{"sessionId": "abc", "title": "My Chat", "relevance": "Discusses deployment", "snippet": "Let me deploy..."}]

If no sessions match, return an empty array: []`;

    // Use a one-shot session with a cheap model
    const aiModel = availableModels.find(m => /haiku/i.test(m.id))?.id
      ?? availableModels.find(m => /gpt-4.*mini/i.test(m.id))?.id
      ?? availableModels.find(m => /sonnet/i.test(m.id))?.id
      ?? defaultModel;

    const aiSession = await copilot.createSession({
      model: aiModel,
      workingDirectory: DEFAULT_CWD,
      onPermissionRequest: approveAll,
      systemMessage: { mode: "replace" as const, content: systemPrompt },
    });

    const result = await aiSession.sendAndWait(
      { prompt: `Search query: ${query}` },
      60_000, // 1 minute timeout for AI search
    );

    const aiContent = (result?.data as any)?.content ?? "";
    try { await aiSession.disconnect(); } catch {}

    // Parse the AI response as JSON
    let results: any[] = [];
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = aiContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        results = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // If parsing fails, return the raw response
      res.json({ results: [], answer: aiContent, raw: true });
      return;
    }

    res.json({ results, indexed: searchIndex.size });
  } catch (e: any) {
    console.error(`[search] AI search error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/search/status", (_req, res) => {
  res.json({ ready: searchIndexReady, indexed: searchIndex.size });
});

// ── Canned Scripts ──

interface ScriptConfig {
  id: string;
  name: string;
  description: string;
  path: string;
  args: string[];
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

interface ScriptRun {
  id: string;
  scriptId: string;
  scriptName: string;
  status: "running" | "done" | "failed" | "killed";
  output: string[];
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
}

const SCRIPTS_CONFIG_FILE = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "scripts.json");
const SCRIPT_RUNS_FILE = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "script-runs.json");
const MAX_RUNS_PER_SCRIPT = 20;
const MAX_OUTPUT_LINES = 5000;

let scriptConfigs: ScriptConfig[] = [];
const scriptRuns = new Map<string, ScriptRun>(); // runId → run
const activeScriptProcesses = new Map<string, ChildProcess>(); // runId → child process

function loadScriptConfigs() {
  try {
    if (fs.existsSync(SCRIPTS_CONFIG_FILE)) {
      scriptConfigs = JSON.parse(fs.readFileSync(SCRIPTS_CONFIG_FILE, "utf-8"));
      console.log(`[scripts] loaded ${scriptConfigs.length} script config(s)`);
    }
  } catch (e: any) {
    console.warn(`[scripts] failed to load configs: ${e.message}`);
  }
}

function saveScriptConfigs() {
  try {
    const dir = path.dirname(SCRIPTS_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SCRIPTS_CONFIG_FILE, JSON.stringify(scriptConfigs, null, 2));
  } catch (e: any) {
    console.warn(`[scripts] failed to save configs: ${e.message}`);
  }
}

function loadScriptRuns() {
  try {
    if (fs.existsSync(SCRIPT_RUNS_FILE)) {
      const data: ScriptRun[] = JSON.parse(fs.readFileSync(SCRIPT_RUNS_FILE, "utf-8"));
      for (const run of data) {
        // Don't restore "running" status — process is gone after restart
        if (run.status === "running") run.status = "failed";
        scriptRuns.set(run.id, run);
      }
      console.log(`[scripts] loaded ${scriptRuns.size} run(s) from history`);
    }
  } catch (e: any) {
    console.warn(`[scripts] failed to load runs: ${e.message}`);
  }
}

function saveScriptRuns() {
  try {
    const dir = path.dirname(SCRIPT_RUNS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Keep only last N runs per script
    const byScript = new Map<string, ScriptRun[]>();
    for (const run of scriptRuns.values()) {
      const arr = byScript.get(run.scriptId) ?? [];
      arr.push(run);
      byScript.set(run.scriptId, arr);
    }
    const kept: ScriptRun[] = [];
    for (const [, runs] of byScript) {
      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      kept.push(...runs.slice(0, MAX_RUNS_PER_SCRIPT));
    }
    fs.writeFileSync(SCRIPT_RUNS_FILE, JSON.stringify(kept));
  } catch (e: any) {
    console.warn(`[scripts] failed to save runs: ${e.message}`);
  }
}

loadScriptConfigs();
loadScriptRuns();

// REST API: Script configs
app.get("/api/scripts", (_req, res) => {
  res.json(scriptConfigs);
});

app.post("/api/scripts", (req, res) => {
  const { name, description, path: scriptPath, args, cwd } = req.body;
  if (!name || !scriptPath) { res.status(400).json({ error: "name and path are required" }); return; }
  const config: ScriptConfig = {
    id: crypto.randomBytes(8).toString("hex"),
    name,
    description: description || "",
    path: scriptPath,
    args: args || [],
    cwd: cwd || DEFAULT_CWD,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  scriptConfigs.push(config);
  saveScriptConfigs();
  res.json(config);
});

app.put("/api/scripts/:id", (req, res) => {
  const idx = scriptConfigs.findIndex(s => s.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Script not found" }); return; }
  const { name, description, path: scriptPath, args, cwd } = req.body;
  if (name !== undefined) scriptConfigs[idx].name = name;
  if (description !== undefined) scriptConfigs[idx].description = description;
  if (scriptPath !== undefined) scriptConfigs[idx].path = scriptPath;
  if (args !== undefined) scriptConfigs[idx].args = args;
  if (cwd !== undefined) scriptConfigs[idx].cwd = cwd;
  scriptConfigs[idx].updatedAt = new Date().toISOString();
  saveScriptConfigs();
  res.json(scriptConfigs[idx]);
});

app.delete("/api/scripts/:id", (req, res) => {
  const idx = scriptConfigs.findIndex(s => s.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Script not found" }); return; }
  scriptConfigs.splice(idx, 1);
  saveScriptConfigs();
  res.json({ ok: true });
});

// REST API: Script runs
app.get("/api/scripts/runs", (_req, res) => {
  const runs = [...scriptRuns.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json(runs);
});

app.get("/api/scripts/runs/:id", (req, res) => {
  const run = scriptRuns.get(req.params.id);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
});

// Start a script run
app.post("/api/scripts/:id/run", (req, res) => {
  const config = scriptConfigs.find(s => s.id === req.params.id);
  if (!config) { res.status(404).json({ error: "Script not found" }); return; }

  const runId = crypto.randomBytes(8).toString("hex");
  const run: ScriptRun = {
    id: runId,
    scriptId: config.id,
    scriptName: config.name,
    status: "running",
    output: [],
    startedAt: new Date().toISOString(),
  };
  scriptRuns.set(runId, run);

  // Spawn the process
  const child = spawn(config.path, config.args, {
    cwd: config.cwd || DEFAULT_CWD,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  activeScriptProcesses.set(runId, child);

  const appendOutput = (line: string) => {
    run.output.push(line);
    if (run.output.length > MAX_OUTPUT_LINES) {
      run.output.splice(0, run.output.length - MAX_OUTPUT_LINES);
    }
    broadcastToAll({ type: "script_run_output", runId, line });
  };

  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line || lines.length === 1) appendOutput(line);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line || lines.length === 1) appendOutput(`[stderr] ${line}`);
    }
  });

  child.on("close", (code: number | null) => {
    run.status = code === 0 ? "done" : "failed";
    run.exitCode = code;
    run.completedAt = new Date().toISOString();
    activeScriptProcesses.delete(runId);
    broadcastToAll({ type: "script_run_done", runId, status: run.status, exitCode: code });
    saveScriptRuns();
    console.log(`[scripts] run ${runId} completed: exit=${code}`);
  });

  child.on("error", (err: Error) => {
    appendOutput(`[error] ${err.message}`);
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    activeScriptProcesses.delete(runId);
    broadcastToAll({ type: "script_run_done", runId, status: "failed", exitCode: null });
    saveScriptRuns();
  });

  console.log(`[scripts] started run ${runId} for "${config.name}" (pid=${child.pid})`);
  broadcastToAll({ type: "script_run_started", run });
  res.json(run);
});

// Kill a running script
app.post("/api/scripts/runs/:id/kill", (req, res) => {
  const run = scriptRuns.get(req.params.id);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  const child = activeScriptProcesses.get(req.params.id);
  if (!child) { res.status(400).json({ error: "Process not running" }); return; }
  try {
    child.kill("SIGTERM");
    // On Windows, SIGTERM may not work — use taskkill
    if (process.platform === "win32" && child.pid) {
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
    }
    run.status = "killed";
    run.completedAt = new Date().toISOString();
    activeScriptProcesses.delete(req.params.id);
    broadcastToAll({ type: "script_run_done", runId: req.params.id, status: "killed", exitCode: null });
    saveScriptRuns();
    res.json({ ok: true });
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

/** Send a message to ALL clients subscribed to a session. Also buffers for replay. */
function broadcast(sessionId: string, data: Record<string, unknown>, excludeWs?: WebSocket) {
  const tagged = { ...data, _mid: ++msgSeq };
  // Don't buffer prompt events — they're re-sent via pendingPrompts on session switch
  const skipBuffer = data.type === "user_input_request" || data.type === "elicitation_request";
  if (!skipBuffer) appendToEventBuffer(sessionId, tagged);
  // Turn ended — any pending prompt is no longer relevant
  if (data.type === "done") pendingPrompts.delete(sessionId);
  const subs = sessionSubscribers.get(sessionId);
  if (!subs || subs.size === 0) return;
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
      const promptMsg = {
        type: "user_input_request",
        sessionId,
        requestId: reqId,
        question: request.question ?? "",
        choices: request.choices ?? [],
        allowFreeform: request.allowFreeform ?? true,
      };
      pendingPrompts.set(sessionId, promptMsg);
      broadcast(sessionId, promptMsg);
    });
  };
}

function createElicitationHandler(sessionId: string) {
  return (context: any) => {
    return new Promise<any>((resolve) => {
      const reqId = `elic_${++requestIdCounter}`;
      pendingUserRequests.set(reqId, { resolve });
      const promptMsg = {
        type: "elicitation_request",
        sessionId,
        requestId: reqId,
        message: context.message ?? "",
        schema: context.requestedSchema ?? null,
        mode: context.mode ?? "form",
        source: context.elicitationSource ?? "",
      };
      pendingPrompts.set(sessionId, promptMsg);
      broadcast(sessionId, promptMsg);
    });
  };
}

/**
 * Wire up SDK session events to broadcast to ALL subscribed clients.
 * This is called once per session (not per client).
 */
function bindSessionEvents(session: CopilotSession, sessionId: string) {
  if (boundSessionIds.has(sessionId)) {
    console.log(`[session] events already bound for ${sessionId.substring(0, 8)}, skipping`);
    return;
  }
  boundSessionIds.add(sessionId);
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
      case "tool.execution_start": {
        const toolName = data.toolName ?? data.name ?? "unknown";
        const args = data.arguments ?? data.args ?? data.input ?? {};
        broadcast(sessionId, {
          type: "tool_start",
          sessionId,
          name: toolName,
          args,
          callId: event.id,
          intention: data.intention ?? "",
        });
        // Track shell processes in the process store
        if (["powershell", "bash", "shell"].includes(toolName)) {
          const toolCallId = data.toolCallId ?? (event as any).toolCallId ?? "";
          console.log(`[process] START id=${event.id} toolCallId=${toolCallId} tool=${toolName} dataKeys=${Object.keys(data).join(",")}`);
          const proc: TrackedProcess = {
            id: event.id,
            sessionId,
            name: toolName,
            command: typeof args === "object" ? (args.command ?? args.cmd ?? JSON.stringify(args)) : String(args),
            intention: data.intention ?? "",
            status: "running",
            output: [],
            startedAt: new Date().toISOString(),
          };
          processStore.set(event.id, proc);
          // Also index by toolCallId so completion events can find it
          if (toolCallId) processStore.set(toolCallId, proc);
          pruneProcesses();
          broadcastToAll({ type: "process_update", process: proc });
        }
        break;
      }

      // ── Tool execution complete ──
      case "tool.execution_complete": {
        const result = data.result ?? data.output ?? "";
        const completedToolName = data.toolName ?? data.name ?? "unknown";
        broadcast(sessionId, {
          type: "tool_result",
          sessionId,
          name: completedToolName,
          result: typeof result === "string" ? result : JSON.stringify(result),
          callId: event.id,
          parentId: event.parentId ?? undefined,
        });
        // Update process store if tracked — try event.id, parentId, and data.toolCallId
        const completedProc = processStore.get(event.id)
          ?? processStore.get(event.parentId ?? "")
          ?? processStore.get(data.toolCallId ?? "");
        console.log(`[process] COMPLETE id=${event.id} parentId=${event.parentId} toolCallId=${data.toolCallId} found=${!!completedProc} storeKeys=[${[...processStore.keys()].join(",")}]`);
        if (completedProc) {
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          // Detached/async processes: the tool call completes but the process keeps running
          const isBackgroundLaunch = /started in detached background|started in background|command started.*shellId/i.test(resultStr);
          if (isBackgroundLaunch) {
            console.log(`[process] ${completedProc.id} is a background/detached process — marking as detached`);
            completedProc.status = "detached";
            completedProc.result = completedProc.output.length > 0
              ? completedProc.output.join("")
              : resultStr.slice(0, 50000);
            broadcastToAll({ type: "process_update", process: completedProc });
          } else {
            completedProc.status = "done";
            completedProc.completedAt = new Date().toISOString();
            completedProc.result = completedProc.output.length > 0
              ? completedProc.output.join("")
              : resultStr.slice(0, 50000);
            broadcastToAll({ type: "process_update", process: completedProc });
          }
        }
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
      case "tool.execution_partial_result": {
        const partialOutput = data.partialOutput ?? "";
        broadcast(sessionId, {
          type: "tool_partial",
          sessionId,
          callId: data.toolCallId ?? event.id,
          output: partialOutput,
        });
        // Append to process output if tracked
        const partialKey = data.toolCallId ?? event.id;
        const partialProc = processStore.get(partialKey);
        console.log(`[process] PARTIAL key=${partialKey} found=${!!partialProc} storeKeys=[${[...processStore.keys()].join(",")}]`);
        if (partialProc && partialOutput) {
          partialProc.output.push(typeof partialOutput === "string" ? partialOutput : JSON.stringify(partialOutput));
          if (partialProc.output.length > 5000) {
            partialProc.output = partialProc.output.slice(-4000);
          }
        }
        break;
      }

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

          // Load snapshot system message if creating from a snapshot
          let systemMessage: string | undefined;
          if (msg.snapshotId) {
            const snaps = loadSnapshots();
            const snap = snaps.find(s => s.id === msg.snapshotId);
            if (snap) {
              systemMessage = snap.systemMessage;
              console.log(`[session] using snapshot "${snap.name}" (${snap.id})`);
            }
          }

          console.log(`[session] creating: model=${model} cwd=${cwd}${msg.reasoningEffort ? ` reasoning=${msg.reasoningEffort}` : ""}${systemMessage ? " (from snapshot)" : ""}`);
          const session = await copilot.createSession({
            model,
            streaming: true,
            workingDirectory: cwd,
            onPermissionRequest: approveAll,
            onUserInputRequest: createUserInputHandler(msg.sessionId || "pending"),
            onElicitationRequest: createElicitationHandler(msg.sessionId || "pending"),
            ...(mcpServers ? { mcpServers } : {}),
            ...(msg.reasoningEffort ? { reasoningEffort: msg.reasoningEffort } : {}),
            ...(systemMessage ? { systemMessage: { mode: "append" as const, content: systemMessage } } : {}),
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

          const isLoopMode = !!msg.loopMode;
          let prompt = msg.content;

          if (isLoopMode) {
            prompt = msg.content + LOOP_INSTRUCTION;
            const loopState: LoopState = {
              active: true,
              iteration: 1,
              throttleDelay: LOOP_INITIAL_DELAY,
              sessionId: msg.sessionId,
            };
            activeLoops.set(msg.sessionId, loopState);
            broadcast(msg.sessionId, {
              type: "loop_started",
              sessionId: msg.sessionId,
              iteration: 1,
            });
            console.log(`[loop] started for session ${msg.sessionId.substring(0, 8)}`);
          }

          console.log(`[message] → ${msg.sessionId.substring(0, 8)}: ${msg.content.substring(0, 80)}...${isLoopMode ? " [LOOP]" : ""}`);

          // Broadcast the user message to all OTHER clients watching this session
          broadcast(msg.sessionId, {
            type: "user_message",
            sessionId: msg.sessionId,
            content: msg.content,
          }, ws); // exclude sender — they already rendered it locally

          // sendAndWait blocks until the turn completes and returns the final message.
          // The session.on() listener does NOT receive assistant.message/turn_start/turn_end
          // in current SDK versions — so we rely on the return value for the response.
          let lastContent = "";
          try {
            const result = await session.sendAndWait(
              { prompt },
              3_600_000, // 1 hour timeout
            );

            const resultData = result?.data as any;
            const content = resultData?.content ?? "";
            console.log(`[message] ← sendAndWait resolved, type: ${result?.type}, length: ${content.length}`);

            // Incrementally update search index
            updateSearchIndexForSession(msg.sessionId, msg.content, content);

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

            // ── Loop mode continuation ──
            const loopState = activeLoops.get(msg.sessionId);
            if (loopState?.active) {
              lastContent = content || "";

              // Loop until agent signals done/blocked, or loop is aborted
              while (loopState.active && activeLoops.has(msg.sessionId)) {
                const loopStatus = parseLoopStatus(lastContent);
                if (loopStatus) {
                  console.log(`[loop] ended: status=${loopStatus.status} reason=${loopStatus.reason ?? "none"} iterations=${loopState.iteration}`);
                  activeLoops.delete(msg.sessionId);
                  broadcast(msg.sessionId, {
                    type: "loop_ended",
                    sessionId: msg.sessionId,
                    status: loopStatus.status,
                    reason: loopStatus.reason ?? "",
                    iterations: loopState.iteration,
                  });
                  break;
                }

                // No status — continue after throttle delay
                loopState.iteration++;
                console.log(`[loop] iteration ${loopState.iteration}, delay=${loopState.throttleDelay}ms`);

                broadcast(msg.sessionId, {
                  type: "loop_iteration",
                  sessionId: msg.sessionId,
                  iteration: loopState.iteration,
                  delay: loopState.throttleDelay,
                });

                const delayMs = loopState.throttleDelay;
                loopState.throttleDelay = Math.min(loopState.throttleDelay * 2, LOOP_MAX_DELAY);

                await new Promise(res => setTimeout(res, delayMs));

                if (!loopState.active || !activeLoops.has(msg.sessionId)) {
                  console.log(`[loop] aborted during delay`);
                  break;
                }

                // Send continuation prompt
                broadcast(msg.sessionId, {
                  type: "user_message",
                  sessionId: msg.sessionId,
                  content: "[Loop continuation]",
                });

                try {
                  const contResult = await session.sendAndWait(
                    { prompt: LOOP_CONTINUATION },
                    3_600_000,
                  );
                  const contData = contResult?.data as any;
                  lastContent = contData?.content ?? "";

                  const contEvH = turnDeliveredByEvents.get(msg.sessionId) ?? false;
                  turnDeliveredByEvents.set(msg.sessionId, false);

                  if (!contEvH && lastContent) {
                    broadcast(msg.sessionId, {
                      type: "assistant_message",
                      sessionId: msg.sessionId,
                      content: lastContent,
                    });
                    broadcast(msg.sessionId, { type: "done", sessionId: msg.sessionId });
                  }
                } catch (loopErr: any) {
                  console.error(`[loop] continuation error:`, loopErr.message);
                  activeLoops.delete(msg.sessionId);
                  broadcast(msg.sessionId, {
                    type: "loop_ended",
                    sessionId: msg.sessionId,
                    status: "error",
                    reason: loopErr.message,
                    iterations: loopState.iteration,
                  });
                  break;
                }
              }
            }
          } catch (sendErr: any) {
            console.error(`[message] sendAndWait error:`, sendErr);
            const errMsg = sendErr?.message ?? String(sendErr);

            // If CLI lost the session, clear stale state and auto-retry resume + send
            if (errMsg.includes("Session not found") || errMsg.includes("session not found")) {
              console.log(`[message] session lost in CLI — attempting re-resume...`);
              activeSessions.delete(msg.sessionId);
              boundSessionIds.delete(msg.sessionId);
              try {
                const reSession = await copilot.resumeSession(msg.sessionId, {
                  streaming: true,
                  onPermissionRequest: approveAll,
                  onUserInputRequest: createUserInputHandler(msg.sessionId),
                  onElicitationRequest: createElicitationHandler(msg.sessionId),
                  ...(mcpServers ? { mcpServers } : {}),
                });
                activeSessions.set(msg.sessionId, reSession);
                bindSessionEvents(reSession, msg.sessionId);
                console.log(`[message] re-resumed, retrying send...`);

                const retryResult = await reSession.sendAndWait(
                  { prompt },
                  3_600_000,
                );
                const retryData = retryResult?.data as any;
                const retryContent = retryData?.content ?? "";
                const evH = turnDeliveredByEvents.get(msg.sessionId) ?? false;
                turnDeliveredByEvents.set(msg.sessionId, false);
                if (!evH && retryContent) {
                  broadcast(msg.sessionId, { type: "assistant_message", sessionId: msg.sessionId, content: retryContent });
                  broadcast(msg.sessionId, { type: "done", sessionId: msg.sessionId });
                }

                // If loop mode, continue the loop after successful re-resume
                const loopStateAfterResume = activeLoops.get(msg.sessionId);
                if (loopStateAfterResume?.active) {
                  lastContent = retryContent;
                  // Fall through — but we can't re-enter the while loop from here,
                  // so run the loop inline
                  while (loopStateAfterResume.active && activeLoops.has(msg.sessionId)) {
                    const loopStatus = parseLoopStatus(lastContent);
                    if (loopStatus) {
                      console.log(`[loop] ended: status=${loopStatus.status} reason=${loopStatus.reason ?? "none"} iterations=${loopStateAfterResume.iteration}`);
                      activeLoops.delete(msg.sessionId);
                      broadcast(msg.sessionId, {
                        type: "loop_ended",
                        sessionId: msg.sessionId,
                        status: loopStatus.status,
                        reason: loopStatus.reason ?? "",
                        iterations: loopStateAfterResume.iteration,
                      });
                      break;
                    }

                    loopStateAfterResume.iteration++;
                    console.log(`[loop] iteration ${loopStateAfterResume.iteration} (after re-resume)`);
                    broadcast(msg.sessionId, {
                      type: "loop_iteration",
                      sessionId: msg.sessionId,
                      iteration: loopStateAfterResume.iteration,
                      delay: loopStateAfterResume.throttleDelay,
                    });
                    const delayMs = loopStateAfterResume.throttleDelay;
                    loopStateAfterResume.throttleDelay = Math.min(loopStateAfterResume.throttleDelay * 2, LOOP_MAX_DELAY);

                    await new Promise(res => setTimeout(res, delayMs));
                    if (!loopStateAfterResume.active || !activeLoops.has(msg.sessionId)) break;

                    broadcast(msg.sessionId, { type: "user_message", sessionId: msg.sessionId, content: "[Loop continuation]" });
                    try {
                      const contResult = await reSession.sendAndWait({ prompt: LOOP_CONTINUATION }, 3_600_000);
                      const contData = contResult?.data as any;
                      lastContent = contData?.content ?? "";
                      const contEvH = turnDeliveredByEvents.get(msg.sessionId) ?? false;
                      turnDeliveredByEvents.set(msg.sessionId, false);
                      if (!contEvH && lastContent) {
                        broadcast(msg.sessionId, { type: "assistant_message", sessionId: msg.sessionId, content: lastContent });
                        broadcast(msg.sessionId, { type: "done", sessionId: msg.sessionId });
                      }
                    } catch (loopErr: any) {
                      console.error(`[loop] continuation error after re-resume:`, loopErr.message);
                      activeLoops.delete(msg.sessionId);
                      broadcast(msg.sessionId, { type: "loop_ended", sessionId: msg.sessionId, status: "error", reason: loopErr.message, iterations: loopStateAfterResume.iteration });
                      break;
                    }
                  }
                }
                break;
              } catch (retryErr: any) {
                console.error(`[message] re-resume failed:`, retryErr);
                // If loop was active, end it
                if (activeLoops.has(msg.sessionId)) {
                  const ls = activeLoops.get(msg.sessionId)!;
                  activeLoops.delete(msg.sessionId);
                  broadcast(msg.sessionId, { type: "loop_ended", sessionId: msg.sessionId, status: "error", reason: retryErr?.message ?? String(retryErr), iterations: ls.iteration });
                }
                send(ws, {
                  type: "error",
                  sessionId: msg.sessionId,
                  message: `Session lost and could not recover: ${retryErr?.message ?? retryErr}`,
                });
                break;
              }
            }

            // Non-recoverable error — end loop if active
            if (activeLoops.has(msg.sessionId)) {
              const ls = activeLoops.get(msg.sessionId)!;
              activeLoops.delete(msg.sessionId);
              broadcast(msg.sessionId, { type: "loop_ended", sessionId: msg.sessionId, status: "error", reason: errMsg, iterations: ls.iteration });
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
              cwd: meta?.cwd ?? s.context?.cwd ?? "",
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

        // ── List tracked processes ──
        case "list_processes": {
          // Deduplicate since processes may be stored under multiple keys
          const seen = new Set<string>();
          const processes: TrackedProcess[] = [];
          for (const proc of processStore.values()) {
            if (!seen.has(proc.id)) {
              seen.add(proc.id);
              processes.push(proc);
            }
          }
          processes.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
          send(ws, { type: "process_list", processes });
          break;
        }

        // ── Resume an existing session ──
        case "resume_session": {
          const sessionId = msg.sessionId;
          console.log(`[session] resuming: ${sessionId}`);

          // If already active in memory, just subscribe and replay buffered events
          let session = activeSessions.get(sessionId);
          const wasAlreadyActive = !!session;

          if (!session) {
            // Resume via SDK — this reconnects to the CLI's persisted session
            try {
              session = await copilot.resumeSession(sessionId, {
                streaming: true,
                onPermissionRequest: approveAll,
                onUserInputRequest: createUserInputHandler(sessionId),
                onElicitationRequest: createElicitationHandler(sessionId),
                ...(mcpServers ? { mcpServers } : {}),
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

          // Always fetch full history from SDK (buffer may be truncated).
          // Fall back to buffer replay only if getMessages() fails.
          {
            const fetchHistory = async (): Promise<boolean> => {
              const maxAttempts = 4;
              const retryDelayMs = 800;
              const indexFromHistory = (history: any[]) => {
                // Update search index with full message history
                const entry: SearchIndexEntry = {
                  title: sessionMeta.get(sessionId)?.name ?? "Session",
                  model: sessionMeta.get(sessionId)?.model ?? "",
                  cwd: sessionMeta.get(sessionId)?.cwd ?? "",
                  updatedAt: new Date().toISOString(),
                  messages: history
                    .filter((m: any) => (m.role === "user" || m.role === "assistant") && m.content)
                    .map((m: any) => ({ role: m.role, content: String(m.content).substring(0, 2000) })),
                };
                if (entry.messages.length > 0) {
                  searchIndex.set(sessionId, entry);
                  scheduleIndexSave();
                }
              };
              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                  const events = await session!.getMessages();
                  const history = eventsToHistory(events);
                  sessionHistoryCache.set(sessionId, history);
                  const page = history.slice(-HISTORY_PAGE_SIZE);
                  const hasMore = history.length > HISTORY_PAGE_SIZE;
                  send(ws, { type: "session_history", sessionId, messages: page, hasMore, totalMessages: history.length });
                  seedBufferFromHistory(sessionId, history);
                  indexFromHistory(history);
                  return true;
                } catch (e: any) {
                  const isNotFound = e.message?.includes("Session not found") || e.message?.includes("session not found");
                  if (isNotFound && attempt < maxAttempts) {
                    console.warn(`[session] getMessages attempt ${attempt} failed ("Session not found"), retrying in ${retryDelayMs}ms...`);
                    await new Promise(res => setTimeout(res, retryDelayMs));
                  } else if (isNotFound) {
                    console.warn(`[session] getMessages retries exhausted: ${e.message} — trying fresh re-resume...`);
                    try {
                      boundSessionIds.delete(sessionId);
                      const reSession = await copilot.resumeSession(sessionId, {
                        streaming: true,
                        onPermissionRequest: approveAll,
                        onUserInputRequest: createUserInputHandler(sessionId),
                        onElicitationRequest: createElicitationHandler(sessionId),
                        ...(mcpServers ? { mcpServers } : {}),
                      });
                      activeSessions.set(sessionId, reSession);
                      session = reSession;
                      bindSessionEvents(reSession, sessionId);
                      const events2 = await reSession.getMessages();
                      const history2 = eventsToHistory(events2);
                      sessionHistoryCache.set(sessionId, history2);
                      const page2 = history2.slice(-HISTORY_PAGE_SIZE);
                      const hasMore2 = history2.length > HISTORY_PAGE_SIZE;
                      send(ws, { type: "session_history", sessionId, messages: page2, hasMore: hasMore2, totalMessages: history2.length });
                      seedBufferFromHistory(sessionId, history2);
                      indexFromHistory(history2);
                      console.log(`[session] history fetched after fresh re-resume`);
                      return true;
                    } catch (reErr: any) {
                      console.warn(`[session] fresh re-resume getMessages also failed: ${reErr.message}`);
                      return false;
                    }
                  } else {
                    console.warn(`[session] getMessages failed (non-transient): ${e.message}`);
                    return false;
                  }
                }
              }
              return false;
            };

            const gotHistory = await fetchHistory();
            if (!gotHistory && sessionEventBuffers.has(sessionId)) {
              // Fallback: replay whatever we have in the buffer
              const buf = sessionEventBuffers.get(sessionId)!;
              console.log(`[session] falling back to buffer replay: ${buf.length} event(s) for ${sessionId.substring(0, 8)}`);
              const history = bufferToHistory(buf);
              sessionHistoryCache.set(sessionId, history);
              const page = history.slice(-HISTORY_PAGE_SIZE);
              send(ws, { type: "session_history", sessionId, messages: page, hasMore: history.length > HISTORY_PAGE_SIZE, totalMessages: history.length });
            } else if (!gotHistory) {
              send(ws, { type: "session_history", sessionId, messages: [] });
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

          // Re-send any pending prompt (ask_user / elicitation) so the UI can render it
          const pendingPrompt = pendingPrompts.get(sessionId);
          if (pendingPrompt) {
            console.log(`[session] re-sending pending ${pendingPrompt.type} for ${sessionId.substring(0, 8)}`);
            send(ws, pendingPrompt);
          }

          console.log(`[session] resumed: ${sessionId}, cwd=${cwd}, model=${meta?.model}`);
          break;
        }

        // ── Load more history (pagination) ──
        case "load_more_history": {
          const sessionId = msg.sessionId;
          const before = msg.before ?? 0; // number of messages already loaded by client
          const cached = sessionHistoryCache.get(sessionId);
          if (!cached || cached.length === 0) {
            send(ws, { type: "more_history", sessionId, messages: [], hasMore: false });
            break;
          }
          // Client has the last `before` messages; send the preceding page
          const endIdx = Math.max(0, cached.length - before);
          const startIdx = Math.max(0, endIdx - HISTORY_PAGE_SIZE);
          const page = cached.slice(startIdx, endIdx);
          const hasMore = startIdx > 0;
          send(ws, { type: "more_history", sessionId, messages: page, hasMore });
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
          boundSessionIds.delete(sessionId);
          sessionEventBuffers.delete(sessionId);
          sessionHistoryCache.delete(sessionId);
          turnDeliveredByEvents.delete(sessionId);
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
              cwd: meta2?.cwd ?? s.context?.cwd ?? "",
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

        // ── Save snapshot from session ──
        case "save_snapshot": {
          const session = activeSessions.get(msg.sessionId);
          if (!session) {
            send(ws, { type: "error", sessionId: msg.sessionId, message: "Session not active — cannot save snapshot." });
            break;
          }
          try {
            const events = await session.getMessages();
            const history = eventsToHistory(events);
            const systemMessage = historyToSystemMessage(history);
            const meta = sessionMeta.get(msg.sessionId);
            const snap: Snapshot = {
              id: crypto.randomBytes(8).toString("hex"),
              name: msg.name || "Untitled Snapshot",
              description: msg.description || "",
              systemMessage,
              model: meta?.model,
              cwd: meta?.cwd,
              sourceSessionId: msg.sessionId,
              createdAt: new Date().toISOString(),
            };
            saveSnapshot(snap);
            console.log(`[snapshot] saved "${snap.name}" (${snap.id}) from session ${msg.sessionId.substring(0, 8)} — ${systemMessage.length} chars`);
            send(ws, { type: "snapshot_saved", snapshot: { id: snap.id, name: snap.name, description: snap.description, createdAt: snap.createdAt } });
          } catch (e: any) {
            send(ws, { type: "error", sessionId: msg.sessionId, message: `Snapshot failed: ${e.message}` });
          }
          break;
        }

        // -- Abort current turn --
        case "abort": {
          const session = activeSessions.get(msg.sessionId);
          // Stop any active loop first
          const loopToAbort = activeLoops.get(msg.sessionId);
          if (loopToAbort) {
            console.log(`[loop] aborted by user after ${loopToAbort.iteration} iterations`);
            loopToAbort.active = false;
            activeLoops.delete(msg.sessionId);
            broadcast(msg.sessionId, {
              type: "loop_ended",
              sessionId: msg.sessionId,
              status: "aborted",
              reason: "Stopped by user",
              iterations: loopToAbort.iteration,
            });
          }
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
            // Clear the pending prompt for this session
            if (msg.sessionId) pendingPrompts.delete(msg.sessionId);
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
            if (msg.sessionId) pendingPrompts.delete(msg.sessionId);
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
          args: data.arguments ?? data.args ?? data.input ?? {},
          callId: event.id,
          intention: data.intention ?? "",
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

/**
 * Seed the event buffer from CLI history so the fast-path replay
 * includes messages that existed before this server session started.
 * Converts session_history messages into broadcast-format events.
 */
function seedBufferFromHistory(sessionId: string, history: any[]) {
  // Only seed if buffer is empty or doesn't exist yet — don't overwrite live events
  if (sessionEventBuffers.has(sessionId) && sessionEventBuffers.get(sessionId)!.length > 0) return;
  const buf: any[] = [];
  for (const msg of history) {
    switch (msg.role) {
      case "user":
        buf.push({ type: "user_message", sessionId, content: msg.content });
        break;
      case "assistant":
        if (msg.content) {
          buf.push({ type: "assistant_message", sessionId, content: msg.content });
        }
        break;
      case "tool_call":
        buf.push({ type: "tool_start", sessionId, name: msg.name, args: msg.args, callId: msg.callId, intention: msg.intention });
        break;
      case "tool_result":
        buf.push({ type: "tool_result", sessionId, name: msg.name, result: msg.result, callId: msg.callId, parentId: msg.parentId });
        break;
    }
  }
  sessionEventBuffers.set(sessionId, buf);
  console.log(`[session] seeded buffer with ${buf.length} event(s) from CLI history for ${sessionId.substring(0, 8)}`);
}
function bufferToHistory(buffer: any[]): any[] {
  const messages: any[] = [];
  let pendingTokens = "";

  function flushTokens() {
    if (pendingTokens) {
      messages.push({ role: "assistant", content: pendingTokens });
      pendingTokens = "";
    }
  }

  for (const evt of buffer) {
    switch (evt.type) {
      case "user_message":
        flushTokens();
        messages.push({ role: "user", content: evt.content ?? "" });
        break;

      case "assistant_message":
        flushTokens();
        if (evt.content) {
          messages.push({ role: "assistant", content: evt.content });
        }
        break;

      case "token":
        pendingTokens += evt.text ?? "";
        break;

      case "turn_start":
        flushTokens();
        break;

      case "done":
        flushTokens();
        break;

      case "tool_start":
        flushTokens();
        messages.push({
          role: "tool_call",
          name: evt.name ?? "unknown",
          args: evt.args ?? {},
          callId: evt.callId,
          intention: evt.intention ?? "",
        });
        break;

      case "tool_result":
        messages.push({
          role: "tool_result",
          name: evt.name ?? "unknown",
          result: evt.result ?? "",
          callId: evt.callId,
          parentId: evt.parentId,
        });
        break;
    }
  }
  flushTokens();
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

  // Start background search indexing (non-blocking)
  buildSearchIndex().catch(e => console.warn(`[search] background indexing error: ${e.message}`));
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[shutdown] cleaning up...");
  saveSearchIndex();
  saveScriptRuns();
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
