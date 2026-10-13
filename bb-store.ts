import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import Database from "better-sqlite3";
import type { History, ImportEvent } from "./history.js";
import { newId } from "./history.js";
import { formatTitle, type TitleMode } from "./titles.js";
import type { SourceThread } from "./source.js";

interface IdentityRow {
  thread_id: string;
  project_id: string;
  user_messages: number;
  assistant_messages: number;
  archived_at: number | null;
}

export interface ExistingImport {
  threadId: string;
  projectId: string;
  userMessages: number;
  assistantMessages: number;
  archived: boolean;
}

export class BbStore {
  readonly path: string;
  readonly db: Database.Database;

  constructor(dataDir: string, writable = false) {
    this.path = join(dataDir, "bb.db");
    this.db = new Database(this.path, { readonly: !writable, fileMustExist: true, timeout: 30_000 });
    this.db.pragma("busy_timeout = 30000");
    this.assertSchema();
  }

  close(): void {
    this.db.close();
  }

  private assertSchema(): void {
    const required: Record<string, string[]> = {
      threads: ["id", "project_id", "environment_id", "provider_id", "status", "archived_at", "created_at", "updated_at"],
      environments: ["id", "project_id", "host_id", "path", "status", "environment_provider_id", "environment_provider_selection"],
      events: ["id", "thread_id", "environment_id", "scope_kind", "turn_id", "provider_thread_id", "sequence", "type", "data", "created_at"],
      thread_search_segments: ["id", "thread_id", "source_kind", "source_key", "source_seq", "text", "created_at", "updated_at"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const actual = new Set((this.db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name));
      for (const column of columns) if (!actual.has(column)) throw new Error(`Unsupported BB database: ${table}.${column} is missing`);
    }
  }

  existing(sourceId: string): ExistingImport | null {
    const row = this.db.prepare(`
      SELECT e.thread_id,t.project_id,t.archived_at,
        (SELECT COUNT(*) FROM events x WHERE x.thread_id=e.thread_id AND x.type='client/turn/requested') AS user_messages,
        (SELECT COUNT(*) FROM events x WHERE x.thread_id=e.thread_id AND x.type='item/completed' AND x.item_kind='agentMessage') AS assistant_messages
      FROM events e JOIN threads t ON t.id=e.thread_id
      WHERE e.type='thread/identity' AND e.provider_thread_id=? AND t.deleted_at IS NULL
      LIMIT 1
    `).get(sourceId) as IdentityRow | undefined;
    return row ? {
      threadId: row.thread_id,
      projectId: row.project_id,
      userMessages: row.user_messages,
      assistantMessages: row.assistant_messages,
      archived: row.archived_at !== null,
    } : null;
  }

  async backup(dataDir: string): Promise<string> {
    const directory = join(dataDir, "plugins", "codex-migrate", "backups");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `bb-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.sqlite`);
    await this.db.backup(path);
    return path;
  }

