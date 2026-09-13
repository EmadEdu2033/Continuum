import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

export interface ContinuumConfig {
  version: number;
  project: { name: string };
  routing: { mode: "ordered"; order: string[] };
  providers?: Partial<Record<string, { model?: string }>>;
  failover: {
    quota_exhausted: boolean;
    provider_unavailable: boolean;
    temporary_rate_limit: { retry: boolean; max_attempts: number };
    auth_required: { pause: boolean };
  };
  context: {
    auto_checkpoint: boolean;
    checkpoint_interval_minutes: number;
    max_handoff_tokens: number;
  };
  memory: { decisions: boolean; constraints: boolean; tasks: boolean; errors: boolean };
  workspace: { writer_lock: boolean };
}

export function defaultConfig(projectName: string): ContinuumConfig {
  return {
    version: 1,
    project: { name: projectName },
    routing: {
      mode: "ordered",
      order: ["codex", "claude", "opencode", "antigravity"],
    },
    failover: {
      quota_exhausted: true,
      provider_unavailable: true,
      temporary_rate_limit: { retry: true, max_attempts: 3 },
      auth_required: { pause: true },
    },
    context: {
      auto_checkpoint: true,
      checkpoint_interval_minutes: 5,
      max_handoff_tokens: 12000,
    },
    memory: { decisions: true, constraints: true, tasks: true, errors: true },
    workspace: { writer_lock: true },
  };
}

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, ".continuum", "config.yaml");
}

export function loadConfig(projectRoot: string): ContinuumConfig {
  const file = configPath(projectRoot);
  if (!fs.existsSync(file)) {
    return defaultConfig(path.basename(projectRoot));
  }
  const parsed = parse(fs.readFileSync(file, "utf8"));
  const merged = { ...defaultConfig(path.basename(projectRoot)), ...parsed };
  if (parsed.providers) {
    merged.providers = { ...merged.providers, ...parsed.providers };
  }
  return merged;
}

export function writeConfig(projectRoot: string, config: ContinuumConfig) {
  fs.mkdirSync(path.join(projectRoot, ".continuum"), { recursive: true });
  fs.writeFileSync(configPath(projectRoot), stringifyConfig(config), "utf8");
}

function stringifyConfig(config: ContinuumConfig): string {
  // Simple ordered serializer; avoids adding a yaml serializer dependency.
  const providers = config.providers
    ? Object.entries(config.providers)
        .filter(
          (entry): entry is [string, { model?: string }] =>
            entry[1] !== undefined && (entry[1].model ?? "").length > 0
        )
        .map(([id, v]) => `  ${id}:\n    model: ${v.model}`)
        .join("\n")
    : "";
  return `version: ${config.version}
project:
  name: ${config.project.name}
routing:
  mode: ${config.routing.mode}
  order:
${config.routing.order.map((p) => `    - ${p}`).join("\n")}
${providers ? `providers:\n${providers}\n` : ""}failover:
  quota_exhausted: ${config.failover.quota_exhausted}
  provider_unavailable: ${config.failover.provider_unavailable}
  temporary_rate_limit:
    retry: ${config.failover.temporary_rate_limit.retry}
    max_attempts: ${config.failover.temporary_rate_limit.max_attempts}
  auth_required:
    pause: ${config.failover.auth_required.pause}
context:
  auto_checkpoint: ${config.context.auto_checkpoint}
  checkpoint_interval_minutes: ${config.context.checkpoint_interval_minutes}
  max_handoff_tokens: ${config.context.max_handoff_tokens}
memory:
  decisions: ${config.memory.decisions}
  constraints: ${config.memory.constraints}
  tasks: ${config.memory.tasks}
  errors: ${config.memory.errors}
workspace:
  writer_lock: ${config.workspace.writer_lock}
`;
}
