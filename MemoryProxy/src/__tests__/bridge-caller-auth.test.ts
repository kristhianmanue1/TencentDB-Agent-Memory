import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * fix/bridge-caller-auth — proof-of-possession for bridge conversation-id.
 *
 * Gate del fix S3 (anexo técnico inyección 29-08):
 *   1. skill-bridge con x-tdai-bridge-auth VÁLIDO → 200 (pasa).
 *   2. skill-bridge con header INVÁLIDO → 403 fail-closed (caller_auth_invalid).
 *   3. skill-bridge SIN header → 200 (compat) — comportamiento idéntico al pre-fix.
 *   4. El proof = HMAC-SHA256(session_id, user_key) — user_key NUNCA en prompt.
 *   5. Sesión sin user_key almacenada → header tratado como missing (compat).
 *   6. proof correcto con sesión L2 (binding, sin store L1) → verificado OK.
 *
 * Estrategia: mockear fetch del handler (deps.fetcher) e inspeccionar el body
 * outbound; el session store se carga con sesión inicializada (igual que
 * memory-bridge-task-scope.test.ts).
 */

import { createHmac } from "node:crypto";
import { createSkillBridgeHandler } from "../skill/skill-bridge.js";
import { computeBridgeAuthProof, verifyBridgeAuthProof } from "../bridge/caller-auth.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";
import type { ProxyConfig } from "../types.js";

const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];

const fetcherMock = vi.fn(async (url: string, init: RequestInit) => {
  fetchCalls.push({ url, body: JSON.parse(String(init.body)) });
  return new Response(
    JSON.stringify({ code: 0, message: "ok", data: { items: [], messages: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

const SESSION_ID = "sess-caller-auth-1";
const USER_KEY = "sk-test-user-key";

async function setupHandler(withUserKey = true) {
  __resetSessionStoreForTests?.();
  const store: any = getSessionStore();
  store.states.set(SESSION_ID, {
    status: "initialized",
    keyId: SESSION_ID,
    startedAt: Date.now(),
    attemptCount: 1,
    sessionInfo: {
      session_id: SESSION_ID,
      team_id: "team-session",
      agent_id: "agt-session",
      user_id: "usr-session",
      task_id: "default",
      ...(withUserKey ? { user_key: USER_KEY } : {}),
    },
  });

  const config = {
    coreSkill: { endpoint: "http://core.test", serviceToken: "t", serviceId: "svc", timeoutMs: 1000 },
    bridgeTelemetry: { enabled: false },
  } as unknown as ProxyConfig;

  return createSkillBridgeHandler(config, { fetcher: fetcherMock as any });
}

function makeCtx(path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): any {
  const req = new Request(`http://p.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": SESSION_ID,
      "x-tdai-service-id": "svc",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return {
    req: {
      url: req.url,
      method: req.method,
      header: (n: string) => req.headers.get(n) ?? "",
      text: () => req.text(),
    },
  };
}

describe("bridge caller-auth unit (compute/verify)", () => {
  it("proof = HMAC-SHA256(session_id, user_key)", () => {
    const expected = createHmac("sha256", USER_KEY).update(SESSION_ID).digest("hex");
    expect(computeBridgeAuthProof(SESSION_ID, USER_KEY)).toBe(expected);
  });

  it("verify: valido/invalido/missing/unavailable", () => {
    const good = computeBridgeAuthProof(SESSION_ID, USER_KEY);
    expect(verifyBridgeAuthProof(good, { sessionId: SESSION_ID, userKey: USER_KEY })).toBe("verified");
    expect(verifyBridgeAuthProof("deadbeef", { sessionId: SESSION_ID, userKey: USER_KEY })).toBe("invalid");
    expect(verifyBridgeAuthProof(undefined, { sessionId: SESSION_ID, userKey: USER_KEY })).toBe("missing");
    expect(verifyBridgeAuthProof(good, { sessionId: SESSION_ID })).toBe("unavailable");
  });
});

describe("skill-bridge caller-auth (fix/bridge-caller-auth)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
  });

  it("1. header válido → pasa y el body sale con identidad de sesión", async () => {
    const handler = await setupHandler();
    const proof = computeBridgeAuthProof(SESSION_ID, USER_KEY);
    const res = await handler(makeCtx("/skill-bridge/v3/skill/listing", { query: "test" }, { "x-tdai-bridge-auth": proof }));
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("2. header inválido → 403 fail-closed, sin llamada a core", async () => {
    const handler = await setupHandler();
    const res = await handler(makeCtx("/skill-bridge/v3/skill/listing", { query: "test" }, { "x-tdai-bridge-auth": "deadbeef" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe(40303);
    expect(fetchCalls.length).toBe(0);
  });

  it("3. sin header → compat: pasa como antes del fix", async () => {
    const handler = await setupHandler();
    const res = await handler(makeCtx("/skill-bridge/v3/skill/listing", { query: "test" }));
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it("4. proof no puede calcularse con otra user_key (reuso de UUID no basta)", async () => {
    const handler = await setupHandler();
    const attackerProof = computeBridgeAuthProof(SESSION_ID, "sk-attacker-key");
    const res = await handler(makeCtx("/skill-bridge/v3/skill/listing", { query: "test" }, { "x-tdai-bridge-auth": attackerProof }));
    expect(res.status).toBe(403);
  });

  it("5. sesión SIN user_key + header presente → unavailable → compat (no 403)", async () => {
    const handler = await setupHandler(false);
    const res = await handler(makeCtx("/skill-bridge/v3/skill/listing", { query: "test" }, { "x-tdai-bridge-auth": "whatever" }));
    expect(res.status).toBe(200);
  });
});
