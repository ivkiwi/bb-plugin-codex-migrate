import test from "node:test";
import assert from "node:assert/strict";
import { convertHistory, renderCodexDirectives } from "./.tmp-test/history.js";
import { formatTitle } from "./.tmp-test/titles.js";

test("tool calls without an error use the BB event schema", () => {
  const meta = { id: "source_1", title: "Example", cwd: "/tmp", createdAtMs: 1, updatedAtMs: 2 };
  const raw = { id: "source_1", turns: [{ id: "turn_1", items: [
    { type: "userMessage", id: "user_1", content: [{ type: "text", text: "Hi" }] },
    { type: "mcpToolCall", id: "tool_1", server: "example", tool: "run", error: null },
  ] }] };
  const event = convertHistory(raw, meta).events.find((item) => item.itemId === "tool_1");
  assert.ok(event);
  assert.equal(Object.hasOwn(JSON.parse(event.data).item, "error"), false);
});

test("title truncation is configurable and keeps Unicode characters intact", () => {
  assert.equal(formatTitle("  A   long\nchat title with many words  ", "truncate", 30), "A long chat title with many…");
  assert.equal(formatTitle("  A   long\nchat title  ", "original", 30), "A   long\nchat title");
  assert.equal(formatTitle("😀".repeat(40), "truncate", 30), `${"😀".repeat(29)}…`);
});

test("last activity comes from real turn times only", () => {
  const meta = { id: "source_1", title: "Example", cwd: "/tmp", createdAtMs: 1000, updatedAtMs: 2000 };
  const turn = (id, startedAt, completedAt) => ({ id, startedAt, completedAt, items: [{ type: "userMessage", id: `${id}_user`, content: [{ type: "text", text: "Hi" }] }] });
  assert.equal(convertHistory({ id: "source_1", turns: [turn("a", 10, 12), turn("b", 20, null)] }, meta).lastActivityAt, 20000);
  assert.equal(convertHistory({ id: "source_1", turns: [turn("a", null, null)] }, meta).lastActivityAt, null);
});

test("Codex directives become Markdown and unknown ones stay as written", () => {
  assert.equal(renderCodexDirectives('See :codex-file-citation{path="/tmp/out/Отчёт 1.xlsx" purpose="output"}.'), "See 📊 [Отчёт 1.xlsx](</tmp/out/Отчёт 1.xlsx>).");
  assert.equal(renderCodexDirectives('::git-push{cwd="/work/muesli" branch="fix"}'), "_Pushed `fix` from `muesli`_");
  assert.equal(renderCodexDirectives('::git-create-pr{cwd="/w/r" branch="b" url="https://x/pull/1" isDraft=false}'), "_Opened pull request:_ https://x/pull/1");
  assert.equal(renderCodexDirectives('::inbox-item{title="Done" summary="Sent \\"it\\""}'), '**Done** — Sent "it"');
  assert.equal(
    renderCodexDirectives('::code-comment{title="[P1] Bug" body="Line one\nline two" file="/w/a.php" start=27 end=28 priority=1}'),
    "> **[P1] Bug**\n> \n> Line one\n> line two\n> \n> `/w/a.php:27-28`",
  );
  assert.equal(renderCodexDirectives('::created-thread{clientThreadId="client-new-thread:1"}'), "_Started a new thread_");
  assert.equal(
    renderCodexDirectives('Run `::git-push{cwd="/a"}` or\n```\n::git-stage{cwd="/a"}\n```\n::git-stage{cwd="/w/b"}'),
    'Run `::git-push{cwd="/a"}` or\n```\n::git-stage{cwd="/a"}\n```\n_Staged changes in `b`_',
  );
  for (const kept of [
    'See ``::git-stage{cwd="/w/r"}`` here',
    '````md\n```\n::git-stage{cwd="/w/r"}\n```\n````',
    'Open fence\n```\n::git-stage{cwd="/w/r"}',
  ]) assert.equal(renderCodexDirectives(kept), kept);
  assert.equal(renderCodexDirectives('A ` alone, then ::git-commit{cwd="/w/r"}'), "A ` alone, then _Committed in `r`_");
  assert.equal(
    renderCodexDirectives('::code-comment{title="Check" body="Read `value` first"}'),
    "> **Check**\n> \n> Read `value` first",
  );
  for (const raw of ["::future-card{x=1}", "a:hover{color:red}", "User::canEdit()"]) assert.equal(renderCodexDirectives(raw), raw);
});
