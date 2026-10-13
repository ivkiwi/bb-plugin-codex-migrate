import test from "node:test";
import assert from "node:assert/strict";
import { convertHistory } from "./.tmp-test/history.js";
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
