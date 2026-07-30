import { useCallback, useEffect, useRef, useState } from "react";

import { answerDcg, getDcgPending, isApiErrorStatus, type DcgAction, type DcgPending, type DcgScope } from "@/lib/api";

// Controller for the destructive-command approvals the local dcg guard publishes.
//
// This polls on its own interval rather than riding the router's snapshot revalidation, because a
// block is time-boxed: the guard auto-denies when it expires, so a card that lingers past the
// deadline would offer a decision that can no longer land. Polling here also keeps the feature out
// of the route loaders, so the home screen renders unchanged when nothing is blocked (the normal
// case).
//
// The desk dialog is racing every answer. A 409 (someone else claimed it) or 410 (the guard timed
// out) is therefore an ordinary outcome, not a failure worth showing — both mean "this block is
// settled, refresh".

const POLL_MS = 2_000;

export interface DcgApprovalsState {
  pending: DcgPending[];
  /** Id currently being answered, so the card can disable its buttons. */
  answering: string | null;
  answer(id: string, action: DcgAction, scope: DcgScope): Promise<void>;
}

export function useDcgApprovals(): DcgApprovalsState {
  const [pending, setPending] = useState<DcgPending[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  // Kept in a ref so the poll effect doesn't restart (and reset its timer) on every answer.
  const answeringRef = useRef<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getDcgPending(signal);
      setPending(next);
    } catch {
      // A failed poll is not worth surfacing: the guard is authoritative and will auto-deny on its
      // own deadline whether or not this device can see the block.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    const tick = async () => {
      if (!alive) return;
      // Don't refetch mid-answer — a poll landing between the POST and its response would briefly
      // re-show a card the user just resolved.
      if (answeringRef.current === null) await refresh(controller.signal);
    };

    void tick();
    const handle = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(handle);
    };
  }, [refresh]);

  // Drop a block the moment its deadline passes, so the countdown can't sit at zero offering a
  // decision the guard has already auto-denied.
  useEffect(() => {
    if (pending.length === 0) return;
    const handle = setInterval(() => {
      const now = Date.now();
      setPending((prev) => prev.filter((p) => new Date(p.expiresAt).getTime() > now));
    }, 1_000);
    return () => clearInterval(handle);
  }, [pending.length]);

  const answer = useCallback(
    async (id: string, action: DcgAction, scope: DcgScope) => {
      answeringRef.current = id;
      setAnswering(id);
      try {
        await answerDcg(id, action, scope);
        setPending((prev) => prev.filter((p) => p.id !== id));
      } catch (err) {
        // Lost the race, or the guard already timed out. Either way the block is settled — drop the
        // card rather than reporting an error the user can do nothing about.
        if (isApiErrorStatus(err, 409) || isApiErrorStatus(err, 410) || isApiErrorStatus(err, 404)) {
          setPending((prev) => prev.filter((p) => p.id !== id));
        }
        // Anything else (403, network) leaves the card up so it can be retried.
      } finally {
        answeringRef.current = null;
        setAnswering(null);
      }
    },
    [],
  );

  return { pending, answering, answer };
}
