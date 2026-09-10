import { recallL1Candidates } from "../../src/core/tools/l1-candidate-recall.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { readFileSync } from "node:fs";
async function main() {
  const dbPath = process.argv[2]!;
  const query = readFileSync(process.argv[3]!, "utf8");
  const store = new VectorStore(dbPath, 4);
  store.init();
  console.log("countL1:", await store.countL1());
  const r = await recallL1Candidates({ query, topK: 10, vectorStore: store, embeddingService: undefined, logTag: "probe" });
  console.log("hits:", r.hits.length, "strategy:", r.strategy);
  process.exit(0);
}
main().catch((e) => { console.error("threw:", e); process.exit(1); });
