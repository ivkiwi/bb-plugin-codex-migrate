import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BbStore } from "./.tmp-test/bb-store.js";

function fixture(withAttachment) {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-migrate-"));
  const db = new Database(join(directory, "bb.db"));
  db.exec(`
    CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,environment_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL,title TEXT,archived_at INTEGER,last_read_at INTEGER,latest_attention_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,visibility TEXT NOT NULL,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,host_id TEXT NOT NULL,path TEXT,status TEXT NOT NULL,is_git_repo INTEGER,is_worktree INTEGER,environment_provider_id TEXT,environment_provider_selection TEXT,environment_provider_instance_key TEXT,provider_owns_path INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,environment_id TEXT,scope_kind TEXT NOT NULL,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER NOT NULL,type TEXT NOT NULL,item_id TEXT,item_kind TEXT,data TEXT NOT NULL,created_at INTEGER NOT NULL,parent_tool_call_id TEXT);
    CREATE TABLE thread_search_segments(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_key TEXT NOT NULL,source_seq INTEGER,text TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE project_attachments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,stored_path TEXT NOT NULL,ready_at INTEGER);
    CREATE TABLE project_attachment_threads(attachment_id TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(attachment_id,thread_id));
  `);
  if (withAttachment) db.prepare("INSERT INTO project_attachments VALUES(?,?,?,?)").run("att_1", "proj_test", "image.png", 1);
  db.close();
  const source = {
    id: "codex_thread", title: "Test chat", cwd: directory, archived: true,
    archivedAt: 1000, createdAtMs: 100, updatedAtMs: 200,
    model: "gpt-6", reasoningEffort: "medium", source: "vscode",
  };
  const history = {
    userMessages: 1, assistantMessages: 0, images: 1, lastActivityAt: 110,
    events: [
      { id: "evt_1", sequence: 1, scopeKind: "thread", turnId: null, providerThreadId: "codex_thread", type: "thread/identity", itemId: null, itemKind: null, data: JSON.stringify({ providerThreadId: "codex_thread" }), createdAt: 100 },
      { id: "evt_2", sequence: 2, scopeKind: "thread", turnId: null, providerThreadId: null, type: "client/turn/requested", itemId: null, itemKind: null, data: JSON.stringify({ input: [{ type: "localImage", path: "image.png" }] }), createdAt: 110 },
    ],
  };
  return { directory, source, history };
}

