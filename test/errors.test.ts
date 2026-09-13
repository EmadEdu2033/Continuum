import { describe, it, expect } from "vitest";
import { classifyError } from "../src/errors.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { CodexAdapter } from "../src/adapters/codex.js";

describe("error classifier", () => {
  it("classifies real-world provider failures", () => {
    // Captured verbatim from a real opencode run (broken tunnel).
    expect(
      classifyError(
        "APIError Cannot connect to API: Unable to connect. Is the computer able to access the url?"
      )
    ).toBe("NETWORK_FAILURE");

    // Typical codex / claude quota wording.
    expect(classifyError("You've hit your usage limit. Your limit will reset at 5pm.")).toBe(
      "QUOTA_EXHAUSTED"
    );
    expect(classifyError("Claude usage limit reached. Weekly limit will reset soon.")).toBe(
      "QUOTA_EXHAUSTED"
    );
    expect(classifyError("You're out of credits. Add credits to continue.")).toBe("QUOTA_EXHAUSTED");

    // Transient rate limits.
    expect(classifyError("429 rate limit exceeded, retry in 20s")).toBe("TEMP_RATE_LIMIT");
    expect(classifyError("Too many requests, please slow down")).toBe("TEMP_RATE_LIMIT");

    // Auth.
    expect(classifyError("Not logged in. Please run `claude login` first.")).toBe("AUTH_REQUIRED");
    expect(classifyError("Invalid API key provided")).toBe("AUTH_REQUIRED");

    // Context window.
    expect(classifyError("prompt is too long: 250000 tokens > 200000 maximum context window")).toBe(
      "CONTEXT_EXHAUSTED"
    );

    // Permissions.
    expect(classifyError("Permission denied writing to /etc/hosts")).toBe("PERMISSION_REQUIRED");

    // Cancellation.
    expect(classifyError("Operation cancelled by user (SIGINT)")).toBe("USER_CANCELLED");

    // Fallback.
    expect(classifyError("something completely inexplicable happened")).toBe("AGENT_CRASH");
  });

  it("checks quota walls before transient rate limits", () => {
    // Contains both "limit" and "try again" phrasing; quota must win.
    expect(classifyError("usage limit reached. try again after reset")).toBe("QUOTA_EXHAUSTED");
  });
});

describe("adapter normalizeError", () => {
  it("keeps ContinuumError codes and classifies unknown failures", async () => {
    const oc = new OpenCodeAdapter({ spawnOverride: { overrideBin: "true", overrideArgs: [] } });
    expect(oc.normalizeError(Object.assign(new Error("x"), { code: undefined })).code).toBe(
      "AGENT_CRASH"
    );

    const cx = new CodexAdapter({ spawnOverride: { overrideBin: "true", overrideArgs: [] } });
    expect(cx.normalizeError(new Error("boom")).code).toBe("AGENT_CRASH");
  });
});
