import type { SupervisorSnapshot, ProviderView } from "../telemetry.js";
import { c, width, truncate, boxTop, boxBottom, boxRow, BADGE, stateColor, bar } from "./theme.js";

export interface FrameInput {
  snapshot: SupervisorSnapshot;
  providers: ProviderView[];
  logs: string[];
  size: { rows: number; cols: number };
  spinner: number;
  project: string;
  mode: string;
  finished: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Builds one complete dashboard frame. Pure: same input → same output. */
export function renderFrame(input: FrameInput): string {
  const { snapshot: s, providers, logs, size, spinner, project, mode, finished } = input;
  const cols = Math.max(60, size.cols);
  const inner = cols - 2; // inside the outer frame
  const lines: string[] = [];

  lines.push(header(project, mode, cols));
  lines.push(statusStrip(s, inner, spinner, finished));

  const twoCol = cols >= 78;
  if (twoCol) {
    const gap = 2;
    const leftW = Math.floor((inner - gap) * 0.52);
    const rightW = inner - gap - leftW;
    const leftRows = providersPanel(providers, s, leftW);
    const rightRows = contextPanel(s, rightW);
    const height = Math.max(leftRows.length, rightRows.length);
    while (leftRows.length < height) leftRows.push("");
    while (rightRows.length < height) rightRows.push("");
    const left = panel("Providers", leftRows, leftW);
    const right = panel("Context", rightRows, rightW);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      lines.push((left[i] ?? " ".repeat(leftW + 2)) + "  " + (right[i] ?? ""));
    }
  } else {
    lines.push(...panel("Providers", providersPanel(providers, s, inner), inner));
    lines.push(...panel("Context", contextPanel(s, inner), inner));
  }

  lines.push(...panel("Handoff chain", chainLine(s, inner), inner));

  const used = lines.length + 3; // + log panel borders + footer
  const logHeight = Math.max(3, size.rows - used - 1);
  lines.push(...panel("Live", logBox(logs, inner, logHeight), inner));

  lines.push(footer(statusLabel(s), cols));
  return lines.slice(0, size.rows).map((l) => l + "\x1b[K").join("\n");
}

function statusLabel(s: SupervisorSnapshot): string {
  switch (s.status) {
    case "completed":
      return "completed";
    case "exhausted":
      return "paused / exhausted";
    case "paused":
      return "paused";
    case "running":
      return "running";
    default:
      return "idle";
  }
}

function header(project: string, mode: string, cols: number): string {
  const left = `${c.bold}${c.violet}CONTINUUM${c.reset} ${c.dim}· continuity runtime${c.reset}`;
  const right = `${c.white}${truncate(project, 28)}${c.reset} ${c.gray}[${mode}]${c.reset}`;
  const pad = Math.max(1, cols - 2 - width(left) - width(right));
  return `${c.gray}┌─${c.reset} ${left}${" ".repeat(pad)}${right} ${c.gray}─┐${c.reset}`;
}

function statusStrip(s: SupervisorSnapshot, inner: number, spinner: number, finished: boolean): string {
  const spin = finished ? (s.status === "completed" ? `${c.green}✔${c.reset}` : `${c.red}✖${c.reset}`) : `${c.cyan}${SPINNER[spinner % SPINNER.length]}${c.reset}`;
  const agent = s.providerId ? `${stateColor("ACTIVE")}${s.providerId}${c.reset}` : `${c.gray}(none yet)${c.reset}`;
  const step = `${c.gray}step${c.reset} ${Math.min(s.index + 1, s.order.length)}/${s.order.length}`;
  const runMs = Date.now() - s.startedAt;
  const activeMs = s.activeSince ? Date.now() - s.activeSince : 0;
  const clock = `${c.gray}run${c.reset} ${c.white}${elapsed(runMs)}${c.reset}`;
  const active = s.status === "running" ? ` ${c.gray}active${c.reset} ${c.white}${elapsed(activeMs)}${c.reset}` : "";
  const facts = `${c.gray}files${c.reset} ${s.filesTouched}  ${c.gray}cmds${c.reset} ${s.commandsRun}  ${c.gray}caps${c.reset} ${s.handoffCount}`;
  const left = ` ${spin} ${agent} ${step} ${clock}${active}`;
  const right = `${facts} `;
  const pad = Math.max(1, inner - 2 - width(left) - width(right));
  return `${c.gray}│${c.reset}${left}${" ".repeat(pad)}${right}${c.gray}│${c.reset}`;
}

