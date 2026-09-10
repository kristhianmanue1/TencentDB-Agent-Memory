import { buildFtsQuery, extractQueryTokens, tokenizeForFts } from "../../src/core/store/tokenize.js";
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) console.log("ok", name);
  else { fail++; console.log("FAIL", name, "->", got); }
};
// Latin: accented words stay whole
check("latin word whole (query)", !buildFtsQuery("revisar el módulo de facturación")!.includes('"m"'), buildFtsQuery("revisar el módulo de facturación"));
check("latin word whole (index)", !tokenizeForFts("módulo de facturación").split(/\s+/).includes("ó"), tokenizeForFts("módulo de facturación"));
check("extract keeps módulo", extractQueryTokens("el módulo").includes("módulo"), extractQueryTokens("el módulo"));
// Chinese: still segmented
const zh = tokenizeForFts("旅行计划很重要");
check("chinese segmented", zh.split(" ").length >= 2, zh);
check("chinese query tokens", extractQueryTokens("旅行计划").length >= 1, extractQueryTokens("旅行计划"));
// Mixed
const mixed = tokenizeForFts("Actualizar el módulo de pagos y 旅行计划");
check("mixed keeps latin + segments cjk", mixed.includes("Actualizar") && mixed.includes("módulo") && mixed.split(" ").some((t) => /[\u4e00-\u9fff]/.test(t) && !t.includes(" ")), mixed);
process.exit(fail);
