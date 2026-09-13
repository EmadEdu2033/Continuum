import type { NormalizedError } from "./types.js";

/**
 * Turns arbitrary provider failure text into Continuum's normalized errors.
 * Each adapter feeds CLI stderr / JSON error events through this so the
 * supervisor never sees provider-specific wording.
 */
export function classifyError(text: string): NormalizedError {
  const t = (text || "").toLowerCase();

  // Quota before rate limit: "usage limit reached" is a quota wall, while
  // "rate limit exceeded, retry in 20s" is transient.
  if (/(usage|token|weekly|daily|5h|monthly) limit|quota|exhausted|out of credits|insufficient (credits|balance)|credit balance|billing|upgrade to (a )?(pro|plus)|plan limit/.test(t)) {
    return "QUOTA_EXHAUSTED";
  }
  if (/rate limit|too many requests|\b429\b|temporar|backoff|try again in/.test(t)) {
    return "TEMP_RATE_LIMIT";
  }
  if (/not (logged in|authenticated)|login required|please (log ?in|run .*login)|invalid api key|api key|unauthorized|\b401\b|forbidden|\b403\b|credentials/.test(t)) {
    return "AUTH_REQUIRED";
  }
  if (/context (window|length|is full|exceeded)|maximum context|prompt is too long|too many tokens|context limit|reduce the (length|size) of/.test(t)) {
    return "CONTEXT_EXHAUSTED";
  }
  if (/permission denied|access is denied|sandbox|operation not permitted|eacces|eparm|write access/.test(t)) {
    return "PERMISSION_REQUIRED";
  }
  if (/cancel|interrupt|abort|sigint|sigterm|\b130\b/.test(t)) {
    return "USER_CANCELLED";
  }
  if (/cannot connect|unable to connect|econnrefused|enotfound|etimedout|econnreset|network|fetch failed|getaddrinfo|tunnel|dns/.test(t)) {
    return "NETWORK_FAILURE";
  }
  if (/provider.*(unavailable|down|offline)|service unavailable|\b503\b|\b500\b|internal server error|bad gateway/.test(t)) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "AGENT_CRASH";
}
