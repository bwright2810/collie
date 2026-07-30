import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { DcgApprovals } from "@/components/dcg-approvals";

// DcgApprovals polls /api/dcg/pending and answers via POST. Driven through MSW: the GET seeds the
// cards, the POST captures the body so we can assert the exact action/scope pair the guard will read.
// The desk dialog races every answer, so the 409/410 paths matter as much as the happy one — both
// must retire the card silently rather than surface an error.

let lastBody: Record<string, unknown> | undefined;
let answerStatus = 200;
let pending: Array<Record<string, unknown>>;

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc123",
    ruleId: "core.filesystem:rm-rf-general",
    command: "rm -rf C:/Projects/thing",
    cwd: "C:\\Projects",
    reason: "rm -rf is destructive",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  lastBody = undefined;
  answerStatus = 200;
  pending = [block()];
  server.use(
    http.get("/api/dcg/pending", () => HttpResponse.json({ pending })),
    http.post("/api/dcg/:id/answer", async ({ request }) => {
      lastBody = (await request.json()) as Record<string, unknown>;
      if (answerStatus !== 200) {
        return HttpResponse.json({ ok: false, error: "claimed" }, { status: answerStatus });
      }
      return HttpResponse.json({ ok: true });
    }),
  );
});

describe("DcgApprovals", () => {
  test("renders nothing when no command is blocked", async () => {
    pending = [];
    const { container } = render(<DcgApprovals />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test("shows the command, cwd, rule, and reason", async () => {
    render(<DcgApprovals />);
    expect(await screen.findByText("rm -rf C:/Projects/thing")).toBeInTheDocument();
    expect(screen.getByText("core.filesystem:rm-rf-general")).toBeInTheDocument();
    expect(screen.getByText(/C:\\Projects/)).toBeInTheDocument();
    expect(screen.getByText("rm -rf is destructive")).toBeInTheDocument();
  });

  test("allow once sends action=once", async () => {
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(lastBody).toEqual({ action: "once", scope: "project" }));
  });

  test("deny sends action=deny", async () => {
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(lastBody).toEqual({ action: "deny", scope: "project" }));
  });

  // All four guard actions must be reachable, or a recurring block still needs a walk to the desk.
  test("exposes both always-allow actions behind the disclosure", async () => {
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: /Always allow/ }));
    await userEvent.click(screen.getByRole("button", { name: "This rule" }));
    await waitFor(() => expect(lastBody).toEqual({ action: "rule", scope: "project" }));
  });

  test("always-allow this exact command sends action=command", async () => {
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: /Always allow/ }));
    await userEvent.click(screen.getByRole("button", { name: "This exact command" }));
    await waitFor(() => expect(lastBody).toEqual({ action: "command", scope: "project" }));
  });

  // A hurried phone tap must not widen an allowlist entry to every project by accident.
  test("scope defaults to project and can be switched to user", async () => {
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: /Always allow/ }));
    expect(screen.getByRole("radio", { name: "This project" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("radio", { name: "Everywhere" }));
    await userEvent.click(screen.getByRole("button", { name: "This rule" }));
    await waitFor(() => expect(lastBody).toEqual({ action: "rule", scope: "user" }));
  });

  test("retires the card after a successful answer", async () => {
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    pending = []; // the guard has cleaned up; the next poll agrees
    await waitFor(() =>
      expect(screen.queryByText("rm -rf C:/Projects/thing")).not.toBeInTheDocument(),
    );
  });

  // Losing the race to the desk dialog is normal, not an error.
  test("retires the card when the desk answered first (409)", async () => {
    answerStatus = 409;
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    pending = [];
    await waitFor(() =>
      expect(screen.queryByText("rm -rf C:/Projects/thing")).not.toBeInTheDocument(),
    );
  });

  test("retires the card when the guard already timed out (410)", async () => {
    answerStatus = 410;
    render(<DcgApprovals />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    pending = [];
    await waitFor(() =>
      expect(screen.queryByText("rm -rf C:/Projects/thing")).not.toBeInTheDocument(),
    );
  });

  // An expired block must not keep offering a decision the guard can no longer honour.
  test("hides a block whose deadline has already passed", async () => {
    pending = [block({ expiresAt: new Date(Date.now() - 1_000).toISOString() })];
    const { container } = render(<DcgApprovals />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
