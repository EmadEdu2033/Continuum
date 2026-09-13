import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store.js";

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Pathspec that keeps Continuum's own state out of captured diffs. */
const EXCLUDE_SELF = ["--", ".", ":(exclude).continuum"];

function listChangedFiles(cwd: string): string[] {
  const status = git(["status", "--porcelain", ...EXCLUDE_SELF], cwd);
  if (!status) return [];
  return status
    .split("\n")
    .filter((l) => l.trim().length >= 4)
    .map((l) => l.slice(3).trim());
}

export interface CheckpointResult {
  id: number;
  gitStatus: string | null;
  gitDiff: string | null;
  filesChanged: string[];
}

/** Captures repository state and records a checkpoint. */
export function createCheckpoint(store: Store, cwd: string, providerId: string): CheckpointResult {
  const gitStatus = git(["status", "--porcelain", ...EXCLUDE_SELF], cwd);
  const gitDiff = git(["diff"], cwd);
  const filesChanged = listChangedFiles(cwd);

  const id = store.saveCheckpoint(providerId, gitStatus ?? "", gitDiff ?? "", filesChanged);

  fs.writeFileSync(
    path.join(store.checkpointsDir, `${String(id).padStart(4, "0")}.json`),
    JSON.stringify({ id, providerId, gitStatus, gitDiff, filesChanged, createdAt: new Date().toISOString() }, null, 2),
    "utf8"
  );

  return { id, gitStatus, gitDiff, filesChanged };
}
