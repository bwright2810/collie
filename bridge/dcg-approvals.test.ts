import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DcgApprovals, DcgWatcher, parseAnswerBody, type DcgAction, type DcgPending } from "./dcg-approvals.ts";

let dir: string;
let approvals: DcgApprovals;

const NOW = new Date("2026-07-30T12:00:00.000Z");
const LATER = new Date("2026-07-30T12:02:00.000Z"); // +120s, inside a 180s window
const AFTER_EXPIRY = new Date("2026-07-30T12:05:00.000Z");

async function publish(id: string, overrides: Record<string, unknown> = {}) {
  const payload = {
    id,
    ruleId: "core.filesystem:rm-rf-general",
    command: "rm -rf /somewhere/real",
    cwd: "C:\\Projects\\thing",
    reason: "rm -rf is destructive",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 180_000).toISOString(),
    host: "TESTBOX",
    ...overrides,
  };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(payload));
  return payload;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dcg-approvals-"));
  approvals = new DcgApprovals(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("listPending", () => {
  test("returns a published, unexpired block", async () => {
    await publish("abc123");
    const pending = await approvals.listPending(LATER);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.command).toBe("rm -rf /somewhere/real");
  });

  test("returns nothing when the directory does not exist", async () => {
    const missing = new DcgApprovals(join(dir, "nope"));
    expect(await missing.listPending(NOW)).toEqual([]);
  });

  test("hides an expired block", async () => {
    await publish("abc123");
    expect(await approvals.listPending(AFTER_EXPIRY)).toEqual([]);
  });

  test("hides a block already claimed at the desk", async () => {
    await publish("abc123");
    await writeFile(join(dir, "abc123.lock"), "dialog");
    expect(await approvals.listPending(LATER)).toEqual([]);
  });

  test("hides a block that already has an answer", async () => {
    await publish("abc123");
    await writeFile(join(dir, "abc123.answer"), '{"action":"once"}');
    expect(await approvals.listPending(LATER)).toEqual([]);
  });

  // A half-written .json (the hook writes .tmp then renames) must never be offered.
  test("ignores a .tmp file and malformed json", async () => {
    await writeFile(join(dir, "half.json.tmp"), '{"id":"half"');
    await writeFile(join(dir, "bad.json"), "not json");
    expect(await approvals.listPending(LATER)).toEqual([]);
  });

  // The publisher is a PowerShell hook, and some of its cmdlets prepend a UTF-8 BOM that plain
  // JSON.parse rejects. Caught only by an end-to-end test, so pin it here.
  test("reads a payload written with a UTF-8 BOM", async () => {
    const payload = await publish("bom123");
    await writeFile(join(dir, "bom123.json"), "﻿" + JSON.stringify(payload));
    const pending = await approvals.listPending(LATER);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("bom123");
  });

  test("ignores a payload whose id disagrees with its filename", async () => {
    await publish("abc123", { id: "spoofed" });
    expect(await approvals.listPending(LATER)).toEqual([]);
  });

  test("orders oldest first", async () => {
    await publish("second", { createdAt: "2026-07-30T12:00:05.000Z" });
    await publish("first", { createdAt: "2026-07-30T12:00:01.000Z" });
    const ids = (await approvals.listPending(LATER)).map((p) => p.id);
    expect(ids).toEqual(["first", "second"]);
  });
});

