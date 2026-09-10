import { deriveAuthoritySource } from "../../src/core/record/l1-extractor.js";
const roles = new Map([["u1", "user"], ["a1", "assistant"], ["a2", "assistant"]]);
const cases: Array<[string, string[], string, string]> = [
  ["W1 directiva + eco asistente", ["u1", "a1"], "declared", "user_direct"],
  ["solo asistente", ["a1", "a2"], "declared", "assistant_involved"],
  ["runbook externo via user", ["u1"], "external", "user_relayed"],
  ["ids rotos", ["zz"], "declared", "unknown"],
];
let fail = 0;
for (const [name, ids, ep, want] of cases) {
  const got = deriveAuthoritySource(ids, roles, ep as never);
  if (got !== want) { fail++; console.log("FAIL", name, "got", got, "want", want); }
  else console.log("ok", name, "->", got);
}
process.exit(fail);
