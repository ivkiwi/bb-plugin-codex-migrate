import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CodexCatalog } from "./.tmp-test/source.js";

test("uses the Codex chat name ahead of the first-message title", () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-titles-"));
  const db = new Database(join(directory, "state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE projects(id TEXT);
      CREATE TABLE project_roots(path TEXT);
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,name TEXT,cwd TEXT,
        archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,
        created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT)`);
    const insert = db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("named", "project", "First user message", "  Useful chat name  ", directory, 0, null, 1000, 2000, 1, 2, null, null, "cli");
    insert.run("unnamed", "project", "Another first message", null, directory, 0, null, 2000, 3000, 2, 3, null, null, "cli");
    insert.run("blank", "project", "Third first message", "   ", directory, 0, null, 3000, 4000, 3, 4, null, null, "cli");
    const catalog = new CodexCatalog(directory);
    try {
      const threads = catalog.threads({ id: "project", name: "Project", roots: [directory], createdAtMs: 0 });
      assert.deepEqual(threads.map(({ title, fallbackTitle }) => ({ title, fallbackTitle })), [
        { title: "Useful chat name", fallbackTitle: "First user message" },
        { title: "Another first message", fallbackTitle: "Another first message" },
        { title: "Third first message", fallbackTitle: "Third first message" },
      ]);
    } finally { catalog.close(); }
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers an attachment by its exact path from a long compacted history line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-images-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  const childRolloutPath = join(directory, "child.jsonl");
  const imageUrl = "data:image/png;base64,aGVsbG8=";
  const db = new Database(join(directory, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE projects(id TEXT); CREATE TABLE project_roots(path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)");
    db.prepare("INSERT INTO threads VALUES(?,?,?)").run("thread_1", rolloutPath, directory);
    db.prepare("INSERT INTO threads VALUES(?,?,?)").run("thread_2", childRolloutPath, directory);
    db.close();
    writeFileSync(childRolloutPath, "");
    writeFileSync(rolloutPath, JSON.stringify({
      type: "compacted",
      payload: {
        replacement_history: [{ role: "user", content: [
          { type: "input_text", text: '<image path="/missing/photo.png">' },
          { type: "input_image", image_url: imageUrl },
        ] }],
        guardian_history: [{ role: "assistant", content: [
          { type: "input_text", text: '<image path="/wrong/photo.png">' },
          { type: "input_image", image_url: imageUrl },
        ] }],
        padding: "x".repeat(11 * 1024 * 1024),
      },
    }) + "\n");
    const catalog = new CodexCatalog(directory);
    try {
      const images = await catalog.imageDataUrlsByPath("thread_1");
      assert.deepEqual([...images], [["/missing/photo.png", imageUrl]]);
      const related = await catalog.relatedImageDataUrlsByPath("thread_2", "/missing/photo.png");
      assert.deepEqual([...related], [["/missing/photo.png", imageUrl]]);
    } finally { catalog.close(); }
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prefers a complete local Codex projection over the raw rollout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-projection-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  writeFileSync(rolloutPath, "{}\n");
  const state = new Database(join(directory, "state_5.sqlite"));
  const history = new Database(join(directory, "thread_history_1.sqlite"));
  try {
    state.exec("CREATE TABLE projects(id TEXT); CREATE TABLE project_roots(path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,created_at INTEGER)");
    state.prepare("INSERT INTO threads VALUES(?,?,?)").run("thread_1", rolloutPath, 123);
    history.exec("CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER); CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_json TEXT,rollout_ordinal INTEGER)");
    history.prepare("INSERT INTO thread_history_projection_state VALUES(?,?)").run("thread_1", statSync(rolloutPath).size);
    history.prepare("INSERT INTO thread_turns VALUES(?,?,?,?,?,?)").run("thread_1", "turn_1", "completed", 124, 125, 1);
    history.prepare("INSERT INTO thread_items VALUES(?,?,?,?)").run("thread_1", "turn_1", JSON.stringify({ type: "userMessage", id: "item_1", content: [{ type: "text", text: "hello" }] }), 2);
    state.close();
    history.close();
    const catalog = new CodexCatalog(directory);
    try {
      assert.deepEqual(await catalog.localThread("thread_1"), { id: "thread_1", createdAt: 123, turns: [
        { id: "turn_1", status: "completed", startedAt: 124, completedAt: 125, items: [{ type: "userMessage", id: "item_1", content: [{ type: "text", text: "hello" }] }] },
      ] });
    } finally { catalog.close(); }
  } finally {
    if (state.open) state.close();
    if (history.open) history.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconstructs paginated turns directly from the complete rollout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-rollout-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  const state = new Database(join(directory, "state_5.sqlite"));
  try {
    state.exec("CREATE TABLE projects(id TEXT); CREATE TABLE project_roots(path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,created_at INTEGER)");
    state.prepare("INSERT INTO threads VALUES(?,?,?)").run("thread_1", rolloutPath, 123);
    state.close();
    const records = [
      { timestamp: "2026-08-25T14:40:49.782Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn_1", started_at: 124 } },
      { timestamp: "2026-08-25T14:40:50.000Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn_1", item: {
        type: "UserMessage", id: "user_1", client_id: "client_1", content: [{ type: "text", text: "hello" }],
      } } },
      { timestamp: "2026-08-25T14:40:51.000Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn_1", item: {
        type: "CommandExecution", id: "command_1", command: ["/bin/zsh", "-lc", "pwd"], cwd: "file:///tmp/project",
        status: "completed", aggregated_output: "/tmp/project\n", exit_code: 0, duration: { secs: 1, nanos: 500_000_000 },
      } } },
      { timestamp: "2026-08-25T14:40:52.000Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn_1", item: {
        type: "AgentMessage", id: "agent_1", content: "done", phase: "final_answer",
      } } },
      { timestamp: "2026-08-25T14:40:53.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn_1", completed_at: 128 } },
    ];
    writeFileSync(rolloutPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const catalog = new CodexCatalog(directory);
    try {
      assert.deepEqual(await catalog.rolloutThread("thread_1"), { id: "thread_1", createdAt: 123, turns: [{
        id: "turn_1", status: "completed", startedAt: 124, completedAt: 128, items: [
          { type: "userMessage", id: "user_1", clientId: "client_1", content: [{ type: "text", text: "hello" }] },
          { type: "commandExecution", id: "command_1", command: "/bin/zsh -lc pwd", cwd: "/tmp/project", status: "completed", aggregatedOutput: "/tmp/project\n", exitCode: 0, durationMs: 1500 },
          { type: "agentMessage", id: "agent_1", text: "done", phase: "final_answer" },
        ],
      }] });
    } finally { catalog.close(); }
  } finally {
    if (state.open) state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips only a verified empty placeholder without a source rollout", () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-placeholder-"));
  const state = new Database(join(directory, "state_5.sqlite"));
  const history = new Database(join(directory, "thread_history_1.sqlite"));
  try {
    state.exec("CREATE TABLE projects(id TEXT); CREATE TABLE project_roots(path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,rollout_path TEXT,has_user_event INTEGER,tokens_used INTEGER,first_user_message TEXT,preview TEXT,created_at INTEGER,updated_at INTEGER)");
    state.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run("thread_1", "", join(directory, "missing.jsonl"), 0, 0, "", "", 123, 123);
    history.exec("CREATE TABLE thread_turns(thread_id TEXT); CREATE TABLE thread_items(thread_id TEXT)");
    history.close();
    const catalog = new CodexCatalog(directory);
    try {
      assert.equal(catalog.isEmptyPlaceholder("thread_1"), true);
      state.prepare("UPDATE threads SET tokens_used=1 WHERE id=?").run("thread_1");
      assert.equal(catalog.isEmptyPlaceholder("thread_1"), false);
    } finally { catalog.close(); }
  } finally {
    if (state.open) state.close();
    if (history.open) history.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips a verified empty placeholder with a fully projected metadata-only rollout", () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-empty-rollout-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  writeFileSync(rolloutPath, JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
  const state = new Database(join(directory, "state_5.sqlite"));
  const history = new Database(join(directory, "thread_history_1.sqlite"));
  try {
    state.exec("CREATE TABLE projects(id TEXT); CREATE TABLE project_roots(path TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,rollout_path TEXT,has_user_event INTEGER,tokens_used INTEGER,first_user_message TEXT,preview TEXT,created_at INTEGER,updated_at INTEGER)");
    state.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run("thread_1", "", rolloutPath, 0, 0, "", "", 123, 123);
    history.exec("CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER); CREATE TABLE thread_turns(thread_id TEXT); CREATE TABLE thread_items(thread_id TEXT)");
    history.prepare("INSERT INTO thread_history_projection_state VALUES(?,?)").run("thread_1", statSync(rolloutPath).size);
    state.close();
    history.close();
    const catalog = new CodexCatalog(directory);
    try { assert.equal(catalog.isEmptyPlaceholder("thread_1"), true); }
    finally { catalog.close(); }
  } finally {
    if (state.open) state.close();
    if (history.open) history.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lists Codex desktop chats without a project as one synthetic project", async () => {
  const { homedir } = await import("node:os");
  const { PROJECTLESS_ID } = await import("./.tmp-test/source.js");
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-projectless-"));
  const db = new Database(join(directory, "state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE projects(id TEXT,name TEXT,position INTEGER,created_at_ms INTEGER);
      CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,name TEXT,cwd TEXT,
        archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,
        created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT)`);
    db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("divoom", "Divoom", 0, 1);
    db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("divoom", 0, "/work/Divoom");
    db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("exact", "Exact", 1, 1);
    db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("exact", 0, "/work/Exact");
    db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("repo", "Repo", 2, 1);
    db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("repo", 0, "/work/Repo");
    const insert = db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,NULL,1000,2000,1,2,NULL,NULL,'vscode')");
    insert.run("chat", null, "Chat", null, join(homedir(), "Documents", "Codex", "2026-06-03", "x"));
    insert.run("nested", null, "Nested", null, "/work/Divoom/timesgate");
    insert.run("observer", null, "Observer", null, join(homedir(), ".claude-mem", "observer-sessions"));
    insert.run("unlisted", null, "Unlisted", null, "/elsewhere");
    insert.run("at-root", null, "At root", null, "/work/Exact");
    insert.run("worktree", null, "Worktree", null, "/home/x/.codex/worktrees/ab12/Repo");
    insert.run("owned", "divoom", "Owned", null, "/work/Divoom");
    db.close();
    writeFileSync(join(directory, ".codex-global-state.json"), JSON.stringify({ "projectless-thread-ids": ["chat", "nested", "observer", "owned", "at-root", "worktree"] }));
    const catalog = new CodexCatalog(directory);
    const projects = catalog.projects();
    const chats = projects.find((project) => project.id === PROJECTLESS_ID);
    const threadsOf = (id) => catalog.threads(projects.find((project) => project.id === id)).map((thread) => thread.id);
    assert.deepEqual(chats.roots, [join(homedir(), "Documents", "Codex")]);
    assert.deepEqual(threadsOf(PROJECTLESS_ID), ["chat"]);
    assert.deepEqual(threadsOf("divoom"), ["nested", "owned"]);
    assert.deepEqual(threadsOf("exact"), ["at-root"]);
    assert.deepEqual(threadsOf("repo"), ["worktree"]);
    catalog.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dates activity by Codex recency, not by metadata updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-recency-"));
  const db = new Database(join(directory, "state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE projects(id TEXT);
      CREATE TABLE project_roots(path TEXT);
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,name TEXT,cwd TEXT,
        archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,recency_at_ms INTEGER,
        created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT)`);
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,NULL,1000,9000,3000,1,9,NULL,NULL,'vscode')").run("touched", "project", "Touched", null, directory);
    db.close();
    const catalog = new CodexCatalog(directory);
    const [thread] = catalog.threads({ id: "project", name: "Project", roots: [directory], createdAtMs: 0 });
    assert.equal(thread.updatedAtMs, 3000);
    catalog.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("no Codex chats project when every chat without a project sits in a project folder", async () => {
  const { PROJECTLESS_ID } = await import("./.tmp-test/source.js");
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-owned-"));
  const db = new Database(join(directory, "state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE projects(id TEXT,name TEXT,position INTEGER,created_at_ms INTEGER);
      CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,name TEXT,cwd TEXT,
        archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,
        created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT)`);
    db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("work", "Work", 0, 1);
    db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("work", 0, "/work");
    db.prepare("INSERT INTO threads VALUES('inside',NULL,'Inside',NULL,'/work/sub',0,NULL,1000,2000,1,2,NULL,NULL,'vscode')").run();
    db.close();
    writeFileSync(join(directory, ".codex-global-state.json"), JSON.stringify({ "projectless-thread-ids": ["inside"] }));
    const catalog = new CodexCatalog(directory);
    assert.equal(catalog.projects().some((project) => project.id === PROJECTLESS_ID), false);
    catalog.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
