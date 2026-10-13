import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, dirname, delimiter, sep } from "node:path";
import Database from "better-sqlite3";

// Codex desktop "Chats": threads without a project, imported as one synthetic project.
export const PROJECTLESS_ID = "codex:projectless";

export interface SourceProject {
  id: string;
  name: string;
  roots: string[];
  createdAtMs: number;
}

export interface SourceThread {
  id: string;
  title: string;
  fallbackTitle: string;
  cwd: string;
  projectId: string | null;
  archived: boolean;
  archivedAt: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  model: string | null;
  reasoningEffort: string | null;
  source: string;
}

interface ProjectRow {
  id: string;
  name: string;
  created_at_ms: number;
}

interface ThreadRow {
  id: string;
  project_id: string | null;
  title: string;
  name?: string | null;
  cwd: string;
  archived: number;
  archived_at: number | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  recency_at_ms?: number | null;
  created_at: number;
  updated_at: number;
  model: string | null;
  reasoning_effort: string | null;
  source: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function seconds(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function durationMs(value: unknown): number | null {
  const duration = record(value);
  const secs = typeof duration.secs === "number" ? duration.secs : 0;
  const nanos = typeof duration.nanos === "number" ? duration.nanos : 0;
  return secs || nanos ? Math.round(secs * 1000 + nanos / 1_000_000) : null;
}

function rolloutItem(value: unknown): Record<string, unknown> {
  const item = record(value);
  const type = typeof item.type === "string" ? item.type : "Unknown";
  const id = typeof item.id === "string" ? item.id : `${type}-unknown`;
  if (type === "UserMessage") return { type: "userMessage", id, clientId: item.client_id ?? null, content: Array.isArray(item.content) ? item.content : [] };
  if (type === "AgentMessage") return { type: "agentMessage", id, text: item.content ?? "", phase: item.phase ?? null };
  if (type === "Reasoning") return { type: "reasoning", id, summary: Array.isArray(item.summary_text) ? item.summary_text : [], content: Array.isArray(item.raw_content) ? item.raw_content : [] };
  if (type === "Plan") return { type: "plan", id, text: item.text ?? "" };
  if (type === "ContextCompaction") return { type: "contextCompaction", id };
  if (type === "ImageView") return { type: "imageView", id, path: item.path ?? "" };
  if (type === "CommandExecution") {
    const command = Array.isArray(item.command) ? item.command.map(String).join(" ") : item.command ?? "";
    const cwd = typeof item.cwd === "string" && item.cwd.startsWith("file://") ? item.cwd.slice("file://".length) : item.cwd ?? "";
    return { type: "commandExecution", id, command, cwd, status: item.status ?? "completed",
      aggregatedOutput: item.aggregated_output ?? "", exitCode: item.exit_code ?? null, durationMs: durationMs(item.duration) };
  }
  if (type === "FileChange") {
    const changes = Object.entries(record(item.changes)).map(([path, raw]) => {
      const change = record(raw);
      return { path, kind: change.type ?? "update", movePath: change.move_path ?? undefined, diff: change.unified_diff ?? undefined };
    });
    return { type: "fileChange", id, changes, status: item.status ?? "completed" };
  }
  if (type === "McpToolCall") return {
    type: "mcpToolCall", id, server: item.server ?? "mcp", tool: item.tool ?? "unknown",
    arguments: record(item.arguments), status: item.status ?? "completed", result: item.result ?? null,
    ...(item.error == null ? {} : { error: item.error }), durationMs: durationMs(item.duration),
  };
  return { ...item, type: type[0]!.toLowerCase() + type.slice(1), id };
}

export class CodexCatalog {
  readonly db: Database.Database;
  private historyDb: Database.Database | null = null;
  private readonly home: string;

  constructor(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
    this.home = home;
    this.db = new Database(join(home, "state_5.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','project_roots','threads')").all() as { name: string }[];
    if (tables.length !== 3) throw new Error("Unsupported Codex state database");
  }

  close(): void {
    this.historyDb?.close();
    this.db.close();
  }

  projectedThread(threadId: string): unknown {
    const source = this.db.prepare("SELECT rollout_path,created_at FROM threads WHERE id=?").get(threadId) as { rollout_path: string; created_at: number } | undefined;
    if (!source || !existsSync(source.rollout_path)) throw new Error(`Codex source rollout is missing for ${threadId}`);
    const historyPath = join(this.home, "thread_history_1.sqlite");
    if (!existsSync(historyPath)) throw new Error("Codex projected history database is missing");
    const history = this.historyDb ??= new Database(historyPath, { readonly: true, fileMustExist: true });
    const projection = history.prepare("SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?").get(threadId) as { next_rollout_byte_offset: number } | undefined;
    if (!projection || projection.next_rollout_byte_offset < statSync(source.rollout_path).size) throw new Error(`Codex projected history is incomplete for ${threadId}`);
    const rows = history.prepare("SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal").all(threadId) as { turn_id: string; status: string; started_at: number | null; completed_at: number | null }[];
    if (rows.length === 0) throw new Error(`Codex projected history has no turns for ${threadId}`);
    const turns = rows.map((row) => ({ id: row.turn_id, status: row.status, startedAt: row.started_at, completedAt: row.completed_at, items: [] as Record<string, unknown>[] }));
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const items = history.prepare("SELECT turn_id,item_json FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal").all(threadId) as { turn_id: string; item_json: string }[];
    for (const item of items) {
      const turn = byId.get(item.turn_id);
      if (!turn) throw new Error(`Codex projected history has an orphaned item for ${threadId}`);
      turn.items.push(JSON.parse(item.item_json) as Record<string, unknown>);
    }
    return { id: threadId, createdAt: source.created_at, turns };
  }

  async localThread(threadId: string): Promise<unknown> {
    try { return this.projectedThread(threadId); }
    catch (cause) {
      if (!(cause instanceof Error) || ![
        "Codex projected history database is missing",
        "Codex projected history is incomplete",
        "Codex projected history has no turns",
      ].some((message) => cause.message.includes(message))) throw cause;
      return this.rolloutThread(threadId);
    }
  }

  async rolloutThread(threadId: string): Promise<unknown> {
    const source = this.db.prepare("SELECT rollout_path,created_at FROM threads WHERE id=?").get(threadId) as { rollout_path: string; created_at: number } | undefined;
    if (!source || !existsSync(source.rollout_path)) throw new Error(`Codex source rollout is missing for ${threadId}`);
    const initialSize = statSync(source.rollout_path).size;
    const turns: { id: string; status: string; startedAt: number | null; completedAt: number | null; items: Record<string, unknown>[] }[] = [];
    const byId = new Map<string, typeof turns[number]>();
    const itemIds = new Map<string, Set<string>>();
    let lineNumber = 0;
    const at = (value: unknown): number | null => {
      const parsed = typeof value === "string" ? Date.parse(value) / 1000 : Number.NaN;
      return Number.isFinite(parsed) ? parsed : null;
    };
    const ensureTurn = (id: string, startedAt: number | null) => {
      let turn = byId.get(id);
      if (!turn) {
        turn = { id, status: "inProgress", startedAt, completedAt: null, items: [] };
        byId.set(id, turn);
        itemIds.set(id, new Set());
        turns.push(turn);
      } else if (turn.startedAt === null && startedAt !== null) turn.startedAt = startedAt;
      return turn;
    };
    const lines = createInterface({ input: createReadStream(source.rollout_path) });
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try { entry = record(JSON.parse(line)); }
      catch { throw new Error(`Invalid Codex rollout JSON for ${threadId} at line ${lineNumber}`); }
      if (entry.type !== "event_msg") continue;
      const payload = record(entry.payload);
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      if (!turnId) continue;
      const timestamp = at(entry.timestamp);
      if (payload.type === "task_started") {
        ensureTurn(turnId, seconds(payload.started_at, timestamp));
      } else if (payload.type === "item_completed") {
        const startedAt = typeof payload.started_at_ms === "number" ? payload.started_at_ms / 1000 : timestamp;
        const turn = ensureTurn(turnId, startedAt);
        const item = rolloutItem(payload.item);
        const itemId = typeof item.id === "string" ? item.id : null;
        if (!itemId || !itemIds.get(turnId)!.has(itemId)) {
          turn.items.push(item);
          if (itemId) itemIds.get(turnId)!.add(itemId);
        }
      } else if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        const turn = ensureTurn(turnId, seconds(payload.started_at, timestamp));
        turn.status = payload.type === "task_complete" ? "completed" : "interrupted";
        turn.completedAt = seconds(payload.completed_at, timestamp);
      }
    }
    if (statSync(source.rollout_path).size !== initialSize) throw new Error(`Codex source rollout changed while reading ${threadId}`);
    if (turns.length === 0) throw new Error(`Codex source rollout has no turns for ${threadId}`);
    return { id: threadId, createdAt: source.created_at, turns };
  }

  isEmptyPlaceholder(threadId: string): boolean {
    const row = this.db.prepare("SELECT title,rollout_path,has_user_event,tokens_used,first_user_message,preview,created_at,updated_at FROM threads WHERE id=?").get(threadId) as {
      title: string | null; rollout_path: string; has_user_event: number; tokens_used: number;
      first_user_message: string | null; preview: string | null; created_at: number; updated_at: number;
    } | undefined;
    if (!row || row.title || row.has_user_event || row.tokens_used || row.first_user_message || row.preview || row.created_at !== row.updated_at) return false;
    const historyPath = join(this.home, "thread_history_1.sqlite");
    if (!existsSync(historyPath)) return false;
    const history = this.historyDb ??= new Database(historyPath, { readonly: true, fileMustExist: true });
    if (existsSync(row.rollout_path)) {
      const projection = history.prepare("SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?").get(threadId) as { next_rollout_byte_offset: number } | undefined;
      if (!projection || projection.next_rollout_byte_offset < statSync(row.rollout_path).size) return false;
    }
    for (const table of ["thread_turns", "thread_items"] as const) {
      const found = history.prepare(`SELECT 1 FROM ${table} WHERE thread_id=? LIMIT 1`).get(threadId);
      if (found) return false;
    }
    return true;
  }

  projects(): SourceProject[] {
    const rows = this.db.prepare("SELECT id,name,created_at_ms FROM projects ORDER BY position,name").all() as ProjectRow[];
    const roots = this.db.prepare("SELECT path FROM project_roots WHERE project_id=? ORDER BY position");
    const projects = rows.map((row) => ({
      id: row.id,
      name: row.name,
      roots: (roots.all(row.id) as { path: string }[]).map((root) => root.path),
      createdAtMs: row.created_at_ms,
    }));
    const chats = this.projectlessRows();
    if (chats.length === 0) return projects;
    // Chats inside an existing project's folder route to that project; the rest go to Codex's chat folder.
    const owns = (root: string, cwd: string) => cwd === root || cwd.startsWith(root + sep) ||
      (cwd.includes(`${sep}.codex${sep}worktrees${sep}`) && cwd.endsWith(sep + basename(root)));
    const owners = projects.flatMap((project) => project.roots).filter((root) => chats.some((row) => owns(root, row.cwd)));
    return [...projects, { id: PROJECTLESS_ID, name: "Codex chats", roots: [join(homedir(), "Documents", "Codex"), ...new Set(owners)], createdAtMs: 0 }];
  }

  private projectlessRows(): ThreadRow[] {
    const path = join(this.home, ".codex-global-state.json");
    if (!existsSync(path)) return [];
    const ids = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["projectless-thread-ids"];
    if (!Array.isArray(ids)) return [];
    const byId = this.db.prepare("SELECT * FROM threads WHERE id=? AND project_id IS NULL");
    // claude-mem observer sessions are machine-generated, not the user's chats.
    const observer = join(homedir(), ".claude-mem") + sep;
    return ids.flatMap((id) => (typeof id === "string" ? [byId.get(id) as ThreadRow | undefined] : []))
      .filter((row): row is ThreadRow => row !== undefined && !row.cwd.startsWith(observer));
  }

  threads(project: SourceProject): SourceThread[] {
    if (project.roots.length === 0) return [];
    const all = new Map<string, ThreadRow>();
    const byProject = this.db.prepare("SELECT * FROM threads WHERE project_id=?");
    const byRoot = this.db.prepare("SELECT * FROM threads WHERE cwd=?");
    const byWorktree = this.db.prepare("SELECT * FROM threads WHERE cwd LIKE ? ESCAPE '\\'");
    if (project.id === PROJECTLESS_ID) for (const row of this.projectlessRows()) all.set(row.id, row);
    else for (const row of byProject.all(project.id) as ThreadRow[]) all.set(row.id, row);
    if (project.id !== PROJECTLESS_ID) for (const root of project.roots) {
      for (const row of byRoot.all(root) as ThreadRow[]) all.set(row.id, row);
      const basename = root.split(/[\\/]/).filter(Boolean).at(-1);
      if (basename) {
        const escaped = basename.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
        for (const row of byWorktree.all(`%/.codex/worktrees/%/${escaped}`) as ThreadRow[]) all.set(row.id, row);
      }
    }
    return [...all.values()]
      .filter((row) => !["exec", "subagent"].includes(row.source) && !row.source.startsWith("{"))
      .sort((a, b) => (a.created_at_ms ?? a.created_at * 1000) - (b.created_at_ms ?? b.created_at * 1000))
      .map((row) => ({
        id: row.id,
        title: row.name?.trim() || row.title,
        fallbackTitle: row.title,
        cwd: row.cwd,
        projectId: row.project_id,
        archived: row.archived === 1,
        archivedAt: row.archived_at === null ? null : row.archived_at * 1000,
        createdAtMs: row.created_at_ms ?? row.created_at * 1000,
        // Codex bumps updated_at for metadata writes (automations, renames); recency_at is the last real activity.
        updatedAtMs: row.recency_at_ms ?? row.updated_at_ms ?? row.updated_at * 1000,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        source: row.source,
      }));
  }

  owners(thread: SourceThread, projects = this.projects()): SourceProject[] {
    if (thread.projectId) {
      const assigned = projects.find((project) => project.id === thread.projectId);
      if (assigned) return [assigned];
    }
    return projects.filter((project) => project.roots.some((root) => {
      if (thread.cwd === root) return true;
      const basename = root.split(/[\\/]/).filter(Boolean).at(-1);
      return Boolean(basename && thread.cwd.includes("/.codex/worktrees/") && thread.cwd.endsWith(`/${basename}`));
    }));
  }

  async imageDataUrls(threadId: string): Promise<string[]> {
    const row = this.db.prepare("SELECT rollout_path FROM threads WHERE id=?").get(threadId) as { rollout_path: string } | undefined;
    if (!row || !existsSync(row.rollout_path)) return [];
    const images: string[] = [];
    const lines = createInterface({ input: createReadStream(row.rollout_path) });
    for await (const line of lines) {
      if (!line.includes("input_image")) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== "response_item") continue;
      const payload = record.payload;
      if (typeof payload !== "object" || payload === null || !("role" in payload) || payload.role !== "user") continue;
      const content = "content" in payload && Array.isArray(payload.content) ? payload.content : [];
      for (const part of content) {
        if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "input_image") continue;
        if ("image_url" in part && typeof part.image_url === "string" && part.image_url.startsWith("data:image/")) images.push(part.image_url);
      }
    }
    return images;
  }

  async imageDataUrlsByPath(threadId: string): Promise<Map<string, string>> {
    const row = this.db.prepare("SELECT rollout_path FROM threads WHERE id=?").get(threadId) as { rollout_path: string } | undefined;
    const images = new Map<string, string>();
    if (!row || !existsSync(row.rollout_path)) return images;
    const collect = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user" || !("content" in message) || !Array.isArray(message.content)) return;
      let path: string | null = null;
      for (const part of message.content) {
        if (typeof part !== "object" || part === null || !("type" in part)) continue;
        if (part.type === "input_text" && "text" in part && typeof part.text === "string") {
          const matches = [...part.text.matchAll(/<image\b[^>]*\bpath="([^"]+)"/gu)];
          path = matches.length === 1 ? matches[0]![1]! : null;
        } else if (part.type === "input_image") {
          if (path && "image_url" in part && typeof part.image_url === "string" && part.image_url.startsWith("data:image/")) images.set(path, part.image_url);
          path = null;
        }
      }
    };
    const collectLine = (line: string) => {
      if (!line.includes("input_image")) return;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { return; }
      const payload = record.payload;
      if (typeof payload !== "object" || payload === null) return;
      const data = payload as Record<string, unknown>;
      if (record.type === "response_item") collect(data);
      if (record.type === "compacted") for (const key of ["replacement_history", "guardian_history"] as const) {
        if (Array.isArray(data[key])) for (const message of data[key]) collect(message);
      }
    };
    let pending = "";
    for await (const chunk of createReadStream(row.rollout_path, { encoding: "utf8" })) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        collectLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    if (pending) collectLine(pending);
    return images;
  }

  async relatedImageDataUrlsByPath(threadId: string, imagePath: string): Promise<Map<string, string>> {
    const current = this.db.prepare("SELECT cwd FROM threads WHERE id=?").get(threadId) as { cwd: string } | undefined;
    if (!current) return new Map();
    const related = this.db.prepare("SELECT id,rollout_path FROM threads WHERE cwd=? AND id<>?").all(current.cwd, threadId) as { id: string; rollout_path: string }[];
    for (const thread of related) {
      if (!thread.rollout_path || !existsSync(thread.rollout_path)) continue;
      let tail = "";
      let found = false;
      try {
        for await (const chunk of createReadStream(thread.rollout_path, { encoding: "utf8" })) {
          const content = tail + chunk;
          if (content.includes(imagePath)) { found = true; break; }
          tail = content.slice(-imagePath.length + 1);
        }
      } catch { continue; }
      if (!found) continue;
      const images = await this.imageDataUrlsByPath(thread.id);
      if (images.has(imagePath)) return images;
    }
    return new Map();
  }
}

