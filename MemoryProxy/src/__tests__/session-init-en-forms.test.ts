import { describe, it, expect } from "vitest";

/**
 * Gate del parche i18n EN session-init (fork option A, 2026-09-10):
 *
 * 1. Los forms de opencode y claude-code renderizan cadenas EN (form-en.ts).
 * 2. El parser compartido extractAssetConfirm reconoce respuestas EN y zh
 *    (los adapters CB/WB/codex/dsh siguen zh; los extractores compartidos
 *    no deben romperse).
 * 3. Header de opencode ≤30 chars (schema hard-limit del client).
 *
 * Estrategia: render smoke — parsear el tool_call arguments del Response
 * generado (OpenAI JSON para opencode, Anthropic SSE para claude-code) y
 * verificar labels/questions EN. Sin red, sin store.
 */

import { buildFormResponse as buildOcForm } from "../session/opencode/form.js";
import { buildFormResponse as buildCcForm } from "../session/claude-code/form.js";
import { extractAssetConfirm } from "../session/codebuddy/extractor.js";
import type { FormData as OCFormData } from "../session/opencode/form.js";
import type { FormData as CCFormData } from "../session/claude-code/form.js";

const teams = [
  {
    team_id: "znrcxh7t000000000000",
    team_name: "Aria",
    agents: [
      {
        agent_id: "agt-k51xdkuywq000000",
        agent_name: "Krathos",
        description: "orchestrator",
        tasks: [],
      },
    ],
    tasks: [
      { task_id: "662771760847372290", task_name: "krathos-directivas-v030", isDefault: false },
    ],
  },
  {
    team_id: "t7f9t6ri000000000000",
    team_name: "krisnova",
    agents: [],
    tasks: [],
  },
];

describe("session-init EN forms (fork i18n option A)", () => {
  it("extractAssetConfirm reconoce EN yes/no y mantiene zh", () => {
    expect(extractAssetConfirm("User has answered your questions: \"Link team assets for this conversation?\"=\"Yes, link team assets\"")).toBe(true);
    expect(extractAssetConfirm("Yes, link team assets")).toBe(true);
    expect(extractAssetConfirm("No, skip asset linking")).toBe(false);
    // zh intacto (CB/WB/codex/dsh siguen en chino)
    expect(extractAssetConfirm("是，关联团队资产")).toBe(true);
    expect(extractAssetConfirm("否，本次不关联")).toBe(false);
    expect(extractAssetConfirm("texto irrelevante")).toBeNull();
  });

  it("opencode asset_confirm renderiza EN con header ≤30", async () => {
    const fd: OCFormData = { teams, stage: "asset_confirm" };
    const res = buildOcForm(fd);
    const text = await res.text();
    const parsed = JSON.parse(text);
    const args = JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments);
    const q = args.questions[0];
    expect(q.question).toContain("Link team assets for this conversation?");
    expect(q.question).not.toContain("关联团队资产");
    expect(q.header.length).toBeLessThanOrEqual(30);
    expect(q.options[0].label).toBe("Yes, link team assets");
    expect(q.options[1].label).toBe("No, skip asset linking");
  });

  it("opencode team_select renderiza EN con MORE EN", async () => {
    // 5 teams → 2 páginas → slot "More →" presente (tri-label path del init).
    const fiveTeams = [
      ...teams,
      ...Array.from({ length: 4 }, (_, i) => ({
        team_id: `t000000000000000000${i}`,
        team_name: `Filler${i}`,
        agents: [],
        tasks: [],
      })),
    ];
    const fd: OCFormData = { teams: fiveTeams, stage: "team", pageIndex: 0 };
    const res = buildOcForm(fd);
    const parsed = JSON.parse(await res.text());
    const args = JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments);
    expect(args.questions[0].question).toContain("Select the Team for this session");
    expect(args.questions[0].question).not.toContain("请选择");
    const labels = args.questions[0].options.map((o: { label: string }) => o.label);
    expect(labels).toContain("More →");
    expect(labels).not.toContain("更多 →");
  });

  it("claude-code asset_confirm renderiza EN (SSE Anthropic)", async () => {
    const fd: CCFormData = { teams, stage: "asset_confirm" };
    const res = buildCcForm(fd);
    const text = await res.text();
    const deltaLine = text.split("\n").find((l) => l.includes("input_json_delta"));
    expect(deltaLine).toBeDefined();
    const delta = JSON.parse(deltaLine!.replace(/^data: /, ""));
    const args = JSON.parse(delta.delta.partial_json);
    expect(args.questions[0].question).toContain("Link team assets for this conversation?");
    expect(args.questions[0].options[0].label).toBe("Yes, link team assets");
    expect(args.questions[0].header).toBe("Link assets");
  });
});