describe("answer", () => {
  test("claims and writes the answer", async () => {
    await publish("abc123");
    const res = await approvals.answer("abc123", "once", "project", "pixel", LATER);
    expect(res.ok).toBe(true);

    const written = JSON.parse(await readFile(join(dir, "abc123.answer"), "utf8"));
    expect(written.action).toBe("once");
    expect(written.scope).toBe("project");
    expect(written.device).toBe("pixel");
    expect(await readFile(join(dir, "abc123.lock"), "utf8")).toBe("phone:pixel");
  });

  // The safety property the whole design rests on: one block, one winner.
  test("a second answer is refused once claimed", async () => {
    await publish("abc123");
    const first = await approvals.answer("abc123", "once", "project", "pixel", LATER);
    const second = await approvals.answer("abc123", "deny", "project", "other", LATER);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "claimed" });
  });

  test("loses to a dialog that claimed first", async () => {
    await publish("abc123");
    await writeFile(join(dir, "abc123.lock"), "dialog");
    expect(await approvals.answer("abc123", "once", "project", "pixel", LATER)).toEqual({
      ok: false,
      reason: "claimed",
    });
  });

  test("refuses an expired block", async () => {
    await publish("abc123");
    expect(await approvals.answer("abc123", "once", "project", null, AFTER_EXPIRY)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("refuses an unknown id", async () => {
    expect(await approvals.answer("nosuch", "once", "project", null, LATER)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  // The id is interpolated into a path, so traversal must be rejected outright.
  test("refuses a path-traversal id", async () => {
    for (const id of ["../escape", "a/b", "..", "a\\b"]) {
      expect(await approvals.answer(id, "once", "project", null, LATER)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
  });
});

describe("pruneExpired", () => {
  test("removes an orphaned request past its grace period", async () => {
    await publish("abc123");
    await writeFile(join(dir, "abc123.lock"), "dialog");
    const removed = await approvals.pruneExpired(new Date(NOW.getTime() + 400_000));
    expect(removed).toBe(1);
    expect(await approvals.listPending(NOW)).toEqual([]);
  });

  test("keeps a live request", async () => {
    await publish("abc123");
    expect(await approvals.pruneExpired(LATER)).toBe(0);
    expect(await approvals.listPending(LATER)).toHaveLength(1);
  });
});

describe("parseAnswerBody", () => {
  test("accepts the four known actions", () => {
    const actions: DcgAction[] = ["deny", "once", "rule", "command"];
    for (const action of actions) {
      expect(parseAnswerBody({ action })).toEqual({ ok: true, action, scope: "project" });
    }
  });

  test("accepts an explicit user scope", () => {
    expect(parseAnswerBody({ action: "rule", scope: "user" })).toEqual({
      ok: true,
      action: "rule",
      scope: "user",
    });
  });

  // A typo must narrow to the safer scope, never widen to global.
  test("narrows an unknown scope to project", () => {
    expect(parseAnswerBody({ action: "rule", scope: "everywhere" })).toEqual({
      ok: true,
      action: "rule",
      scope: "project",
    });
  });

  test("rejects an unknown or missing action", () => {
    for (const body of [{}, { action: "allow" }, { action: 1 }, null, "once", []]) {
      expect(parseAnswerBody(body)).toEqual({ ok: false });
    }
  });
});

describe("DcgWatcher", () => {
  test("notifies once per new block, not on every poll", async () => {
    await publish("abc123");
    const seen: DcgPending[] = [];
    const watcher = new DcgWatcher(approvals, (p) => seen.push(p));

    await watcher.poll(LATER);
    await watcher.poll(LATER);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe("abc123");
  });

  test("notifies for a second, later block", async () => {
    await publish("first");
    const seen: string[] = [];
    const watcher = new DcgWatcher(approvals, (p) => seen.push(p.id));
    await watcher.poll(LATER);
    await publish("second");
    await watcher.poll(LATER);
    expect(seen).toEqual(["first", "second"]);
  });

  // Muted is not the same as unseen: flipping the pref back on must not replay old blocks.
  test("stays silent while muted and does not replay afterwards", async () => {
    await publish("abc123");
    const seen: string[] = [];
    let on = false;
    const watcher = new DcgWatcher(
      approvals,
      (p) => seen.push(p.id),
      () => on,
    );
    await watcher.poll(LATER);
    expect(seen).toEqual([]);
    on = true;
    await watcher.poll(LATER);
    expect(seen).toEqual([]);
  });

  test("a re-published id can alert again once the first is resolved", async () => {
    await publish("abc123");
    const seen: string[] = [];
    const watcher = new DcgWatcher(approvals, (p) => seen.push(p.id));
    await watcher.poll(LATER);
    await rm(join(dir, "abc123.json"), { force: true }); // guard cleaned up
    await watcher.poll(LATER); // forgets the id
    await publish("abc123");
    await watcher.poll(LATER);
    expect(seen).toEqual(["abc123", "abc123"]);
  });

  test("never alerts for an expired block", async () => {
    await publish("abc123");
    const seen: string[] = [];
    const watcher = new DcgWatcher(approvals, (p) => seen.push(p.id));
    await watcher.poll(AFTER_EXPIRY);
    expect(seen).toEqual([]);
  });
});