  importThread(args: {
    projectId: string;
    hostId: string;
    projectRoot: string;
    source: SourceThread;
    history: History;
    titleMode?: TitleMode;
    titleMaxLength?: number;
  }): string {
    if (this.existing(args.source.id)) throw new Error(`Codex thread ${args.source.id} is already imported`);
    const threadId = newId("thr");
    const sourcePath = args.source.cwd;
    const isWorktreePath = sourcePath.includes("/.codex/worktrees/");
    const worktree = isWorktreePath && existsSync(sourcePath);
    const insideProject = sourcePath === args.projectRoot || sourcePath.startsWith(args.projectRoot + sep);
    const environmentPath = insideProject ? args.projectRoot : existsSync(sourcePath) ? sourcePath : isWorktreePath ? args.projectRoot : sourcePath;
    if (!existsSync(environmentPath)) throw new Error(`Project path does not exist: ${environmentPath}`);
    const now = Date.now();
    // Activity follows the last real message; Codex recency covers chats whose turn times are synthesized.
    const lastActivity = args.history.lastActivityAt ?? args.source.updatedAtMs;
    const write = this.db.transaction(() => {
      let environmentId = (this.db.prepare(
        "SELECT id FROM environments WHERE project_id=? AND host_id=? AND path=? AND status='ready' ORDER BY created_at LIMIT 1",
      ).get(args.projectId, args.hostId, environmentPath) as { id: string } | undefined)?.id;
      if (!environmentId) {
        environmentId = newId("env");
        const selection = JSON.stringify({ machine: { type: "existing", hostId: args.hostId }, inputs: { path: environmentPath } });
        this.db.prepare(`
          INSERT INTO environments(id,project_id,host_id,path,is_git_repo,is_worktree,status,
            environment_provider_id,environment_provider_selection,environment_provider_instance_key,
            provider_owns_path,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(environmentId, args.projectId, args.hostId, environmentPath,
          existsSync(join(environmentPath, ".git")) ? 1 : 0, worktree ? 1 : 0, "ready",
          "project-checkout", selection, threadId, 0, now, now);
      }
      this.db.prepare(`
        INSERT INTO threads(id,project_id,environment_id,provider_id,status,title,archived_at,
          last_read_at,latest_attention_at,created_at,updated_at,visibility)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(threadId, args.projectId, environmentId, "codex", "idle",
        formatTitle(args.source.title, args.titleMode ?? "truncate", args.titleMaxLength ?? 80) || null,
        args.source.archived ? (args.source.archivedAt ?? args.source.updatedAtMs) : null,
        lastActivity, lastActivity,
        args.source.createdAtMs, lastActivity, "visible");
      const insertEvent = this.db.prepare(`
        INSERT INTO events(id,thread_id,environment_id,scope_kind,turn_id,provider_thread_id,
          sequence,type,item_id,item_kind,data,created_at,parent_tool_call_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)
      `);
      const insertSegment = this.db.prepare(`
        INSERT INTO thread_search_segments(id,thread_id,source_kind,source_key,source_seq,text,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
      `);
      const attachmentByPath = this.db.prepare("SELECT id FROM project_attachments WHERE project_id=? AND stored_path=? AND ready_at IS NOT NULL");
      const ownAttachment = this.db.prepare("INSERT OR IGNORE INTO project_attachment_threads(attachment_id,thread_id) VALUES(?,?)");
      const title = args.source.title.trim();
      if (title) insertSegment.run(`${threadId}:title:title`, threadId, "title", "title", null, title, now, now);
      for (const event of args.history.events) {
        insertEvent.run(event.id, threadId, environmentId, event.scopeKind, event.turnId,
          event.providerThreadId, event.sequence, event.type, event.itemId, event.itemKind,
          event.data, event.createdAt);
        const segment = searchSegment(event);
        if (segment) insertSegment.run(`${threadId}:${segment.kind}:event:${event.sequence}`,
          threadId, segment.kind, `event:${event.sequence}`, event.sequence, segment.text,
          event.createdAt, event.createdAt);
        if (event.type === "client/turn/requested") {
          const input = JSON.parse(event.data) as { input?: { type?: string; path?: string }[] };
          for (const part of input.input ?? []) {
            if ((part.type !== "localImage" && part.type !== "localFile") || !part.path) continue;
            const attachment = attachmentByPath.get(args.projectId, part.path) as { id: string } | undefined;
            if (!attachment) throw new Error(`BB attachment missing: ${part.path}`);
            ownAttachment.run(attachment.id, threadId);
          }
        }
      }
    });
    write.immediate();
    return threadId;
  }

  repairImportedThread(source: SourceThread, titleMode: TitleMode, titleMaxLength: number): { events: number; title: boolean } {
    const existing = this.existing(source.id);
    if (!existing) return { events: 0, title: false };
    const rows = this.db.prepare("SELECT id,data FROM events WHERE thread_id=? AND type='item/completed' AND item_kind='toolCall'")
      .all(existing.threadId) as { id: string; data: string }[];
    const fixes = rows.flatMap((row) => {
      const data = JSON.parse(row.data) as { item?: { error?: unknown } };
      if (!data.item || !Object.hasOwn(data.item, "error") || data.item.error !== null) return [];
      delete data.item.error;
      return [{ id: row.id, data: JSON.stringify(data) }];
    });
    const originalTitle = source.title.trim();
    const fallbackTitle = source.fallbackTitle?.trim() ?? originalTitle;
    const nextTitle = formatTitle(source.title, titleMode, titleMaxLength);
    const current = this.db.prepare("SELECT title FROM threads WHERE id=?").get(existing.threadId) as { title: string | null };
    const managedTitle = (current.title === null && !fallbackTitle) || [originalTitle, fallbackTitle].some((candidate) =>
      current.title === candidate || Array.from({ length: 171 }, (_, index) => index + 30)
        .some((length) => current.title === formatTitle(candidate, "truncate", length)));
    const retitle = Boolean(originalTitle && managedTitle && current.title !== nextTitle);
    if (fixes.length || retitle) this.db.transaction(() => {
      const updateEvent = this.db.prepare("UPDATE events SET data=? WHERE id=?");
      for (const fix of fixes) updateEvent.run(fix.data, fix.id);
      if (retitle) {
        this.db.prepare("UPDATE threads SET title=? WHERE id=?").run(nextTitle, existing.threadId);
        this.db.prepare(`INSERT INTO thread_search_segments(id,thread_id,source_kind,source_key,source_seq,text,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at`)
          .run(`${existing.threadId}:title:title`, existing.threadId, "title", "title", null, originalTitle, Date.now(), Date.now());
      }
    }).immediate();
    return { events: fixes.length, title: retitle };
  }
}

function searchSegment(event: ImportEvent): { kind: string; text: string } | null {
  if (event.type !== "client/turn/requested" && event.type !== "item/completed") return null;
  const data = JSON.parse(event.data) as Record<string, unknown>;
  if (event.type === "client/turn/requested") {
    const input = Array.isArray(data.input) ? data.input : [];
    const text = input.map((part) => typeof part === "object" && part !== null && "text" in part ? String(part.text) : "").join("");
    return text ? { kind: "user_message", text } : null;
  }
  const item = typeof data.item === "object" && data.item !== null ? data.item as Record<string, unknown> : {};
  if (item.type !== "agentMessage" && item.type !== "plan") return null;
  const text = typeof item.text === "string" ? item.text : "";
  return text ? { kind: "assistant_message", text } : null;
}