function providersPanel(providers: ProviderView[], s: SupervisorSnapshot, w: number): string[] {
  const rows: string[] = [];
  for (const p of providers) {
    const active = p.id === s.providerId && s.status === "running";
    const state = active ? "ACTIVE" : p.state;
    const badge = BADGE[state] ?? `${c.gray}○${c.reset}`;
    const name = pad3(p.id, 12);
    const label = `${stateColor(state)}${state}${c.reset}`;
    const tail = active ? `${c.cyan}◀ writing${c.reset}` : "";
    rows.push(`${badge} ${name} ${label} ${tail}`);
  }
  if (providers.length === 0) rows.push(`${c.gray}(no providers registered)${c.reset}`);
  return rows;
}

function contextPanel(s: SupervisorSnapshot, w: number): string[] {
  const rows: string[] = [];
  rows.push(`${c.gray}Task${c.reset}       ${truncate(s.task || "(none)", Math.max(10, w - 14))}`);
  const phases = s.order.length || 1;
  const ratio = s.status === "completed" ? 1 : s.index / phases;
  rows.push(`${c.gray}Progress${c.reset}   ${bar(ratio, Math.max(8, w - 22))} ${c.white}${Math.round(ratio * 100)}%${c.reset}`);
  rows.push(`${c.gray}Checkpoint${c.reset} ${s.checkpointId ? `${c.cyan}#${s.checkpointId}${c.reset}` : `${c.gray}(none)${c.reset}`}`);
  if (s.lastError) {
    rows.push(`${c.red}${s.lastError.code}${c.reset}`);
    rows.push(`${c.gray}${truncate(s.lastError.message, Math.max(10, w - 2))}${c.reset}`);
  }
  return rows;
}

function chainLine(s: SupervisorSnapshot, w: number): string[] {
  const parts: string[] = [];
  s.order.forEach((id, i) => {
    const here = i === s.index;
    const done = i < s.index;
    const color = here ? c.cyan : done ? c.green : c.gray;
    parts.push(`${color}${id}${c.reset}`);
  });
  const arrows = s.order.length ? s.order.length - 1 : 0;
  const rendered: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    rendered.push(parts[i]);
    if (i < arrows) rendered.push(`${c.gray}→${c.reset}`);
  }
  return [truncate(" " + rendered.join(" "), w)];
}

function logBox(logs: string[], w: number, h: number): string[] {
  const slice = logs.slice(-h);
  const rows = slice.map((l) => `${c.gray}${truncate(l, w - 2)}${c.reset}`);
  while (rows.length < h) rows.push("");
  return rows;
}

function footer(label: string, cols: number): string {
  const keys = `${c.gray}q${c.reset} quit  ${c.gray}s${c.reset} switch  ${c.gray}h${c.reset} handoff  ${c.gray}c${c.reset} checkpoint`;
  const left = ` ${keys}`;
  const right = `${c.gray}${label}${c.reset} `;
  const pad = Math.max(1, cols - 2 - width(left) - width(right));
  return `${c.gray}└─${c.reset}${left}${" ".repeat(pad)}${right}${c.gray}─┘${c.reset}`;
}

function panel(title: string, rows: string[], w: number): string[] {
  const out = [boxTop(title, w)];
  for (const r of rows) out.push(boxRow(r, w));
  out.push(boxBottom(w));
  return out;
}

function pad3(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}
