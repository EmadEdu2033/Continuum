import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter } from "./types.js";
import type { ContinuumConfig } from "../config.js";
import { OpenCodeAdapter } from "./opencode.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeAdapter } from "./claude.js";
import { AntigravityAdapter } from "./antigravity.js";
import { MockProvider, type MockProviderConfig } from "./mock.js";

export interface RegistryOptions {
  /** Real CLIs when installed; otherwise the provider is skipped at run time. */
  real: boolean;
}

/** Builds the adapter map for the configured routing order. */
export function buildAdapters(
  root: string,
  config: ContinuumConfig,
  opts: RegistryOptions
): Map<string, AgentAdapter> {
  const adapters = new Map<string, AgentAdapter>();
  const models = config.providers ?? {};

  if (opts.real) {
    for (const id of config.routing.order) {
      switch (id) {
        case "opencode":
          adapters.set(id, new OpenCodeAdapter({ model: models.opencode?.model }));
          break;
        case "codex":
          adapters.set(id, new CodexAdapter({ model: models.codex?.model }));
          break;
        case "claude":
          adapters.set(id, new ClaudeAdapter({ model: models.claude?.model }));
          break;
        case "antigravity":
          adapters.set(id, new AntigravityAdapter({ model: models.antigravity?.model }));
          break;
        default: {
          // Unknown id: fall back to a mock script if one is defined, else skip.
          const script = loadMockConfig(root).find((m) => m.id === id);
          if (script) adapters.set(id, new MockProvider(script));
          break;
        }
      }
    }
    return adapters;
  }

  // Mock mode (tests / offline demos). Only providers with an explicit mock
  // script participate — an unscripted mock that "completes" tasks while
  // doing nothing would fake success.
  const mockConfigs = loadMockConfig(root);
  for (const id of config.routing.order) {
    const found = mockConfigs.find((m) => m.id === id);
    if (found) adapters.set(id, new MockProvider(found));
  }
  return adapters;
}

function loadMockConfig(root: string): MockProviderConfig[] {
  const file = path.join(root, ".continuum", "mock-providers.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as MockProviderConfig[];
}
