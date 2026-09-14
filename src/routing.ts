/**
 * Provider routing. `ordered` follows the configured list verbatim
 * (predictable). `smart` keeps the configured priority as the tie-breaker but
 * demotes providers that are on cooldown or have been failing recently, and
 * skips ones known to be unusable. Deterministic: no clocks, no randomness.
 */
export interface RoutingInput {
  configured: string[];
  available: Set<string>;
  states: Map<string, string>;
  failures: Map<string, number>;
  mode: "ordered" | "smart";
}

export interface RouteDecision {
  id: string;
  score: number;
  reason: string;
}

const STATE_SCORE: Record<string, number> = {
  READY: 50,
  ACTIVE: 20,
  COOLDOWN: -60,
  AUTH_REQUIRED: -80,
  FAILED: -200,
  EXHAUSTED: -1000,
  UNAVAILABLE: -1000,
};

export function planRoute(input: RoutingInput): RouteDecision[] {
  const usable = input.configured.filter((id) => input.available.has(id));
  if (input.mode === "ordered") {
    return usable.map((id, i) => ({ id, score: usable.length - i, reason: "configured order" }));
  }

  const scored: RouteDecision[] = usable.map((id, i) => {
    // Priority is a tie-breaker, not the driver: health and recent failures
    // must be able to demote a top-listed provider that keeps breaking.
    const priority = (usable.length - i) * 10;
    const state = input.states.get(id) ?? "READY";
    const stateBonus = STATE_SCORE[state] ?? 0;
    const failures = input.failures.get(id) ?? 0;
    const score = priority + stateBonus - failures * 25;
    const reasons = ["configured priority", `state=${state}`];
    if (failures > 0) reasons.push(`${failures} recent failure(s)`);
    return { id, score, reason: reasons.join(", ") };
  });

  const healthy = scored.filter((d) => (input.states.get(d.id) ?? "READY") !== "EXHAUSTED" && (input.states.get(d.id) ?? "READY") !== "UNAVAILABLE");
  const chosen = healthy.length > 0 ? healthy : scored;
  chosen.sort((a, b) => b.score - a.score || usable.indexOf(a.id) - usable.indexOf(b.id));
  return chosen;
}
