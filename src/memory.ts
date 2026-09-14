import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store.js";

interface MemoryDoc {
  source: string;
  content: string;
}

/** Gathers durable memory: hand-written files + compacted task summaries. */
export function collectMemoryDocs(store: Store, root: string): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  for (const name of ["project.md", "decisions.md", "constraints.md"]) {
    try {
      const content = fs.readFileSync(path.join(root, ".continuum", name), "utf8").trim();
      if (content) docs.push({ source: name, content });
    } catch {
      /* optional */
    }
  }
  for (const s of store.getAllSummaries()) {
    if (s.text?.trim()) docs.push({ source: `task#${s.task_id}`, content: s.text });
  }
  return docs;
}

/** (Re)builds the searchable index. Returns how many documents were indexed. */
export function indexProjectMemory(store: Store, root: string): number {
  const docs = collectMemoryDocs(store, root);
  store.reindexMemory(docs);
  return docs.length;
}

export function semanticSearch(store: Store, root: string, query: string, limit = 8) {
  indexProjectMemory(store, root);
  return store.searchMemory(query, limit);
}
