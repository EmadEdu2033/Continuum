// Vite/vitest cannot resolve the newer `node:sqlite` builtin at transform
// time; load it through createRequire so the import stays a runtime call.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
