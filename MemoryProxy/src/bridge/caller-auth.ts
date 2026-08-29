/**
 * bridge/caller-auth.ts — caller authentication for bridge endpoints
 * (skill-bridge / memory-bridge).
 *
 * THREAT MODEL (fix/bridge-caller-auth): bridge identity is derived from
 * `x-conversation-id` alone — any actor who learns a live session UUID can
 * reuse its (user_id/team_id/agent_id) identity on another connection. The
 * session UUID travels in prompts, logs and compressed context, so it is NOT
 * a secret. This module adds a per-session proof-of-possession:
 *
 *   Header:  `x-tdai-bridge-auth: <hex>`
 *   Value:   HMAC-SHA256(session_id, key = session user_key)
 *
 * The user_key already lives server-side (session store L1 / binding L2);
 * it never enters the prompt. Verification:
 *   - header PRESENT + valid   → allowed (ids enhanced with caller_auth="verified")
 *   - header PRESENT + invalid → 403 fail-closed (active identity-reuse attempt)
 *   - header ABSENT            → allowed (backward compat) + telemetry
 *                                reject_reason="caller_auth_missing" so
 *                                deployments can measure adoption before
 *                                making it mandatory.
 *
 * Design constraints:
 *   - No new stored state: uses existing userKey on SessionInfo / SessionBinding.
 *   - No dependency: node:crypto HMAC (already used across the codebase).
 *   - Fail-closed only on WRONG proof; missing proof degrades to today's
 *     behavior (rollout safety — flipping to require is one config flag).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const BRIDGE_AUTH_HEADER = "x-tdai-bridge-auth";

export interface CallerAuthSecrets {
  /** session_id the proof claims to own (header x-conversation-id). */
  sessionId: string;
  /** server-side per-session secret (user_key); may be absent. */
  userKey?: string;
}

/**
 * Compute the expected proof for a session. Exported for tests and for the
 * recipe generator (injectors) so both sides derive the same value.
 */
export function computeBridgeAuthProof(sessionId: string, userKey: string): string {
  return createHmac("sha256", userKey).update(sessionId).digest("hex");
}

/**
 * Verify an incoming proof. Returns one of:
 *   "verified"  — header present, HMAC matches
 *   "invalid"   — header present, mismatch → caller must 403
 *   "missing"   — no header → caller allows but should emit adoption telemetry
 *   "unavailable" — server has no user_key for this session → cannot verify;
 *                   treat as "missing" (fail-open to compat) and log once.
 */
export function verifyBridgeAuthProof(
  headerValue: string | undefined | null,
  secrets: CallerAuthSecrets,
): "verified" | "invalid" | "missing" | "unavailable" {
  if (!headerValue) return "missing";
  if (!secrets.userKey) return "unavailable";
  const expected = computeBridgeAuthProof(secrets.sessionId, secrets.userKey);
  const a = Buffer.from(headerValue.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "verified" : "invalid";
}
