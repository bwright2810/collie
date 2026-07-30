import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDcgApprovals } from "@/hooks/use-dcg-approvals";
import type { DcgPending, DcgScope } from "@/lib/api";

// Destructive commands the local dcg guard has blocked, offered here so a block doesn't strand work
// when you're away from the desk. The same block is simultaneously showing a dialog on the host and
// whichever answers first wins, so these cards can vanish on their own — that's the desk answering,
// not a bug.
//
// All four of the guard's actions are exposed, because a phone-only subset would mean walking to the
// desk for the exact recurring blocks that are most worth allowlisting. The two "always" actions are
// visually subordinate and carry the scope choice, since they persist beyond this one command.

/** Seconds left before the guard auto-denies, floored at zero. */
function secondsLeft(pending: DcgPending, now: number): number {
  return Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - now) / 1000));
}

/**
 * Break a command chain into one display line per step, splitting only on `&&`, `||`, and `;` and
 * keeping the operator with the line it ends.
 *
 * Quote-aware, and deliberately conservative about which operators count: splitting on a bare `|` or
 * `&` too would tear `2>&1 | tail -3` into meaningless fragments, which misrepresents the very text
 * the user is being asked to approve. Never rewrites the command — only inserts line breaks.
 */
function splitCommandForDisplay(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      out.push((current + pair).trim());
      current = "";
      i++; // consumed both characters
      continue;
    }
    if (ch === ";") {
      out.push((current + ch).trim());
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [command];
}

/** A labelled block: a small caps-ish label over its value. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

export function DcgApprovals({ className }: { className?: string }) {
  const { pending, answering, answer } = useDcgApprovals();
  const [now, setNow] = useState(() => Date.now());

  // Drive the countdown only while something is actually pending — no idle timer on the normal path.
  useEffect(() => {
    if (pending.length === 0) return;
    const handle = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(handle);
  }, [pending.length]);

  if (pending.length === 0) return null;

  return (
    <section className={className} aria-label="Destructive command approvals">
      {pending.map((p) => (
        <ApprovalCard
          key={p.id}
          pending={p}
          secondsLeft={secondsLeft(p, now)}
          busy={answering === p.id}
          onAnswer={(action, scope) => void answer(p.id, action, scope)}
        />
      ))}
    </section>
  );
}

function ApprovalCard({
  pending,
  secondsLeft,
  busy,
  onAnswer,
}: {
  pending: DcgPending;
  secondsLeft: number;
  busy: boolean;
  onAnswer: (action: "deny" | "once" | "rule" | "command", scope: DcgScope) => void;
}) {
  // Default to the narrower scope: an "always allow" chosen in a hurry on a phone should not silently
  // become a global rule.
  const [scope, setScope] = useState<DcgScope>("project");
  const [showAlways, setShowAlways] = useState(false);

  return (
    <Card className="mb-3 gap-0 border-destructive/50 py-0">
      <div className="flex items-start gap-3 p-4">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Destructive command blocked</div>
          <p className="mt-0.5 font-mono text-xs break-all text-muted-foreground">
            {pending.ruleId}
          </p>
        </div>
        <span
          className={`shrink-0 text-xs tabular-nums ${
            secondsLeft <= 30 ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {secondsLeft}s
        </span>
      </div>

      {/* Labelled sections rather than one blob: on a phone the decision is "what does this do, where,
          and what exactly runs", and a wrapped slab of prose buries all three. Ordered accordingly,
          with the guard's lower-value lines kept at the bottom rather than dropped. Every value is a
          text node, never markup — the same XSS boundary the pane output holds to. */}
      <div className="space-y-3 border-t border-border/60 px-4 py-3">
        {pending.reason && (
          <Field label="Why blocked">
            <p className="text-xs">{pending.reason}</p>
          </Field>
        )}
        {pending.cwd && (
          <Field label="Working directory">
            <p className="font-mono text-[11px] break-all">{pending.cwd}</p>
          </Field>
        )}
        <Field label="Command">
          {/* One step per line, so a long `&&` chain reads as the sequence it is. */}
          {splitCommandForDisplay(pending.command).map((step, i) => (
            <pre
              key={i}
              className="overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all"
            >
              {step}
            </pre>
          ))}
        </Field>
        {pending.detail && (
          <Field label="Detail">
            <p className="text-[11px] text-muted-foreground">{pending.detail}</p>
          </Field>
        )}
        {pending.extra?.map((x, i) => (
          <p key={i} className="text-[11px] text-muted-foreground">
            {x}
          </p>
        ))}
        {pending.guidance && (
          <p className="text-[11px] text-muted-foreground italic">{pending.guidance}</p>
        )}
      </div>

      <div className="flex gap-2 border-t border-border/60 p-3">
        <Button
          variant="destructive"
          className="flex-1"
          disabled={busy}
          onClick={() => onAnswer("deny", scope)}
        >
          Deny
        </Button>
        <Button
          variant="default"
          className="flex-1"
          disabled={busy}
          onClick={() => onAnswer("once", scope)}
        >
          Allow once
        </Button>
      </div>

      {/* The persisting choices sit behind a disclosure: they outlive this command, so they should
          take one more deliberate tap than allow-once. */}
      {!showAlways ? (
        <div className="border-t border-border/60 px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            disabled={busy}
            onClick={() => setShowAlways(true)}
          >
            Always allow&hellip;
          </Button>
        </div>
      ) : (
        <div className="border-t border-border/60 p-3">
          <div
            className="mb-2 flex gap-2"
            role="radiogroup"
            aria-label="Scope for always-allow"
          >
            {(["project", "user"] as const).map((s) => (
              <Button
                key={s}
                variant={scope === s ? "secondary" : "outline"}
                size="sm"
                className="flex-1"
                role="radio"
                aria-checked={scope === s}
                disabled={busy}
                onClick={() => setScope(s)}
              >
                {s === "project" ? "This project" : "Everywhere"}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={() => onAnswer("rule", scope)}
            >
              This rule
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={() => onAnswer("command", scope)}
            >
              This exact command
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
