import type { AgentStatus } from "./types.ts";
import { decodeReplyLine } from "./wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Herdr adapter. THIS IS THE ONLY FILE that knows Herdr's method names and
// wire shapes. Everything else talks to the typed methods below, so a Herdr API
// change is a one-file fix. Protocol facts are documented in HERDR_API.md.
//
// TRANSPORT — WHY THIS SPAWNS THE CLI INSTEAD OF OPENING THE SOCKET:
// On Windows, Herdr does NOT expose a filesystem AF_UNIX socket. It uses the Rust
// `interprocess` crate, which maps the socket path onto a Windows *named pipe*
// (`\\.\pipe\<path>`) guarded by an in-crate handshake. Bun's `Bun.connect({unix})`
// targets native AF_UNIX and can't reach a named pipe at all; even a pipe-aware raw
// client (Node net / .NET NamedPipeClientStream) gets the connection accepted and
// then immediately EOF'd, because it doesn't speak the crate's handshake. Verified
// empirically 2026-07-13. So the ONLY reliable local client for that pipe is the
// same-version `herdr` binary itself — which exposes every method Collie needs as a
// CLI subcommand and emits the identical JSON envelopes. We shell out to it.
//
// The upstream (macOS/Linux) transport was a one-shot Unix socket per request. This
// keeps the same one-request-per-invocation shape: one process spawn per RPC.
// `events.subscribe` has no CLI equivalent, so it degrades to a poll-only fallback
// (see subscribeEvents) — StateEngine already treats events as a mere poke, never a
// source of truth, so correctness is unaffected; only the poke latency changes.
// ─────────────────────────────────────────────────────────────────────────────

/** Raw wire shape of a workspace from `workspace.list`. */
interface WireWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

/** Raw wire shape of a tab from `tab.list`. */
interface WireTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

/** Raw wire shape of a pane from `pane.list` (and, identically, inside `session.snapshot`). */
interface WirePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd?: string;
  agent?: string | null;
  agent_status: AgentStatus;
  /** User-set pane label (herdr `pane.rename`). Present only once set — the key disappears when
   *  cleared with `label: null`, so absent/null both read as "no label". */
  label?: string | null;
  revision: number;
  /** Scroll position (herdr ≥ 0.7.2); optional so older servers that omit it still typecheck. Unused for now. */
  scroll?: {
    offset_from_bottom: number;
    max_offset_from_bottom: number;
    viewport_rows: number;
  } | null;
}

/**
 * Raw shape of `session.snapshot` — the whole herd in one reply, superseding the three parallel
 * list calls. `agents`/`layouts`/`focused_*` are carried too but intentionally unused: agents stay
 * derived from `panes` so there's one code path. Older servers predate the method (see StateEngine).
 */
export interface WireSnapshot {
  version: string;
  protocol: number;
  workspaces: WireWorkspace[];
  tabs: WireTab[];
  panes: WirePane[];
}

/** The freshly-created shell pane returned by tab.create / workspace.create (`root_pane`). */
export interface CreatedShell {
  paneId: string;
  workspaceId: string;
  workspaceLabel?: string;
  tabId: string;
  cwd: string;
}

export interface PaneRead {
  pane_id: string;
  text: string;
  truncated: boolean;
  revision: number;
}

type ReadSource = "visible" | "recent" | "recent-unwrapped";
type ReadFormat = "text" | "ansi";

/** Outcome of one `herdr` CLI invocation: captured stdout/stderr and the process exit code. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Transient Windows named-pipe drop. Herdr's `interprocess` pipe server occasionally accepts then
 * resets a connection under concurrent load — its own CLI hits it too. Matched on the CLI's error
 * text so {@link HerdrClient.runRetry} can retry a read-only call once instead of failing the tick.
 */
function isTransientPipeError(r: CliResult): boolean {
  const s = r.stderr;
  return (
    r.code !== 0 &&
    (s.includes("BrokenPipe") ||
      s.includes("being closed") ||
      s.includes("The pipe is being closed") ||
      s.includes("kind: BrokenPipe"))
  );
}

export class HerdrClient {
  /**
   * @param socketPath  Herdr's control socket/pipe path. Passed to every CLI call via
   *                    `HERDR_SOCKET_PATH` so a multi-session bridge targets the right herd.
   * @param herdrBin    Absolute path to `herdr` (or `herdr.exe`). Resolved once in config.
   * @param timeoutMs   Per-invocation wall-clock budget; a hung CLI is killed and the call rejects.
   */
  constructor(
    private readonly socketPath: string,
    private readonly herdrBin: string,
    private readonly timeoutMs = 5000,
  ) {}

