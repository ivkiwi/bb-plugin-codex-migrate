import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BbStore } from "./bb-store.js";
import { attachHistory } from "./attachments.js";
import { convertHistory, newId } from "./history.js";
import { CodexAppServer, CodexCatalog, PROJECTLESS_ID, type SourceProject, type SourceThread } from "./source.js";
import { folderRoute, inside, type FolderRoute } from "./routing.js";
import type { TitleMode } from "./titles.js";

const conflictSchema = z.object({
  sourceId: z.string(), title: z.string(), cwd: z.string(),
  reason: z.string(),
  owners: z.array(z.object({ id: z.string(), name: z.string() })),
  importedProjectId: z.string().nullable(),
});

const summarySchema = z.object({
  sourceId: z.string(), name: z.string(), roots: z.array(z.string()),
  targetProjectId: z.string().nullable(), candidates: z.number(),
  alreadyImported: z.number(), archived: z.number(),
  rootDetails: z.array(z.object({ path: z.string(), key: z.string(), kind: z.enum(["repository", "subfolder", "worktree", "non-git", "missing"]),
    git: z.boolean(), exists: z.boolean(), targetPath: z.string().nullable(), candidates: z.number(),
    targetProjectId: z.string().nullable(), targetProjectName: z.string(), linkedProjects: z.array(z.string()) })),
  conflicts: z.array(conflictSchema),
  threads: z.array(z.object({ id: z.string(), title: z.string(), cwd: z.string(), archived: z.boolean(), alreadyImported: z.boolean() })),
});
const projectReportSchema = z.object({
  sourceId: z.string(), name: z.string(), targetProjectId: z.string(), targetProjectIds: z.array(z.string()), candidates: z.number(),
  imported: z.number(), existing: z.number(), skippedEmpty: z.number(), uploadedAttachments: z.number(),
  partiallyImported: z.array(z.object({ sourceId: z.string(), message: z.string() })),
  failed: z.array(z.object({ sourceId: z.string(), message: z.string() })),
  mismatches: z.array(z.object({ sourceId: z.string(), field: z.string(), source: z.union([z.number(), z.boolean()]), target: z.union([z.number(), z.boolean()]) })),
});
const reportSchema = z.object({
  startedAt: z.string(), completedAt: z.string(), backupPath: z.string().nullable(),
  projects: z.array(projectReportSchema),
});
const projectProgressSchema = z.object({
  sourceId: z.string(), name: z.string(),
  state: z.enum(["queued", "running", "completed", "partial", "failed", "interrupted"]),
  processed: z.number(), total: z.number(), imported: z.number(), partiallyImported: z.number(), existing: z.number(), skippedEmpty: z.number(), failed: z.number(),
  currentThread: z.string().nullable(), updatedAt: z.string(), error: z.string().nullable(),
});
const runStatusSchema = z.object({
  runId: z.string(), state: z.enum(["running", "completed", "failed", "interrupted"]),
  projects: z.array(z.string()), startedAt: z.string(), updatedAt: z.string(), completedAt: z.string().nullable(),
  projectProgress: z.array(projectProgressSchema),
  currentProject: z.string().nullable(), currentThread: z.string().nullable(),
  processed: z.number(), total: z.number(), imported: z.number(), partiallyImported: z.number(), existing: z.number(), skippedEmpty: z.number(), failed: z.number(),
  error: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof summarySchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export const rpcContract = defineRpcContract({
  scan: {
    input: z.object({ projects: z.array(z.string()), roots: z.array(z.string()).optional(), all: z.boolean(), includeThreads: z.boolean() }).strict(),
    output: z.object({ projects: z.array(summarySchema) }),
  },
  apply: {
    input: z.object({ projects: z.array(z.string()), roots: z.array(z.string()).optional(), gitInitRoots: z.array(z.string()).optional(), all: z.literal(false), existingOnly: z.boolean(), limit: z.number().int().positive().nullable() }).strict(),
    output: reportSchema,
  },
  start: {
    input: z.object({ projects: z.array(z.string()), roots: z.array(z.string()).optional(), gitInitRoots: z.array(z.string()).optional(), all: z.literal(false), existingOnly: z.boolean(), limit: z.number().int().positive().nullable() }).strict(),
    output: z.object({ runId: z.string() }),
  },
  status: { input: z.null(), output: z.object({ current: runStatusSchema.nullable(), report: reportSchema.nullable() }) },
  lastRun: { input: z.null(), output: z.object({ report: reportSchema.nullable() }) },
  repair: {
    input: z.object({ projects: z.array(z.string()), roots: z.array(z.string()).optional(), bbProjectIds: z.array(z.string()).optional(), all: z.boolean() }).strict(),
    output: z.object({ threads: z.number(), events: z.number(), titles: z.number(), backupPath: z.string().nullable() }),
  },
});

interface Options {
  command: "scan" | "apply" | "repair" | "status" | "help";
  projects: string[];
  bbProjectIds: string[];
  all: boolean;
  existingOnly: boolean;
  limit: number | null;
  roots: string[];
  gitInitRoots: string[];
  initGitAll: boolean;
  json: boolean;
}

interface ProjectReport {
  sourceId: string;
  name: string;
  targetProjectId: string;
  targetProjectIds: string[];
  candidates: number;
  imported: number;
  partiallyImported: { sourceId: string; message: string }[];
  existing: number;
  skippedEmpty: number;
  uploadedAttachments: number;
  failed: { sourceId: string; message: string }[];
  mismatches: { sourceId: string; field: string; source: number | boolean; target: number | boolean }[];
}

interface ApplyReport {
  startedAt: string;
  completedAt: string;
  backupPath: string | null;
  projects: ProjectReport[];
}

function progressFromReport(report: ProjectReport, updatedAt: string): z.infer<typeof projectProgressSchema> {
  return {
    sourceId: report.sourceId, name: report.name, state: report.partiallyImported.length > 0 ? "partial" : "completed",
    processed: report.imported + report.partiallyImported.length + report.existing + report.skippedEmpty + report.failed.length,
    total: report.candidates, imported: report.imported, partiallyImported: report.partiallyImported.length, existing: report.existing,
    skippedEmpty: report.skippedEmpty, failed: report.failed.length,
    currentThread: null, updatedAt, error: null,
  };
}

function normalizeReport(report: ApplyReport | null): ApplyReport | null {
  if (!report) return null;
  return {
    ...report,
    projects: report.projects.map((project) => ({ ...project, partiallyImported: project.partiallyImported ?? [] })),
  };
}

function normalizeStatus(status: RunStatus | null): RunStatus | null {
  if (!status) return null;
  return {
    ...status,
    partiallyImported: status.partiallyImported ?? 0,
    projectProgress: Array.isArray(status.projectProgress)
      ? status.projectProgress.map((project) => ({ ...project, partiallyImported: project.partiallyImported ?? 0 }))
      : status.projectProgress,
  };
}

function canUseLocalHistory(cause: unknown): cause is Error {
  return cause instanceof Error && (
    cause.message.includes("thread/read timed out after 60 seconds") ||
    cause.message.includes("paginated threads do not support thread/read")
  );
}

// A plain folder owns its plain subfolders, as in Codex; only another Git repository is foreign.
function foreignChat(root: FolderRoute, thread: FolderRoute): boolean {
  return thread.exists && thread.targetPath !== root.targetPath && !(root.kind === "non-git" && thread.kind === "non-git");
}

function conflictFor(thread: SourceThread, project: SourceProject, targetId: string | null,
  catalog: CodexCatalog, store: BbStore, allProjects: SourceProject[], routeFor = folderRoute): z.infer<typeof conflictSchema> | null {
  const existing = store.existing(thread.id);
  const owners = catalog.owners(thread, allProjects);
  const root = rootForThread(project, thread, routeFor);
  if (!root) return { sourceId: thread.id, title: thread.title, cwd: thread.cwd,
    reason: "Chat directory does not match a project root", owners: owners.map((owner) => ({ id: owner.id, name: owner.name })), importedProjectId: existing?.projectId ?? null };
  const rootRoute = routeFor(root);
  const threadRoute = routeFor(thread.cwd);
  if (foreignChat(rootRoute, threadRoute)) return {
    sourceId: thread.id, title: thread.title, cwd: thread.cwd,
    reason: "Chat belongs to another Git repository; select its folder separately",
    owners: owners.map((owner) => ({ id: owner.id, name: owner.name })), importedProjectId: existing?.projectId ?? null,
  };
  if (existing && existing.projectId === targetId) return null;
  if (!existing) return null;
  return {
    sourceId: thread.id, title: thread.title, cwd: thread.cwd,
    reason: "Already imported into another BB project",
    owners: owners.map((owner) => ({ id: owner.id, name: owner.name })),
    importedProjectId: existing?.projectId ?? null,
  };
}

function matchesRoot(thread: SourceThread, root: string): boolean {
  if (inside(thread.cwd, root)) return true;
  const basename = root.split(/[\\/]/).filter(Boolean).at(-1);
  return Boolean(basename && thread.cwd.includes("/.codex/worktrees/") && thread.cwd.endsWith(`/${basename}`));
}

function rootForThread(project: SourceProject, thread: SourceThread, routeFor = folderRoute): string | null {
  const exact = project.roots.find((root) => thread.cwd === root);
  if (exact) return exact;
  const matches = project.roots.filter((root) => matchesRoot(thread, root)).sort((a, b) => b.length - a.length);
  if (matches.length > 1) {
    const threadTarget = routeFor(thread.cwd).targetPath;
    if (threadTarget) {
      const sameRepository = matches.find((root) => routeFor(root).targetPath === threadTarget);
      if (sameRepository) return sameRepository;
    }
  }
  return matches[0] ?? (project.id === PROJECTLESS_ID ? project.roots[0] ?? null : null);
}

function suggestedName(projects: SourceProject[], route: FolderRoute, routeFor = folderRoute): string {
  const exact = projects.find((project) => project.roots.some((root) => routeFor(root).key === route.targetPath) && project.roots.length === 1);
  return exact?.name ?? (route.targetPath ? basename(route.targetPath) : "directory");
}

function folderLabel(project: SourceProject, root: string): string {
  const name = basename(root);
  return name === project.name ? project.name : `${project.name} · ${name}`;
}

function select(catalog: CodexCatalog, names: string[], all: boolean, allowEmpty: boolean): SourceProject[] {
  if (all && names.length) throw new Error("--all cannot be combined with --project");
  if (!all && names.length === 0) {
    if (allowEmpty) return catalog.projects();
    throw new Error("Select a project with --project NAME, or explicitly pass --all");
  }
  const available = catalog.projects();
  if (all) return available;
  const selected: SourceProject[] = [];
  for (const name of names) {
    const matches = available.filter((project) => project.id === name || project.name === name);
    if (matches.length === 0) throw new Error(`Codex project not found: ${name}`);
    if (matches.length > 1) throw new Error(`Ambiguous Codex project name: ${name}; use its ID`);
    if (!selected.some((project) => project.id === matches[0]!.id)) selected.push(matches[0]!);
  }
  return selected;
}

function parseArgs(argv: string[]): Options {
  const command = argv[0] ?? "help";
  if (!["scan", "apply", "repair", "status", "help", "--help"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options: Options = { command: command === "--help" ? "help" : command as Options["command"], projects: [], bbProjectIds: [], roots: [], gitInitRoots: [], initGitAll: false, all: false, existingOnly: false, limit: null, json: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--project") {
      const name = argv[++index];
      if (!name || name.startsWith("--")) throw new Error("--project requires a Codex project name or ID");
      options.projects.push(name);
    } else if (arg === "--folder") {
      const path = argv[++index];
      if (!path || path.startsWith("--")) throw new Error("--folder requires a Codex project folder path");
      options.roots.push(path);
    } else if (arg === "--bb-project") {
      const id = argv[++index];
      if (!id || !id.startsWith("proj_")) throw new Error("--bb-project requires a BB project ID");
      options.bbProjectIds.push(id);
    } else if (arg === "--all") options.all = true;
    else if (arg === "--init-git") options.initGitAll = true;
    else if (arg === "--claim-shared-paths") throw new Error("--claim-shared-paths is obsolete; shared folders are selected once by path");
    else if (arg === "--existing-only") options.existingOnly = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--limit") {
      const raw = argv[++index];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < 1 || value > 1000) throw new Error("--limit requires an integer from 1 to 1000");
      options.limit = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.all && (options.projects.length || options.roots.length)) throw new Error("--all cannot be combined with --project or --folder");
  if (options.projects.length && options.roots.length) throw new Error("--project cannot be combined with --folder");
  if (options.bbProjectIds.length && (options.command !== "repair" || options.projects.length || options.roots.length || options.all)) throw new Error("--bb-project applies only to repair and cannot be combined with other selections");
  if (options.command !== "apply" && (options.existingOnly || options.limit !== null || options.initGitAll)) throw new Error("--existing-only, --limit and --init-git apply only to apply");
  if (options.command === "status" && (options.all || options.projects.length || options.roots.length)) throw new Error("status does not select projects or folders");
  return options;
}

export default async function plugin(bb: BbPluginApi) {
  const titleSettings = bb.settings.define({
    titleMode: { type: "select", label: "Imported chat titles", options: ["truncate", "original"], default: "truncate" },
    titleMaxLength: { type: "number", label: "Maximum title length", default: 80,
      experimental_schema: z.number().int().min(30).max(200) },
  });
  let applying = false;
  let disposed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let statusWrite: Promise<void> = Promise.resolve();
  let active: RunStatus | null = normalizeStatus(await bb.storage.kv.get<RunStatus>("current-run") ?? null);
  const dataDir = bb.server.experimental_dataDir;
  if (active && !Array.isArray(active.projectProgress)) {
    const priorReport = normalizeReport(await bb.storage.kv.get<ApplyReport>("last-run") ?? null);
    active = {
      ...active,
      projectProgress: priorReport?.startedAt === active.startedAt
        ? priorReport.projects.map((report) => progressFromReport(report, active!.updatedAt))
        : active.projects.filter((name) => name !== "--all").map((name) => ({
          sourceId: name, name, state: "interrupted" as const, processed: 0, total: 0,
          imported: 0, partiallyImported: 0, existing: 0, skippedEmpty: 0, failed: 0,
          currentThread: null, updatedAt: active!.updatedAt, error: active!.error,
        })),
    };
    await bb.storage.kv.set("current-run", active);
  }
  if (active?.state === "running") {
    const interruptedAt = new Date().toISOString();
    const error = "BB restarted or the plugin was reloaded during the migration. Rerun the same selection to continue without duplicates.";
    active = { ...active, state: "interrupted", updatedAt: interruptedAt, completedAt: interruptedAt, error,
      projectProgress: active.projectProgress.map((project) => project.state === "completed" ? project : { ...project, state: "interrupted", updatedAt: interruptedAt, currentThread: null, error }) };
    await bb.storage.kv.set("current-run", active);
  }

  async function updateStatus(next: RunStatus): Promise<void> {
    if (disposed) return;
    active = next;
    const write = statusWrite.then(() => bb.storage.kv.set("current-run", next));
    statusWrite = write.catch(() => undefined);
    await write;
    bb.realtime.publish("migration-progress", { runId: next.runId });
  }
  bb.onDispose(() => { disposed = true; if (heartbeat) clearInterval(heartbeat); });

  async function scan(names: string[], roots: string[], all: boolean, includeThreads: boolean): Promise<ProjectSummary[]> {
    const catalog = new CodexCatalog();
    const store = new BbStore(dataDir);
    try {
      const routeCache = new Map<string, FolderRoute>();
      const routeFor = (path: string) => {
        let route = routeCache.get(path);
        if (!route) { route = folderRoute(path); routeCache.set(path, route); }
        return route;
      };
      const allProjects = catalog.projects();
      const selectedKeys = roots.length ? new Set(roots.map((root) => routeFor(root).key)) : null;
      const selected = selectedKeys
        ? allProjects.filter((project) => project.roots.some((root) => selectedKeys.has(routeFor(root).key)))
        : select(catalog, names, all, true);
      const targets = await bb.sdk.projects.list();
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      const matches = (path: string | null) => path === null ? [] : targets.filter((candidate) => candidate.sources.some((source) => source.hostId === hostId && routeFor(source.path).key === path));
      return selected.map((project) => {
        const projectRoots = selectedKeys ? project.roots.filter((root) => selectedKeys.has(routeFor(root).key)) : project.roots;
        const threads = catalog.threads(project).filter((thread) => {
          const root = rootForThread(project, thread, routeFor);
          return root !== null && projectRoots.includes(root);
        });
        const existing = threads.map((thread) => store.existing(thread.id));
        const conflicts = includeThreads ? threads.map((thread) => {
          const root = rootForThread(project, thread, routeFor);
          const matching = root ? matches(routeFor(thread.cwd).targetPath ?? routeFor(root).targetPath) : [];
          return conflictFor(thread, project, matching.length === 1 ? matching[0]!.id : null, catalog, store, allProjects, routeFor);
        }).filter((item) => item !== null) : [];
        const firstTarget = projectRoots[0] ? matches(routeFor(projectRoots[0]).targetPath) : [];
        return {
          sourceId: project.id, name: project.name, roots: projectRoots,
          targetProjectId: firstTarget.length === 1 ? firstTarget[0]!.id : null, candidates: threads.length,
          alreadyImported: existing.filter(Boolean).length,
          archived: threads.filter((thread) => thread.archived).length,
          rootDetails: projectRoots.map((path) => {
            const route = routeFor(path);
            const matching = matches(route.targetPath);
            return { path, key: route.key, kind: route.kind, exists: route.exists, git: route.git, targetPath: route.targetPath,
              candidates: threads.filter((thread) => rootForThread(project, thread, routeFor) === path).length,
              targetProjectId: matching.length === 1 ? matching[0]!.id : null,
              targetProjectName: matching.length > 1 ? "Ambiguous BB projects" : matching[0]?.name ?? suggestedName(allProjects, route, routeFor),
              linkedProjects: [...new Set(allProjects.filter((item) => item.roots.some((root) => routeFor(root).key === route.key)).map((item) => item.name))] };
          }),
          conflicts,
          threads: includeThreads ? threads.map((thread, index) => ({
            id: thread.id, title: thread.title, cwd: thread.cwd, archived: thread.archived,
            alreadyImported: existing[index] !== null,
          })) : [],
        };
      });
    } finally { store.close(); catalog.close(); }
  }

  async function repair(names: string[], roots: string[], bbProjectIds: string[], all: boolean) {
    if (applying) throw new Error("Another Codex migration is already running");
    if (!all && names.length === 0 && roots.length === 0 && bbProjectIds.length === 0) throw new Error("Select a project or folder explicitly");
    if (all && (names.length || roots.length || bbProjectIds.length)) throw new Error("--all cannot be combined with project or folder selection");
    if (bbProjectIds.length && (names.length || roots.length)) throw new Error("BB project selection cannot be combined with Codex project or folder selection");
    applying = true;
    const catalog = new CodexCatalog();
    const store = new BbStore(dataDir, true);
    try {
      const selected = bbProjectIds.length ? catalog.projects() : select(catalog, names, all, Boolean(roots.length));
      const keys = new Set(roots.map((root) => folderRoute(root).key));
      const bbIds = new Set(bbProjectIds);
      const candidates = new Map<string, SourceThread>();
      for (const project of selected) {
        for (const thread of catalog.threads(project)) {
          const root = rootForThread(project, thread);
          const existing = store.existing(thread.id);
          if (root && existing && (bbIds.size ? bbIds.has(existing.projectId) : (!roots.length || keys.has(folderRoute(root).key)))) candidates.set(thread.id, thread);
        }
      }
      const { titleMode, titleMaxLength } = await titleSettings.get();
      // Back up before touching existing BB events or titles.
      const backupPath = candidates.size ? await store.backup(dataDir) : null;
      let events = 0;
      let titles = 0;
      for (const thread of candidates.values()) {
        const fixed = store.repairImportedThread(thread, titleMode as TitleMode, titleMaxLength);
        events += fixed.events;
        if (fixed.title) titles++;
      }
      return { threads: candidates.size, events, titles, backupPath };
    } finally { store.close(); catalog.close(); applying = false; }
  }

  async function apply(options: Pick<Options, "projects" | "all" | "existingOnly" | "limit"> & Partial<Pick<Options, "roots" | "gitInitRoots" | "initGitAll">>, runId = newId("run")): Promise<ApplyReport> {
    if (applying) throw new Error("Another Codex migration is already running");
    applying = true;
    const startedAt = new Date().toISOString();
    let progress: RunStatus = {
      runId, state: "running", projects: options.all ? ["--all"] : options.projects,
      startedAt, updatedAt: startedAt, completedAt: null,
      projectProgress: options.projects.map((name) => ({
        sourceId: name, name, state: "queued", processed: 0, total: 0,
        imported: 0, partiallyImported: 0, existing: 0, skippedEmpty: 0, failed: 0,
        currentThread: null, updatedAt: startedAt, error: null,
      })),
      currentProject: null, currentThread: null,
      processed: 0, total: 0, imported: 0, partiallyImported: 0, existing: 0, skippedEmpty: 0, failed: 0, error: null,
    };
    let catalog: CodexCatalog | null = null;
    let store: BbStore | null = null;
    let source: CodexAppServer | null = null;
    const reports: ProjectReport[] = [];
    let backupPath: string | null = null;
    const updateProject = (sourceId: string, fields: Partial<z.infer<typeof projectProgressSchema>>) => {
      const updatedAt = new Date().toISOString();
      progress = { ...progress, updatedAt,
        projectProgress: progress.projectProgress.map((project) => project.sourceId === sourceId ? { ...project, ...fields, updatedAt } : project) };
    };
    try {
      await updateStatus(progress);
      heartbeat = setInterval(() => {
        if (disposed || progress.state !== "running") return;
        const updatedAt = new Date().toISOString();
        progress = { ...progress, updatedAt, projectProgress: progress.projectProgress.map((project) => project.state === "running" ? { ...project, updatedAt } : project) };
        void updateStatus(progress).catch(() => undefined);
      }, 5_000);
      const openedCatalog = new CodexCatalog();
      catalog = openedCatalog;
      const routeCache = new Map<string, FolderRoute>();
      const routeFor = (path: string) => {
        let route = routeCache.get(path);
        if (!route) { route = folderRoute(path); routeCache.set(path, route); }
        return route;
      };
      const allProjects = openedCatalog.projects();
      const selectedRootInputs = (options.roots ?? []).map((root) => routeFor(root).key);
      const gitInitRoots = options.gitInitRoots ?? [];
      const selected = selectedRootInputs.length
        ? allProjects.filter((project) => project.roots.some((root) => selectedRootInputs.includes(routeFor(root).key)))
        : select(openedCatalog, options.projects, options.all, false);
      const selectedKeys = new Set(selectedRootInputs.length ? selectedRootInputs : selected.flatMap((project) => project.roots.map((root) => routeFor(root).key)));
      if (selectedKeys.size === 0) throw new Error("Select at least one Codex project folder");
      const allowedKeys = new Set(allProjects.flatMap((project) => project.roots.map((root) => routeFor(root).key)));
      for (const key of selectedKeys) if (!allowedKeys.has(key)) throw new Error(`Unknown Codex project folder: ${key}`);
      for (const key of gitInitRoots) if (!selectedKeys.has(key) || routeFor(key).kind !== "non-git") throw new Error(`Cannot initialize Git for unselected or Git-backed folder: ${key}`);
      const activeStore = new BbStore(dataDir, true);
      store = activeStore;
      const folders = new Map<string, { key: string; root: string; route: FolderRoute; project: SourceProject; candidates: Map<string, SourceThread> }>();
      for (const project of selected) for (const root of project.roots) {
        const route = routeFor(root);
        if (!selectedKeys.has(route.key)) continue;
        const previous = folders.get(route.key);
        if (!previous || (project.roots.length === 1 && previous.project.roots.length > 1)) {
          folders.set(route.key, { key: route.key, root, route, project, candidates: previous?.candidates ?? new Map() });
        }
      }
      for (const project of selected) for (const thread of openedCatalog.threads(project)) {
        const root = rootForThread(project, thread, routeFor);
        if (!root) continue;
        const folder = folders.get(routeFor(root).key);
        if (folder) folder.candidates.set(thread.id, thread);
      }
      const seenThreads = new Set<string>();
      const plans = [...folders.values()].sort((a, b) => b.root.length - a.root.length).map((folder) => {
        const candidates = [...folder.candidates.values()].filter((thread) => {
          if (seenThreads.has(thread.id)) return false;
          seenThreads.add(thread.id);
          return !options.existingOnly || activeStore.existing(thread.id) !== null;
        });
        return { ...folder, candidates };
      });
      if (plans.length === 0) throw new Error("No importable folders selected.");
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (hostId === null) throw new Error("BB has no primary host");
      const existingTargets = await bb.sdk.projects.list();
      progress = {
        ...progress,
        total: plans.reduce((sum, plan) => sum + plan.candidates.length, 0),
        projectProgress: plans.map(({ key, project, root, candidates }) => ({
          sourceId: key, name: folderLabel(project, root), state: "queued" as const,
          processed: 0, total: candidates.length, imported: 0, partiallyImported: 0, existing: 0,
          skippedEmpty: 0, failed: 0, currentThread: null,
          updatedAt: new Date().toISOString(), error: null,
        })),
        updatedAt: new Date().toISOString(),
      };
      await updateStatus(progress);
      for (const { root, route, candidates } of plans) {
        if (!route.exists || !route.targetPath) throw new Error(`Codex project path does not exist: ${root}`);
        const matching = existingTargets.filter((candidate) => candidate.sources.some((source) => source.hostId === hostId && routeFor(source.path).key === route.targetPath));
        if (matching.length > 1) throw new Error(`Several BB projects use ${route.targetPath}; choose one before migration`);
        for (const thread of candidates) {
          if (foreignChat(route, routeFor(thread.cwd))) throw new Error(`Chat ${thread.id} belongs to another Git repository: ${thread.cwd}`);
          const existing = activeStore.existing(thread.id);
          if (existing && existing.projectId !== matching[0]?.id) throw new Error(`Chat ${thread.id} is already in another BB project: ${existing.projectId}. Resolve this before import.`);
        }
      }
      for (const { key, route } of plans) if (route.kind === "non-git" && (options.initGitAll || gitInitRoots.includes(key))) {
        execFileSync("git", ["-C", route.key, "init"], { stdio: "pipe" });
      }
      const { titleMode, titleMaxLength } = await titleSettings.get();
      let remaining = options.limit ?? Number.POSITIVE_INFINITY;
      const routeTargets = new Map<string, { id: string; name: string }>();
      for (const { project, key, route, candidates } of plans) {
        if (disposed) throw new Error("Migration interrupted by plugin reload");
        if (candidates.length === 0 && options.existingOnly) {
          updateProject(key, { state: "completed" });
          await updateStatus(progress);
          continue;
        }
        const targetPath = route.targetPath!;
        let target = routeTargets.get(targetPath);
        if (!target) {
          const matching = (await bb.sdk.projects.list()).filter((candidate) => candidate.sources.some((item) => item.hostId === hostId && routeFor(item.path).key === targetPath));
          if (matching.length > 1) throw new Error(`Several BB projects use ${targetPath}; choose one before migration`);
          let bbProject = matching[0];
          if (!bbProject) {
            if (backupPath === null) backupPath = await activeStore.backup(dataDir);
            bbProject = await bb.sdk.projects.create({ name: suggestedName(allProjects, route, routeFor), source: { type: "local_path", hostId, path: targetPath } });
          }
          target = { id: bbProject.id, name: bbProject.name };
          routeTargets.set(targetPath, target);
        }
        const report: ProjectReport = { sourceId: key, name: folderLabel(project, key), targetProjectId: target.id, targetProjectIds: [target.id],
          candidates: candidates.length, imported: 0, partiallyImported: [], existing: 0, skippedEmpty: 0,
          uploadedAttachments: 0, failed: [], mismatches: [] };
        reports.push(report);
        progress = { ...progress, currentProject: key, currentThread: null, updatedAt: new Date().toISOString() };
        updateProject(key, { state: "running", currentThread: null });
        await updateStatus(progress);
        for (const thread of candidates) {
          if (disposed) throw new Error("Migration interrupted by plugin reload");
          const existing = activeStore.existing(thread.id);
          if (!existing && remaining <= 0) break;
          progress = { ...progress, currentThread: thread.title || thread.id, updatedAt: new Date().toISOString() };
          updateProject(key, { currentThread: thread.title || thread.id });
          await updateStatus(progress);
          try {
            if (existing && !options.existingOnly) {
              report.existing++;
              continue;
            }
            if (source === null) {
              source = new CodexAppServer();
              await source.ready;
            }
            let rawHistory: unknown;
            try {
              rawHistory = await source.readThread(thread.id);
            } catch (cause) {
              if (!canUseLocalHistory(cause)) throw cause;
              if (cause.message.includes("paginated threads do not support thread/read")) {
                rawHistory = await openedCatalog.localThread(thread.id);
              } else {
                source.close();
                source = null;
                rawHistory = openedCatalog.projectedThread(thread.id);
              }
            }
            const history = convertHistory(rawHistory, thread);
            if (disposed) throw new Error("Migration interrupted by plugin reload");
            if (existing) {
              if (existing.projectId !== target.id) throw new Error(`Already imported into another BB project: ${existing.projectId}`);
              report.existing++;
              for (const [field, sourceValue, targetValue] of [
                ["userMessages", history.userMessages, existing.userMessages],
                ["assistantMessages", history.assistantMessages, existing.assistantMessages],
              ] as const) if (targetValue < sourceValue) report.mismatches.push({ sourceId: thread.id, field, source: sourceValue, target: targetValue });
              if (thread.archived !== existing.archived && existing.userMessages === history.userMessages && existing.assistantMessages === history.assistantMessages) {
                report.mismatches.push({ sourceId: thread.id, field: "archived", source: thread.archived, target: existing.archived });
              }
              continue;
            }
            if (history.userMessages === 0 && history.assistantMessages === 0) {
              report.skippedEmpty++;
              continue;
            }
            const attachments = await attachHistory(bb, openedCatalog, target.id, thread.id, history);
            if (backupPath === null) backupPath = await activeStore.backup(dataDir);
            activeStore.importThread({ projectId: target.id, hostId, projectRoot: targetPath, source: thread, history,
              titleMode: titleMode as TitleMode, titleMaxLength });
            if (attachments.unresolved.length > 0) {
              report.partiallyImported.push({ sourceId: thread.id, message: `Unavailable attachments: ${attachments.unresolved.join("; ")}` });
            } else {
              report.imported++;
            }
            report.uploadedAttachments += attachments.uploaded;
            remaining--;
          } catch (cause) {
            if (cause instanceof Error && cause.message.includes("timed out after 60 seconds")) {
              source?.close();
              source = null;
            }
            if (openedCatalog.isEmptyPlaceholder(thread.id)) {
              report.skippedEmpty++;
            } else {
              report.failed.push({ sourceId: thread.id, message: cause instanceof Error ? cause.message : String(cause) });
            }
          } finally {
            const totals = reports.reduce((sum, item) => ({
              imported: sum.imported + item.imported,
              partiallyImported: sum.partiallyImported + item.partiallyImported.length,
              existing: sum.existing + item.existing,
              skippedEmpty: sum.skippedEmpty + item.skippedEmpty,
              failed: sum.failed + item.failed.length,
            }), { imported: 0, partiallyImported: 0, existing: 0, skippedEmpty: 0, failed: 0 });
            progress = {
              ...progress, processed: totals.imported + totals.partiallyImported + totals.existing + totals.skippedEmpty + totals.failed,
              ...totals,
              updatedAt: new Date().toISOString(),
            };
            updateProject(key, {
              processed: report.imported + report.partiallyImported.length + report.existing + report.skippedEmpty + report.failed.length,
              imported: report.imported, partiallyImported: report.partiallyImported.length, existing: report.existing,
              skippedEmpty: report.skippedEmpty, failed: report.failed.length,
            });
            await updateStatus(progress);
          }
        }
        const handled = report.imported + report.partiallyImported.length + report.existing + report.skippedEmpty + report.failed.length;
        updateProject(key, { state: report.partiallyImported.length > 0 || handled < candidates.length ? "partial" : "completed", currentThread: null });
        progress = { ...progress, currentThread: null };
        await updateStatus(progress);
      }
      const result: ApplyReport = { startedAt, completedAt: new Date().toISOString(), backupPath, projects: reports };
      await bb.storage.kv.set("last-run", result);
      progress = { ...progress, state: "completed", currentProject: null, currentThread: null, completedAt: result.completedAt, updatedAt: result.completedAt,
        projectProgress: progress.projectProgress.map((project) => project.state === "queued" ? { ...project, state: "completed", updatedAt: result.completedAt } : project) };
      await updateStatus(progress);
      bb.realtime.publish("migration-finished", { at: result.completedAt });
      return result;
    } catch (cause) {
      const completedAt = new Date().toISOString();
      const error = cause instanceof Error ? cause.message : String(cause);
      progress = { ...progress, state: "failed", completedAt, updatedAt: completedAt, error,
        projectProgress: progress.projectProgress.map((project) => project.state === "completed" || project.state === "partial" ? project : {
          ...project, state: progress.currentProject === null || project.sourceId === progress.currentProject ? "failed" : "interrupted",
          updatedAt: completedAt, currentThread: null, error,
        }) };
      await updateStatus(progress);
      throw cause;
    } finally { if (heartbeat) clearInterval(heartbeat); heartbeat = null; source?.close(); store?.close(); catalog?.close(); applying = false; }
  }

  bb.rpc.register(rpcContract, {
    scan: async ({ projects, roots, all, includeThreads }) => ({ projects: await scan(projects, roots ?? [], all, includeThreads) }),
    apply: async (input) => apply(input),
    start: async (input) => {
      if (applying) throw new Error("Another Codex migration is already running");
      const runId = newId("run");
      void apply(input, runId).catch((cause: unknown) => {
        bb.log.error(`Codex migration ${runId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
      return { runId };
    },
    status: async () => ({ current: active, report: normalizeReport(await bb.storage.kv.get<ApplyReport>("last-run") ?? null) }),
    lastRun: async () => ({ report: normalizeReport(await bb.storage.kv.get<ApplyReport>("last-run") ?? null) }),
    repair: async ({ projects, roots, bbProjectIds, all }) => repair(projects, roots ?? [], bbProjectIds ?? [], all),
  });

  const usage = [
    "Usage:",
    "  bb codex-migrate scan [--project NAME ... | --folder PATH ... | --all] [--json]",
    "  bb codex-migrate apply (--project NAME ... | --folder PATH ... | --all) [--existing-only] [--limit N] [--init-git] [--json]",
    "  bb codex-migrate status [--json]",
    "  bb codex-migrate repair (--project NAME ... | --folder PATH ... | --bb-project ID ... | --all) [--json]",
    "No folder is imported unless --project, --folder or --all is explicitly supplied to apply.",
  ].join("\n");
  bb.cli.register({
    name: "codex-migrate",
    summary: "Preview and import explicitly selected Codex projects and chats",
    commands: [
      { name: "scan", summary: "Read-only preview", usage: "bb codex-migrate scan [--project NAME ... | --folder PATH ... | --all] [--json]" },
      { name: "apply", summary: "Import explicitly selected folders", usage: "bb codex-migrate apply (--project NAME ... | --folder PATH ... | --all) [--existing-only] [--limit N] [--init-git] [--json]" },
      { name: "status", summary: "Show current progress and last report", usage: "bb codex-migrate status [--json]" },
      { name: "repair", summary: "Repair imported chats and apply the title setting", usage: "bb codex-migrate repair (--project NAME ... | --folder PATH ... | --bb-project ID ... | --all) [--json]" },
    ],
    async run(argv) {
      try {
        const options = parseArgs(argv);
        if (options.command === "help") return { exitCode: 0, stdout: usage };
        if (options.command === "scan") {
          const projects = await scan(options.projects, options.roots, options.all, options.projects.length > 0 || options.roots.length > 0 || options.all);
          const compact = projects.map((project) => `${project.name}: ${project.candidates} chats, ${project.alreadyImported} in BB, ${project.archived} archived`).join("\n");
          return { exitCode: 0, stdout: options.json ? JSON.stringify({ projects }) : compact };
        }
        if (options.command === "status") {
          const report = normalizeReport(await bb.storage.kv.get<ApplyReport>("last-run") ?? null);
          return { exitCode: 0, stdout: options.json ? JSON.stringify({ current: active, report }) : active ? JSON.stringify(active, null, 2) : report ? JSON.stringify(report, null, 2) : "No migration has run." };
        }
        if (options.command === "repair") {
          const report = await repair(options.projects, options.roots, options.bbProjectIds, options.all);
          return { exitCode: 0, stdout: options.json ? JSON.stringify(report) : `${report.threads} chats checked; ${report.events} events repaired; ${report.titles} titles shortened. Backup: ${report.backupPath ?? "not needed"}` };
        }
        const report = await apply(options);
        const errors = report.projects.reduce((count, project) => count + project.failed.length + project.mismatches.length, 0);
        const compact = report.projects.map((project) => `${project.name}: ${project.imported} imported, ${project.partiallyImported.length} partially imported, ${project.existing} existing, ${project.skippedEmpty} empty skipped, ${project.uploadedAttachments} attachments, ${project.failed.length} failed, ${project.mismatches.length} mismatches`).join("\n");
        return { exitCode: errors ? 1 : 0, stdout: options.json ? JSON.stringify(report) : `${compact}\nBackup: ${report.backupPath ?? "not needed"}` };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { exitCode: 1, stderr: `${message}\n${usage}` };
      }
    },
  });
}