interface RpcPending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

export class CodexAppServer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pending = new Map<number, RpcPending>();
  nextId = 1;
  ready: Promise<void>;
  private closed = false;
  private stderrTail = "";

  constructor() {
    const binary = [
      process.env.CODEX_CLI,
      ...((process.env.PATH ?? "").split(delimiter).map((path) => join(path, "codex"))),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      join(homedir(), ".local", "bin", "codex"),
    ].find((path) => path && existsSync(path));
    if (!binary) throw new Error("Codex CLI was not found; set CODEX_CLI to its absolute path");
    const path = [dirname(binary), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""].join(delimiter);
    this.process = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: path } });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server error"));
      else pending.resolve(message.result);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code) => this.failAll(new Error(`Codex app-server exited (${code}): ${this.stderrTail.trim()}`)));
    this.ready = this.request("initialize", {
      clientInfo: { name: "bb-codex-migrate", title: "BB Codex Migrate", version: "0.3.9" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }).then(() => {
      this.process.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    });
    void this.ready.catch(() => undefined);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out after 60 seconds`));
      }, 60_000);
      this.pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) {
          this.pending.get(id)?.reject(error);
          this.pending.delete(id);
        }
      });
    });
  }

  async readThread(threadId: string): Promise<unknown> {
    await this.ready;
    const response = await this.request("thread/read", { threadId, includeTurns: true });
    if (typeof response !== "object" || response === null || !("thread" in response)) {
      throw new Error(`Invalid Codex thread/read response for ${threadId}`);
    }
    return response.thread;
  }

  close(): void {
    this.closed = true;
    this.process.kill();
    this.failAll(new Error("Codex app-server closed"));
  }
}