  /** Spawn `herdr <args>` with the session's socket in the env, capturing stdout/stderr/exit. */
  private async run(args: string[]): Promise<CliResult> {
    const proc = Bun.spawn([this.herdrBin, ...args], {
      // Target THIS session's herd. Everything else inherits so the CLI finds its config/channel.
      env: { ...process.env, HERDR_SOCKET_PATH: this.socketPath },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    // Kill a hung CLI so a wedged pipe can't stall a poll tick forever (mirrors the old socket timeout).
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, this.timeoutMs);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(killer);
    }
  }

  /**
   * Run a read-only CLI call, retrying ONCE on a transient pipe drop. Only safe for idempotent
   * reads (list/snapshot/read) — never for send/create/close, where a retry could double-apply.
   */
  private async runRetry(args: string[]): Promise<CliResult> {
    const first = await this.run(args);
    if (isTransientPipeError(first)) return this.run(args);
    return first;
  }

  /**
   * Turn a CLI result into the `result` payload of a full `{"id","result":{...}}` envelope, or throw
   * a descriptive Error. `list`/`snapshot`/`create`/`close` all print that envelope on stdout (exit
   * 0) and an `{"error":{code,message}}` envelope OR a plain `Error: ...` transport line on stderr
   * (exit ≠ 0). `method` only decorates the message and drives the `unknown variant` fallback that
   * StateEngine keys on.
   */
  private envelope<T>(r: CliResult, method: string): T {
    if (r.code === 0 && r.stdout.trim()) {
      return decodeReplyLine<T>(r.stdout.trim(), method);
    }
    throw new Error(`herdr ${method}: ${this.errText(r)}`);
  }