test("import preserves identity, archive state, attachment ownership and idempotence", () => {
  const { directory, source, history } = fixture(true);
  const store = new BbStore(directory, true);
  try {
    const args = { projectId: "proj_test", hostId: "host_test", projectRoot: directory, source, history };
    const threadId = store.importThread(args);
    assert.deepEqual(store.existing(source.id), { threadId, projectId: "proj_test", archived: true, userMessages: 1, assistantMessages: 0 });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM project_attachment_threads WHERE thread_id=?").get(threadId).n, 1);
    assert.deepEqual({ ...store.db.prepare("SELECT latest_attention_at AS attention, updated_at AS updated FROM threads WHERE id=?").get(threadId) }, { attention: 110, updated: 110 });
    assert.throws(() => store.importThread(args), /already imported/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM threads").get().n, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("missing attachment rolls back the whole chat", () => {
  const { directory, source, history } = fixture(false);
  const store = new BbStore(directory, true);
  try {
    assert.throws(() => store.importThread({ projectId: "proj_test", hostId: "host_test", projectRoot: directory, source, history }), /attachment missing/);
    for (const table of ["threads", "environments", "events"]) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("chat environment follows its own directory in a multi-root Codex project", () => {
  const { directory, source, history } = fixture(true);
  const second = join(directory, "second-root");
  mkdirSync(second);
  source.cwd = second;
  const store = new BbStore(directory, true);
  try {
    const threadId = store.importThread({ projectId: "proj_test", hostId: "host_test", projectRoot: second, source, history });
    const environment = store.db.prepare("SELECT e.path FROM environments e JOIN threads t ON t.environment_id=e.id WHERE t.id=?").get(threadId);
    assert.equal(environment.path, second);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("repair removes invalid null errors and shortens only untouched imported titles", () => {
  const { directory, source, history } = fixture(true);
  source.title = "A long Codex chat title that should become a short BB title after repair";
  history.events.push({ id: "evt_3", sequence: 3, scopeKind: "turn", turnId: "turn_1", providerThreadId: "codex_thread",
    type: "item/completed", itemId: "tool_1", itemKind: "toolCall", data: JSON.stringify({ item: { type: "toolCall", id: "tool_1", error: null } }), createdAt: 120 });
  const store = new BbStore(directory, true);
  try {
    const threadId = store.importThread({ projectId: "proj_test", hostId: "host_test", projectRoot: directory, source, history, titleMode: "original" });
    assert.deepEqual(store.repairImportedThread(source, "truncate", 40), { events: 1, title: true });
    assert.deepEqual(store.repairImportedThread(source, "truncate", 40), { events: 0, title: false });
    assert.deepEqual(store.repairImportedThread(source, "truncate", 50), { events: 0, title: true });
    assert.deepEqual(store.repairImportedThread(source, "original", 50), { events: 0, title: true });
    assert.deepEqual(store.repairImportedThread(source, "truncate", 40), { events: 0, title: true });
    const event = store.db.prepare("SELECT data FROM events WHERE id='evt_3'").get();
    assert.equal(Object.hasOwn(JSON.parse(event.data).item, "error"), false);
    const title = store.db.prepare("SELECT title FROM threads WHERE id=?").get(threadId).title;
    assert.ok(title.length <= 40);
    const segment = store.db.prepare("SELECT text FROM thread_search_segments WHERE thread_id=? AND source_kind='title'").get(threadId);
    assert.equal(segment.text, source.title);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("repair replaces a previously imported first-message title with the Codex name", () => {
  const { directory, source, history } = fixture(true);
  const firstMessage = "First user message with a very long title that was imported before names were read";
  source.title = firstMessage;
  source.fallbackTitle = firstMessage;
  const store = new BbStore(directory, true);
  try {
    const threadId = store.importThread({ projectId: "proj_test", hostId: "host_test", projectRoot: directory,
      source, history, titleMaxLength: 40 });
    source.title = "Proper Codex chat name";
    assert.deepEqual(store.repairImportedThread(source, "truncate", 40), { events: 0, title: true });
    assert.equal(store.db.prepare("SELECT title FROM threads WHERE id=?").get(threadId).title, source.title);
    assert.equal(store.db.prepare("SELECT text FROM thread_search_segments WHERE thread_id=? AND source_kind='title'").get(threadId).text, source.title);
    assert.deepEqual(store.repairImportedThread(source, "truncate", 40), { events: 0, title: false });
    store.db.prepare("UPDATE threads SET title=? WHERE id=?").run("My manual BB title", threadId);
    assert.deepEqual(store.repairImportedThread(source, "truncate", 40), { events: 0, title: false });
    assert.equal(store.db.prepare("SELECT title FROM threads WHERE id=?").get(threadId).title, "My manual BB title");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("repair fills an empty imported title when Codex has a chat name", () => {
  const { directory, source, history } = fixture(true);
  source.title = "";
  source.fallbackTitle = "";
  const store = new BbStore(directory, true);
  try {
    const threadId = store.importThread({ projectId: "proj_test", hostId: "host_test", projectRoot: directory, source, history });
    source.title = "Named in Codex";
    assert.deepEqual(store.repairImportedThread(source, "truncate", 80), { events: 0, title: true });
    assert.equal(store.db.prepare("SELECT title FROM threads WHERE id=?").get(threadId).title, source.title);
    assert.equal(store.db.prepare("SELECT text FROM thread_search_segments WHERE thread_id=? AND source_kind='title'").get(threadId).text, source.title);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
