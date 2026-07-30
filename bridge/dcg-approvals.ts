import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Remote answering for the local destructive-command guard (dcg).
//
// dcg runs as a Claude Code PreToolUse hook and blocks destructive commands until a human answers.
// At the desk that answer comes from a WinForms dialog, which is unreachable from a phone. The hook
// therefore also publishes each block as a file here, and both answerers race: whoever CLAIMS the
// block first decides it, and the other is closed.
//
// Why files rather than an RPC: the hook is a short-lived PowerShell process with a hard timeout, so
// it cannot host a socket, and the bridge must not be a hard dependency of the guard — if the bridge
// is down the dialog still works. A directory both sides poll is the only channel with no startup
// ordering requirement.
//
// The claim is the safety-critical part. Exclusive create (`wx`) is the atomic test-and-set: the
// loser gets EEXIST rather than a second win, so one block can never be both denied at the desk and
// allowed from the phone.

/** What the phone may answer. Mirrors the dialog's four actions. */
export type DcgAction = "deny" | "once" | "rule" | "command";
export type DcgScope = "project" | "user";

const ACTIONS: readonly DcgAction[] = ["deny", "once", "rule", "command"];

/** A block awaiting an answer, as published by the hook. */
export interface DcgPending {
  id: string;
  ruleId: string;
  command: string;
  cwd?: string;
  reason?: string;
  createdAt: string;
  expiresAt: string;
  host?: string;
}

export function defaultPendingDir(): string {
  return join(homedir(), ".config", "dcg", "pending");
}

function isPending(v: unknown): v is DcgPending {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.command === "string" &&
    typeof o.expiresAt === "string"
  );
}

/**
 * Parse JSON that may carry a UTF-8 BOM. The publisher is a PowerShell hook, and several of its
 * text-writing cmdlets prepend one, which `JSON.parse` rejects outright.
 */
function parseJsonLoose(raw: string): unknown {
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

/** Reject an id that could escape the pending dir — it is interpolated into a path. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export class DcgApprovals {
  constructor(private readonly dir: string = defaultPendingDir()) {}

  /**
   * Every block still open: published, unexpired, and unclaimed. An expired or claimed request is
   * filtered out rather than deleted — the hook owns its own artifacts and cleans them up when it
   * exits, and deleting them here would race that cleanup.
   */
  async listPending(now = new Date()): Promise<DcgPending[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // no dir yet = the guard has never blocked anything
    }

    const claimed = new Set(
      names.filter((n) => n.endsWith(".lock")).map((n) => n.slice(0, -".lock".length)),
    );
    const answered = new Set(
      names.filter((n) => n.endsWith(".answer")).map((n) => n.slice(0, -".answer".length)),
    );

    const out: DcgPending[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skips .tmp, .lock, .answer
      const id = name.slice(0, -".json".length);
      if (claimed.has(id) || answered.has(id)) continue;
      let parsed: unknown;
      try {
        parsed = parseJsonLoose(await readFile(join(this.dir, name), "utf8"));
      } catch {
        continue; // mid-write or corrupt; the next poll picks it up
      }
      if (!isPending(parsed) || parsed.id !== id) continue;
      if (new Date(parsed.expiresAt).getTime() <= now.getTime()) continue;
      out.push(parsed);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  /**
   * Answer a block on behalf of the phone. Claims first, then writes the answer, so the hook can
   * trust that a claim it lost means an answer is coming. Returns why it failed so the caller can
   * distinguish "someone else got there" (409) from "no such block" (404).
   */
  async answer(
    id: string,
    action: DcgAction,
    scope: DcgScope,
    device: string | null,
    now = new Date(),
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "expired" | "claimed" }> {
    if (!isSafeId(id)) return { ok: false, reason: "not_found" };

    let pending: DcgPending;
    try {
      const parsed: unknown = parseJsonLoose(
        await readFile(join(this.dir, `${id}.json`), "utf8"),
      );
      if (!isPending(parsed)) return { ok: false, reason: "not_found" };
      pending = parsed;
    } catch {
      return { ok: false, reason: "not_found" };
    }
    if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" };
    }

    // Exclusive create — the atomic test-and-set that guarantees a single winner.
    try {
      const handle = await open(join(this.dir, `${id}.lock`), "wx");
      try {
        await handle.writeFile(device ? `phone:${device}` : "phone");
      } finally {
        await handle.close();
      }
    } catch {
      return { ok: false, reason: "claimed" };
    }

    // Write-then-rename so the hook never reads a partial answer and acts on it.
    const finalPath = join(this.dir, `${id}.answer`);
    const tempPath = `${finalPath}.tmp`;
    await writeFile(tempPath, JSON.stringify({ action, scope, device, at: now.toISOString() }));
    await rename(tempPath, finalPath);
    return { ok: true };
  }

  /**
   * Drop artifacts the hook left behind — it cleans up on exit, but a killed hook (machine sleep,
   * session end) can orphan a request that would otherwise be offered to the phone forever.
   */
  async pruneExpired(now = new Date(), graceMs = 60_000): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      let parsed: unknown;
      try {
        parsed = parseJsonLoose(await readFile(join(this.dir, name), "utf8"));
      } catch {
        continue;
      }
      if (!isPending(parsed)) continue;
      if (new Date(parsed.expiresAt).getTime() + graceMs > now.getTime()) continue;
      for (const suffix of [".json", ".answer", ".lock", ".json.tmp", ".answer.tmp"]) {
        await unlink(join(this.dir, `${id}${suffix}`)).catch(() => {});
      }
      removed++;
    }
    return removed;
  }
}

/**
 * Watches for newly-published blocks and fires `notify` once per block.
 *
 * Deliberately NOT modelled on the herd notification coordinator: that one debounces to infer "you're
 * at your desk" and suppress the alert. A dcg block cannot afford that — it auto-denies in minutes, so
 * a delayed push can arrive after the decision window has closed. Alert immediately and let the desk
 * dialog be the thing that resolves it if you are in fact sitting there.
 *
 * Clock- and poll-injected so tests drive it without real timers.
 */
export class DcgWatcher {
  private readonly seen = new Set<string>();

  constructor(
    private readonly approvals: DcgApprovals,
    private readonly notify: (pending: DcgPending) => void,
    private readonly enabled: () => boolean = () => true,
  ) {}

  async poll(now = new Date()): Promise<void> {
    let pending: DcgPending[];
    try {
      pending = await this.approvals.listPending(now);
    } catch {
      return;
    }

    const live = new Set(pending.map((p) => p.id));
    // Forget resolved ids so the set can't grow without bound across a long-lived bridge.
    for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);

    for (const p of pending) {
      if (this.seen.has(p.id)) continue;
      this.seen.add(p.id);
      // Mark as seen even when muted, so toggling the pref back on doesn't replay old blocks.
      if (this.enabled()) this.notify(p);
    }
  }
}

/** Validate an untrusted answer body. Unknown scope narrows to `project` rather than widening. */
export function parseAnswerBody(
  body: unknown,
): { ok: true; action: DcgAction; scope: DcgScope } | { ok: false } {
  if (typeof body !== "object" || body === null) return { ok: false };
  const o = body as Record<string, unknown>;
  const action = o.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as DcgAction)) return { ok: false };
  const scope: DcgScope = o.scope === "user" ? "user" : "project";
  return { ok: true, action: action as DcgAction, scope };
}
