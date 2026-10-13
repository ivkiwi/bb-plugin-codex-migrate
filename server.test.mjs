import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./.tmp-test/server.js";

test("explicit project selection creates a new BB project; omission imports nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-selection-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const root = join(directory, "repository");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(codexHome);
  mkdirSync(bbHome);
  mkdirSync(root);
  const source = new Database(join(codexHome, "state_5.sqlite"));
  source.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
    CREATE TABLE threads(project_id TEXT,cwd TEXT);
  `);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_project", "Fixture Project", 0, 100);
  source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_project", 0, root);
  source.close();
  const target = new Database(join(bbHome, "bb.db"));
  target.exec(`
    CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
    CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  target.close();
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const created = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "codex-migrate",
    dataDir: bbHome,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_test" }) },
      projects: {
        list: async () => [],
        create: async (input) => {
          created.push(input);
          return { id: "proj_fixture", name: input.name, sources: [{ id: "source_fixture", hostId: input.source.hostId, path: input.source.path, isDefault: true }] };
        },
      },
    },
  });
  try {
    await plugin(bb);
    const missing = await harness.behavior.runCli(["apply", "--json"]);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /Select a project/);
    assert.equal(created.length, 0);
    const unselectedRepair = await harness.behavior.runCli(["repair", "--json"]);
    assert.equal(unselectedRepair.exitCode, 1);
    assert.match(unselectedRepair.stderr, /Select a project or folder explicitly/);
    const plain = await harness.behavior.runCli(["apply", "--project", "Fixture Project", "--json"]);
    assert.equal(plain.exitCode, 0);
    assert.equal(created.length, 1);
    assert.equal(existsSync(join(root, ".git")), false);
    const selected = await harness.behavior.runCli(["apply", "--project", "Fixture Project", "--init-git", "--json"]);
    assert.equal(selected.exitCode, 0);
    assert.equal(existsSync(join(root, ".git")), true);
    assert.equal(created.length, 2);
    assert.equal(created[1].name, "Fixture Project");
    assert.equal(JSON.parse(selected.stdout).projects[0].targetProjectId, "proj_fixture");
    const beforeReload = await harness.behavior.callRpc("status", null);
    assert.equal(beforeReload.current.state, "completed");
    assert.equal(beforeReload.current.total, 0);
    assert.deepEqual(beforeReload.current.projectProgress.map((project) => [project.sourceId, project.state, project.processed, project.total]), [[realpathSync(root), "completed", 0, 0]]);
    const legacy = { ...beforeReload.current };
    delete legacy.projectProgress;
    await bb.storage.kv.set("current-run", legacy);
    const reloaded = await harness.lifecycle.reload(plugin);
    const afterReload = await reloaded.harness.behavior.callRpc("status", null);
    assert.equal(afterReload.current.runId, beforeReload.current.runId);
    assert.equal(afterReload.current.state, "completed");
    assert.deepEqual(afterReload.current.projectProgress.map((project) => [project.sourceId, project.state]), [[realpathSync(root), "completed"]]);
    await reloaded.harness.lifecycle.dispose();
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared Codex root is one selected folder and is imported once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-overlap-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const root = join(directory, "repository");
  const { mkdirSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, root]) mkdirSync(path);
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  const source = new Database(join(codexHome, "state_5.sqlite"));
  source.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
    CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,cwd TEXT,archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT);
  `);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_a", "Alpha", 0, 100);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_b", "Beta", 1, 100);
  for (const id of ["src_a", "src_b"]) source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run(id, 0, root);
  source.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("chat_1", null, "Shared chat", root, 0, null, 100, 200, 1, 2, null, null, "vscode");
  source.close();
  const target = new Database(join(bbHome, "bb.db"));
  target.exec(`
    CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
    CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  target.close();
  const prior = process.env.CODEX_HOME;
  const priorCli = process.env.CODEX_CLI;
  process.env.CODEX_HOME = codexHome;
  const mockCli = join(directory, "mock-codex");
  writeFileSync(mockCli, `#!/usr/bin/env node
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    const request = JSON.parse(line);
    if (typeof request.id !== "number") continue;
    const result = request.method === "thread/read" ? { thread: { id: request.params.threadId, turns: [] } } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
`);
  chmodSync(mockCli, 0o755);
  process.env.CODEX_CLI = mockCli;
  let writes = 0;
  const targetProjects = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "codex-migrate", dataDir: bbHome,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_test" }) },
      projects: { list: async () => targetProjects, create: async (input) => {
        writes++;
        const target = { id: "proj_alpha", name: input.name, sources: [{ id: "source_alpha", hostId: input.source.hostId, path: input.source.path, isDefault: true }] };
        targetProjects.push(target);
        return target;
      } },
    },
  });
  try {
    await plugin(bb);
    const scan = await harness.behavior.callRpc("scan", { projects: ["src_a"], all: false, includeThreads: true });
    assert.equal(scan.projects[0].conflicts.length, 0);
    assert.deepEqual(scan.projects[0].rootDetails[0].linkedProjects, ["Alpha", "Beta"]);
    const selected = await harness.behavior.runCli(["apply", "--project", "src_a", "--json"]);
    assert.equal(selected.exitCode, 0);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(selected.stdout).projects[0].skippedEmpty, 1);
    const shared = await harness.behavior.runCli(["apply", "--all", "--json"]);
    assert.equal(shared.exitCode, 0);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(shared.stdout).projects.length, 1);
    const status = await harness.behavior.callRpc("status", null);
    assert.deepEqual(status.current.projectProgress.map((project) => [project.sourceId, project.state, project.processed, project.total]), [[realpathSync(root), "completed", 1, 1]]);
    await harness.lifecycle.dispose();
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    if (priorCli === undefined) delete process.env.CODEX_CLI;
    else process.env.CODEX_CLI = priorCli;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("multi-root project creates one BB project per directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-multiroot-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const roots = [join(directory, "root-one"), join(directory, "root-two")];
  const { mkdirSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, ...roots]) mkdirSync(path);
  for (const root of roots) execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  const source = new Database(join(codexHome, "state_5.sqlite"));
  source.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
    CREATE TABLE threads(project_id TEXT,cwd TEXT);
  `);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_multi", "Multi", 0, 100);
  roots.forEach((root, position) => source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_multi", position, root));
  source.close();
  const target = new Database(join(bbHome, "bb.db"));
  target.exec(`
    CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
    CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  target.close();
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const created = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "codex-migrate", dataDir: bbHome,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_test" }) },
      projects: {
        list: async () => created,
        create: async (input) => {
          const project = { id: `proj_${created.length}`, name: input.name,
            sources: [{ id: `source_${created.length}`, hostId: input.source.hostId, path: input.source.path, isDefault: true }] };
          created.push(project);
          return project;
        },
      },
    },
  });
  try {
    await plugin(bb);
    const preview = await harness.behavior.callRpc("scan", { projects: ["src_multi"], all: false, includeThreads: true });
    assert.deepEqual(preview.projects[0].rootDetails.map((root) => root.targetProjectName), ["root-one", "root-two"]);
    assert.ok(preview.projects[0].rootDetails.every((root) => root.git === true));
    const oneFolder = await harness.behavior.callRpc("scan", { projects: [], roots: [roots[1]], all: false, includeThreads: true });
    assert.deepEqual(oneFolder.projects[0].rootDetails.map((root) => root.path), [roots[1]]);
    const selectedFolder = await harness.behavior.runCli(["apply", "--folder", roots[1], "--json"]);
    assert.equal(selectedFolder.exitCode, 0);
    assert.deepEqual(created.map((project) => project.sources[0].path), [realpathSync(roots[1])]);
    const result = await harness.behavior.runCli(["apply", "--project", "src_multi", "--json"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(created.map((project) => project.sources[0].path), [realpathSync(roots[1]), realpathSync(roots[0])]);
    assert.deepEqual(JSON.parse(result.stdout).projects.map((project) => project.targetProjectId), ["proj_1", "proj_0"]);
    await harness.lifecycle.dispose();
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worktree chats choose the project root from the same Git repository when root basenames collide", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-worktree-root-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const main = join(directory, "api-gateway");
  const otherRepository = join(directory, "helm-onecloud");
  const collidingRoot = join(otherRepository, "releases", "api-gateway");
  const worktree = join(directory, ".codex", "worktrees", "abcd", "api-gateway");
  const { mkdirSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, main, collidingRoot, join(directory, ".codex", "worktrees", "abcd")]) {
    mkdirSync(path, { recursive: true });
  }
  try {
    execFileSync("git", ["-C", main, "init"], { stdio: "ignore" });
    writeFileSync(join(main, "README.md"), "test\n");
    execFileSync("git", ["-C", main, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", main, "worktree", "add", "--detach", worktree], { stdio: "ignore" });
    execFileSync("git", ["-C", otherRepository, "init"], { stdio: "ignore" });

    const source = new Database(join(codexHome, "state_5.sqlite"));
    source.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
      CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,cwd TEXT,archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT);
    `);
    source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_collision", "API-Gateway", 0, 100);
    source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_collision", 0, main);
    source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_collision", 1, collidingRoot);
    source.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("chat_worktree", "src_collision", "Worktree chat", worktree, 0, null, 100, 200, 1, 2, null, null, "vscode");
    source.close();

    const target = new Database(join(bbHome, "bb.db"));
    target.exec(`
      CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
      CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
      CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
      CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
    `);
    target.close();

    const prior = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const { bb, harness } = createFakePluginHost({
      pluginId: "codex-migrate", dataDir: bbHome,
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_test" }) },
        projects: { list: async () => [] },
      },
    });
    try {
      await plugin(bb);
      const preview = await harness.behavior.callRpc("scan", { projects: ["src_collision"], all: false, includeThreads: true });
      assert.equal(preview.projects[0].conflicts.length, 0);
      assert.deepEqual(preview.projects[0].rootDetails.map((root) => root.candidates), [1, 0]);
      await harness.lifecycle.dispose();
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prior;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paginated thread/read errors fall back to the complete rollout when the projection is incomplete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-paginated-fallback-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const root = join(directory, "repository");
  const rolloutPath = join(codexHome, "rollout.jsonl");
  const emptyRolloutPath = join(codexHome, "empty-rollout.jsonl");
  const partialRolloutPath = join(codexHome, "partial-rollout.jsonl");
  const mockCli = join(directory, "mock-codex");
  const { mkdirSync, statSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, root]) mkdirSync(path);
  try {
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
    writeFileSync(rolloutPath, [
      { timestamp: "2026-08-25T14:40:49.782Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn_1", started_at: 1 } },
      { timestamp: "2026-08-25T14:40:50.000Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn_1", item: {
        type: "UserMessage", id: "item_1", client_id: "client_1", content: [{ type: "text", text: "hello" }],
      } } },
      { timestamp: "2026-08-25T14:40:51.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn_1", completed_at: 2 } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(emptyRolloutPath, JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
    writeFileSync(partialRolloutPath, [
      { timestamp: "2026-08-25T14:41:49.782Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn_partial", started_at: 3 } },
      { timestamp: "2026-08-25T14:41:50.000Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn_partial", item: {
        type: "UserMessage", id: "item_partial", client_id: "client_partial", content: [
          { type: "text", text: "inspect this" }, { type: "localImage", path: "/missing/screenshot.png" },
        ],
      } } },
      { timestamp: "2026-08-25T14:41:51.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn_partial", completed_at: 4 } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const source = new Database(join(codexHome, "state_5.sqlite"));
    source.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
      CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,cwd TEXT,archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT,rollout_path TEXT,has_user_event INTEGER DEFAULT 0,tokens_used INTEGER DEFAULT 0,first_user_message TEXT DEFAULT '',preview TEXT DEFAULT '');
    `);
    source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_projection", "Projection", 0, 100);
    source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_projection", 0, root);
    source.prepare("INSERT INTO threads(id,project_id,title,cwd,archived,archived_at,created_at_ms,updated_at_ms,created_at,updated_at,model,reasoning_effort,source,rollout_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("chat_projection", "src_projection", "Projected chat", root, 0, null, 100, 200, 1, 2, null, null, "vscode", rolloutPath);
    source.prepare("INSERT INTO threads(id,project_id,title,cwd,archived,archived_at,created_at_ms,updated_at_ms,created_at,updated_at,model,reasoning_effort,source,rollout_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("chat_empty", "src_projection", "", root, 0, null, 3000, 3000, 3, 3, null, null, "vscode", emptyRolloutPath);
    source.prepare("INSERT INTO threads(id,project_id,title,cwd,archived,archived_at,created_at_ms,updated_at_ms,created_at,updated_at,model,reasoning_effort,source,rollout_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("chat_partial", "src_projection", "Partial chat", root, 0, null, 3000, 4000, 3, 4, null, null, "vscode", partialRolloutPath);
    source.close();

    const projection = new Database(join(codexHome, "thread_history_1.sqlite"));
    projection.exec(`
      CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER);
      CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER);
      CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_json TEXT,rollout_ordinal INTEGER);
    `);
    projection.prepare("INSERT INTO thread_history_projection_state VALUES(?,?)").run("chat_projection", 0);
    projection.prepare("INSERT INTO thread_history_projection_state VALUES(?,?)").run("chat_empty", statSync(emptyRolloutPath).size);
    projection.prepare("INSERT INTO thread_history_projection_state VALUES(?,?)").run("chat_partial", 0);
    projection.close();

    const target = new Database(join(bbHome, "bb.db"));
    target.exec(`
      CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,environment_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL,title TEXT,archived_at INTEGER,last_read_at INTEGER,latest_attention_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,visibility TEXT NOT NULL,deleted_at INTEGER);
      CREATE TABLE environments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,host_id TEXT NOT NULL,path TEXT,status TEXT NOT NULL,is_git_repo INTEGER,is_worktree INTEGER,environment_provider_id TEXT,environment_provider_selection TEXT,environment_provider_instance_key TEXT,provider_owns_path INTEGER,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE events(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,environment_id TEXT,scope_kind TEXT NOT NULL,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER NOT NULL,type TEXT NOT NULL,item_id TEXT,item_kind TEXT,data TEXT NOT NULL,created_at INTEGER NOT NULL,parent_tool_call_id TEXT);
      CREATE TABLE thread_search_segments(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_key TEXT NOT NULL,source_seq INTEGER,text TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE project_attachments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,stored_path TEXT NOT NULL,ready_at INTEGER);
      CREATE TABLE project_attachment_threads(attachment_id TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(attachment_id,thread_id));
    `);
    target.close();

    writeFileSync(mockCli, `#!/usr/bin/env node
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    const request = JSON.parse(line);
    if (typeof request.id !== "number") continue;
    if (request.method === "thread/read") {
      process.stdout.write(JSON.stringify({ id: request.id, error: { message: "paginated threads do not support thread/read(includeTurns=true)" } }) + "\\n");
    } else process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  }
});
`);
    chmodSync(mockCli, 0o755);
    const priorHome = process.env.CODEX_HOME;
    const priorCli = process.env.CODEX_CLI;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_CLI = mockCli;
    const projects = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "codex-migrate", dataDir: bbHome,
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_test" }) },
        projects: {
          list: async () => projects,
          create: async (input) => {
            const created = { id: "proj_projection", name: input.name,
              sources: [{ id: "source_projection", hostId: input.source.hostId, path: input.source.path, isDefault: true }] };
            projects.push(created);
            return created;
          },
        },
      },
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.runCli(["apply", "--project", "src_projection", "--json"]);
      assert.equal(result.exitCode, 0);
      const report = JSON.parse(result.stdout).projects[0];
      assert.deepEqual({ imported: report.imported, partiallyImported: report.partiallyImported, skippedEmpty: report.skippedEmpty, failed: report.failed.length },
        { imported: 1, partiallyImported: [{ sourceId: "chat_partial", message: "Unavailable attachments: chat_partial: localImage /missing/screenshot.png" }], skippedEmpty: 1, failed: 0 });
      const status = await harness.behavior.callRpc("status", null);
      assert.equal(status.current.partiallyImported, 1);
      assert.equal(status.current.projectProgress[0].partiallyImported, 1);
      assert.equal(status.current.projectProgress[0].state, "partial");
      const imported = new Database(join(bbHome, "bb.db"), { readonly: true });
      const partialEvent = imported.prepare(`SELECT data FROM events WHERE type='client/turn/requested' AND data LIKE '%Attachment unavailable:%'`).get();
      imported.close();
      assert.deepEqual(JSON.parse(partialEvent.data).input, [
        { type: "text", text: "inspect this", mentions: [] },
        { type: "text", text: "[Attachment unavailable: /missing/screenshot.png]", mentions: [] },
      ]);
      await harness.lifecycle.dispose();
    } finally {
      if (priorHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorHome;
      if (priorCli === undefined) delete process.env.CODEX_CLI;
      else process.env.CODEX_CLI = priorCli;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing chats in a BB subfolder project block silent rerouting to the parent repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-parent-conflict-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const parent = join(directory, "parent");
  const child = join(parent, "child");
  const { mkdirSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, parent, child]) mkdirSync(path);
  execFileSync("git", ["-C", parent, "init"], { stdio: "ignore" });
  const source = new Database(join(codexHome, "state_5.sqlite"));
  source.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
    CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,cwd TEXT,archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT);
  `);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_child", "Child", 0, 100);
  source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_child", 0, child);
  source.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("chat_child", "src_child", "Existing child chat", child, 0, null, 100, 200, 1, 2, null, null, "vscode");
  source.close();
  const target = new Database(join(bbHome, "bb.db"));
  target.exec(`
    CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
    CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO threads(id,project_id) VALUES('bb_child_chat','bb_child');
    INSERT INTO events(id,thread_id,type,provider_thread_id) VALUES('identity','bb_child_chat','thread/identity','chat_child');
  `);
  target.close();
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const bbProjects = [
    { id: "bb_parent", name: "Parent", sources: [{ id: "parent_source", hostId: "host_test", path: parent, isDefault: true }] },
    { id: "bb_child", name: "Child", sources: [{ id: "child_source", hostId: "host_test", path: child, isDefault: true }] },
  ];
  const { bb, harness } = createFakePluginHost({
    pluginId: "codex-migrate", dataDir: bbHome,
    sdk: { system: { config: async () => ({ primaryHostId: "host_test" }) }, projects: { list: async () => bbProjects } },
  });
  try {
    await plugin(bb);
    const preview = await harness.behavior.callRpc("scan", { projects: ["src_child"], all: false, includeThreads: true });
    assert.equal(preview.projects[0].rootDetails[0].kind, "subfolder");
    assert.equal(preview.projects[0].rootDetails[0].targetProjectId, "bb_parent");
    assert.equal(preview.projects[0].conflicts[0].reason, "Already imported into another BB project");
    const result = await harness.behavior.runCli(["apply", "--project", "src_child"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /already in another BB project/);
    await harness.lifecycle.dispose();
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background migration keeps a readable status after the caller leaves", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-codex-progress-"));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const root = join(directory, "repository");
  const { mkdirSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, root]) mkdirSync(path);
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  const source = new Database(join(codexHome, "state_5.sqlite"));
  source.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
    CREATE TABLE threads(project_id TEXT,cwd TEXT);
  `);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_progress", "Progress", 0, 100);
  source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_progress", 0, root);
  source.close();
  const target = new Database(join(bbHome, "bb.db"));
  target.exec(`
    CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
    CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  target.close();
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let releaseCreate;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const { bb, harness } = createFakePluginHost({
    pluginId: "codex-migrate", dataDir: bbHome,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_test" }) },
      projects: {
        list: async () => [],
        create: async (input) => {
          await gate;
          return { id: "proj_progress", name: input.name, sources: [{ id: "source_progress", hostId: input.source.hostId, path: input.source.path, isDefault: true }] };
        },
      },
    },
  });
  try {
    await plugin(bb);
    const started = await harness.behavior.callRpc("start", { projects: ["src_progress"], all: false, existingOnly: false, limit: null });
    const running = await harness.behavior.callRpc("status", null);
    assert.equal(running.current.runId, started.runId);
    assert.equal(running.current.state, "running");
    assert.ok(["src_progress", realpathSync(root)].includes(running.current.projectProgress[0].sourceId));
    releaseCreate();
    let completed;
    for (let i = 0; i < 30; i++) {
      completed = await harness.behavior.callRpc("status", null);
      if (completed.current.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed.current.state, "completed");
    assert.equal(completed.current.projectProgress[0].state, "completed");
    const reloaded = await harness.lifecycle.reload(plugin);
    const restored = await reloaded.harness.behavior.callRpc("status", null);
    assert.equal(restored.current.runId, started.runId);
    assert.equal(restored.current.state, "completed");
    await reloaded.harness.lifecycle.dispose();
  } finally {
    releaseCreate();
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a plain subfolder chat keeps one destination, and git init cannot absorb a selected folder", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bb-codex-plain-")));
  const codexHome = join(directory, "codex");
  const bbHome = join(directory, "bb");
  const plain = join(directory, "plain");
  const sub = join(plain, "sub");
  const { mkdirSync } = await import("node:fs");
  for (const path of [codexHome, bbHome, plain, sub]) mkdirSync(path);
  const source = new Database(join(codexHome, "state_5.sqlite"));
  source.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL);
    CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,name TEXT,cwd TEXT,archived INTEGER,archived_at INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER,created_at INTEGER,updated_at INTEGER,model TEXT,reasoning_effort TEXT,source TEXT);
  `);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_plain", "Plain", 0, 100);
  source.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("src_sub", "Sub", 1, 100);
  source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_plain", 0, plain);
  source.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("src_sub", 0, sub);
  source.prepare("INSERT INTO threads VALUES(?,?,?,NULL,?,0,NULL,1000,2000,1,2,NULL,NULL,'vscode')").run("chat", "src_plain", "Chat", sub);
  source.close();
  const target = new Database(join(bbHome, "bb.db"));
  target.exec(`
    CREATE TABLE threads(id TEXT,project_id TEXT,environment_id TEXT,provider_id TEXT,status TEXT,archived_at INTEGER,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE environments(id TEXT,project_id TEXT,host_id TEXT,path TEXT,status TEXT,environment_provider_id TEXT,environment_provider_selection TEXT);
    CREATE TABLE events(id TEXT,thread_id TEXT,environment_id TEXT,scope_kind TEXT,turn_id TEXT,provider_thread_id TEXT,sequence INTEGER,type TEXT,item_kind TEXT,data TEXT,created_at INTEGER);
    CREATE TABLE thread_search_segments(id TEXT,thread_id TEXT,source_kind TEXT,source_key TEXT,source_seq INTEGER,text TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  target.prepare("INSERT INTO threads VALUES('thr_1','proj_plain','env_1','codex','idle',NULL,1,2,NULL)").run();
  target.prepare("INSERT INTO events VALUES('evt_1','thr_1','env_1','thread',NULL,'chat',1,'thread/identity',NULL,'{}',1)").run();
  target.close();
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { bb, harness } = createFakePluginHost({
    pluginId: "codex-migrate",
    dataDir: bbHome,
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_test" }) },
      projects: { list: async () => [{ id: "proj_plain", name: "Plain", sources: [{ id: "source_plain", hostId: "host_test", path: plain, isDefault: true }] }] },
    },
  });
  try {
    await plugin(bb);
    const preview = await harness.behavior.callRpc("scan", { projects: ["Plain"], all: false, includeThreads: true });
    assert.deepEqual(preview.projects[0].conflicts, []);
    await assert.rejects(
      harness.behavior.callRpc("apply", { projects: [], roots: [plain, sub], gitInitRoots: [plain], all: false, existingOnly: false, limit: null }),
      /would absorb the selected folder/,
    );
    assert.equal(existsSync(join(plain, ".git")), false);
    await harness.lifecycle.dispose();
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});