  /** Best-effort human-readable failure text from a CLI result (error-envelope message, else raw stderr). */
  private errText(r: CliResult): string {
    const raw = (r.stderr || r.stdout).trim();
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string }; code?: string; message?: string };
      const err = parsed.error ?? parsed;
      if (err && (err.code || err.message)) return `${err.code ?? "error"}: ${err.message ?? ""}`.trim();
    } catch {
      /* not JSON — fall through to raw */
    }
    return raw || `exited ${r.code}`;
  }

  /** A write/create/close call: exit 0 = success; otherwise throw the decoded error. No retry (not idempotent). */
  private async runVoid(args: string[], method: string): Promise<void> {
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`herdr ${method}: ${this.errText(r)}`);
  }

  async listWorkspaces(): Promise<WireWorkspace[]> {
    const r = await this.runRetry(["workspace", "list"]);
    return this.envelope<{ workspaces: WireWorkspace[] }>(r, "workspace.list").workspaces;
  }

  async listPanes(): Promise<WirePane[]> {
    const r = await this.runRetry(["pane", "list"]);
    return this.envelope<{ panes: WirePane[] }>(r, "pane.list").panes;
  }

  /** All tabs across every workspace (`tab list` with no filter returns the full set). */
  async listTabs(): Promise<WireTab[]> {
    const r = await this.runRetry(["tab", "list"]);
    return this.envelope<{ tabs: WireTab[] }>(r, "tab.list").tabs;
  }

  /**
   * The whole herd in one round-trip (`herdr api snapshot`). Replaces the three list calls for the
   * poll loop. An older server without the method rejects it; the CLI surfaces that as an "unknown
   * variant" error, which StateEngine treats as a permanent signal to fall back to the list calls.
   */
  async sessionSnapshot(): Promise<WireSnapshot> {
    const r = await this.runRetry(["api", "snapshot"]);
    return this.envelope<{ type: string; snapshot: WireSnapshot }>(r, "session.snapshot").snapshot;
  }

  /**
   * No streaming transport exists over the CLI, so there is no live event stream on Windows. Report
   * "down" immediately and idempotently; EventPoker then keeps the engine on the fast poll cadence
   * (COLLIE_POLL_MS) and periodically retries this — a harmless, cheap no-op each time. Events were
   * only ever a poke (StateEngine polls as the source of truth), so this costs poke latency, not
   * correctness. `onUp`/`onEvent` are intentionally never called.
   */
  subscribeEvents(opts: {
    subscriptions: Array<{ type: string; pane_id?: string }>;
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string) => void;
  }): { close(): void } {
    // Fire onDown on a microtask (not synchronously) so EventPoker finishes assigning `this.stream`
    // before its onDown guard runs — matching how the old async socket connect reported failure.
    queueMicrotask(() => opts.onDown("no event stream on windows (cli transport) — polling"));
    return { close: () => {} };
  }

  /**
   * Create a new tab in a workspace, opening a fresh shell pane. `cwd` optional — omitted, the tab
   * inherits the workspace's directory. `--no-focus` so we never yank the desktop TUI's focus.
   */
  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    const args = ["tab", "create", "--workspace", workspaceId, "--no-focus"];
    if (opts.label) args.push("--label", opts.label);
    if (opts.cwd) args.push("--cwd", opts.cwd);
    const r = await this.run(args);
    const p = this.envelope<{ root_pane: WirePane }>(r, "tab.create").root_pane;
    return { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, cwd: p.cwd };
  }

  /**
   * Create a new workspace ("space") with a fresh shell pane rooted at `cwd`. `--no-focus` to leave
   * the desktop TUI undisturbed. Returns the new shell pane (with its workspace label).
   */
  async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
    const args = ["workspace", "create", "--cwd", opts.cwd, "--no-focus"];
    if (opts.label) args.push("--label", opts.label);
    const r = await this.run(args);
    const decoded = this.envelope<{ workspace: WireWorkspace; root_pane: WirePane }>(r, "workspace.create");
    const p = decoded.root_pane;
    return {
      paneId: p.pane_id,
      workspaceId: p.workspace_id,
      workspaceLabel: decoded.workspace.label,
      tabId: p.tab_id,
      cwd: p.cwd,
    };
  }

  /**
   * Read pane scrollback. Unlike the JSON-returning calls, `herdr pane read` prints the pane's RAW
   * TEXT to stdout (with SGR escapes when `format:"ansi"`), not a JSON envelope — so we wrap it into
   * the {@link PaneRead} shape the rest of the bridge expects. `truncated` isn't exposed by the CLI
   * (always false); `revision` is a stub on herdr 0.7.x (always 0 — see HERDR_API.md), so 0 matches
   * what the socket path returned anyway.
   */
  async readPane(
    paneId: string,
    source: ReadSource,
    lines: number,
    format: ReadFormat = "text",
  ): Promise<PaneRead> {
    const r = await this.runRetry([
      "pane",
      "read",
      paneId,
      "--source",
      source,
      "--lines",
      String(lines),
      "--format",
      format,
    ]);
    if (r.code !== 0) throw new Error(`herdr pane.read: ${this.errText(r)}`);
    return { pane_id: paneId, text: r.stdout, truncated: false, revision: 0 };
  }

  /** Type literal text into a pane's terminal (does not submit). */
  sendPaneText(paneId: string, text: string): Promise<void> {
    return this.runVoid(["pane", "send-text", paneId, text], "pane.send_text");
  }

  /** Send key names (e.g. ["Enter"]) to a pane — used to submit a reply. Each key is a separate arg. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    return this.runVoid(["pane", "send-keys", paneId, ...keys], "pane.send_keys");
  }

  /** Close a pane, terminating its agent ("kill"). */
  closePane(paneId: string): Promise<void> {
    return this.runVoid(["pane", "close", paneId], "pane.close");
  }

  /**
   * Set or clear a pane's label. `label: null` clears it (the key then disappears from pane
   * records). Resolves on Herdr's `pane_info` reply — the returned pane isn't consumed here, the
   * next snapshot poll carries the new label (pane.rename emits no event). Bad id → `pane_not_found`.
   */
  renamePane(paneId: string, label: string | null): Promise<void> {
    const arg = label === null ? "--clear" : label;
    return this.runVoid(["pane", "rename", paneId, arg], "pane.rename");
  }

  /**
   * Set a tab's label. Unlike {@link renamePane}, `label` is a NON-null string: herdr's `tab.rename`
   * rejects `null` (`invalid type: null, expected a string`) and stores an empty string literally
   * rather than clearing to the default number — both live-verified 2026-07-19 — so a tab has no
   * "clear". Resolves on herdr's `tab_info` reply; the new label surfaces on the next snapshot poll
   * (tab.rename also emits a `tab_renamed` event, which Collie doesn't consume). Bad id → `tab_not_found`.
   */
  renameTab(tabId: string, label: string): Promise<void> {
    return this.runVoid(["tab", "rename", tabId, label], "tab.rename");
  }

  /**
   * Close a tab, terminating EVERY pane inside it (live-verified 2026-07-19: the tab's shell/agent
   * panes all disappear with it — closing a tab is a bulk pane-close). Resolves on herdr's
   * `{type:"ok"}` reply; the closure surfaces on the next `session.snapshot` poll (tab.close also
   * emits a `tab_closed` event, which Collie doesn't consume). Bad id → `tab_not_found`.
   */
  closeTab(tabId: string): Promise<void> {
    return this.runVoid(["tab", "close", tabId], "tab.close");
  }

  /** Reachability check for the connected/disconnected banner. */
  async ping(): Promise<boolean> {
    try {
      await this.listWorkspaces();
      return true;
    } catch {
      return false;
    }
  }
}
