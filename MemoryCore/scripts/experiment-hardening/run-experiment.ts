#!/usr/bin/env npx tsx
/**
 * Experiment harness — hardening patch §5 (pre-registered acceptance run).
 *
 * Runs the L1 extraction pipeline (PATCHED code) against seeded fixture
 * conversations, one fresh scratch sqlite dir per (fixture, rep) so reps are
 * independent. Emits one JSON results file for the whole arm.
 *
 * No secrets are ever printed. The gateway config is read for llm.* only.
 *
 * @example
 *   npx tsx scripts/experiment-hardening/run-experiment.ts \
 *     --fixtures scripts/experiment-hardening/fixtures.json \
 *     --out /tmp/opencode/exp-results/patched.json \
 *     --reps 3 \
 *     --config /path/to/tdai-gateway.yaml
 */

import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"
import yaml from "yaml"

const require = createRequire(import.meta.url)

interface FixtureMessage { id: string; role: string; content: string; timestamp: string }
interface Fixture { id: string; messages: FixtureMessage[] }

interface MemoryOut {
  content: string
  type: string
  priority: number
  epistemic_status: string
  authority_source: string
  source_message_ids: string[]
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "string" },
      out: { type: "string" },
      reps: { type: "string", default: "3" },
      config: { type: "string" },
      "scratch-root": { type: "string", default: path.join(os.tmpdir(), "hardening-exp") },
      "same-store": { type: "boolean", default: false },
    },
  })
  const fixturesPath = values.fixtures!
  const outPath = values.out!
  const reps = Number(values.reps)
  const cfgPath = values.config!

  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf-8")) as Fixture[]
  const gw = yaml.parse(fs.readFileSync(cfgPath, "utf-8"))
  const llm = gw?.llm
  if (!llm?.baseUrl || !llm?.apiKey || !llm?.model) {
    console.error("gateway config missing llm.baseUrl/apiKey/model")
    process.exit(1)
  }
  fs.mkdirSync(values["scratch-root"], { recursive: true })
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  // Late imports so arg errors surface before loading the world.
  const { extractL1Memories } = await import("../../src/core/record/l1-extractor.js")
  const ex = await import("../../src/core/record/l1-extractor.js")
  const getTriaged = (ex.getL1InjectionTriagedCount as (() => number) | undefined) ?? (() => 0)
  const getL1DedupDecisionCounts = (ex.getL1DedupDecisionCounts as (() => { store: number; update: number; merge: number; skip: number }) | undefined) ?? (() => ({ store: 0, update: 0, merge: 0, skip: 0 }))
  const getL1DedupWriteOutcomeCounts = (ex.getL1DedupWriteOutcomeCounts as (() => { written: number; skipped: number; failed: number }) | undefined) ?? (() => ({ written: 0, skipped: 0, failed: 0 }))
  let prevDec = getL1DedupDecisionCounts()
  let prevOut = getL1DedupWriteOutcomeCounts()
  const { VectorStore } = await import("../../src/core/store/sqlite/memory-store.js")
  const { StandaloneLLMRunner } = await import("../../src/adapters/standalone/llm-runner.js")

  const results: Array<Record<string, unknown>> = []
  let prevTriaged = getTriaged()

  const envelope = () => JSON.stringify({
    arm: path.basename(outPath, ".json"),
    model: llm.model,
    temperature: "not set by stack runner (provider default)",
    promptMode: "code",
    reps,
    results,
  }, null, 2)
  fs.writeFileSync(outPath, envelope()) // incremental: survive mid-run crashes

  for (const fx of fixtures) {
    // --same-store: all reps of a fixture share one store — rep1 seeds memory,
    // later reps exercise real dedup against that history.
    const shared = values["same-store"]
      ? { dir: fs.mkdtempSync(path.join(values["scratch-root"], `${fx.id}-shared-`)), store: null as InstanceType<typeof VectorStore> | null }
      : null
    for (let rep = 1; rep <= reps; rep++) {
      const scratch = shared ? shared.dir : fs.mkdtempSync(path.join(values["scratch-root"], `${fx.id}-r${rep}-`))
      const store = shared ? (shared.store ??= new VectorStore(path.join(scratch, "vectors.db"), 4)) : new VectorStore(path.join(scratch, "vectors.db"), 4)
      store.init()
      const runner = new StandaloneLLMRunner({
        config: {
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          maxTokens: llm.maxTokens,
          timeoutMs: llm.timeoutMs,
        },
        enableTools: false,
      })
      const t0 = Date.now()
      let memories: MemoryOut[] = []
      let error: string | undefined
      try {
        const res = await extractL1Memories({
          messages: fx.messages.map((m) => ({
            id: m.id,
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
            timestamp: m.timestamp,
          })),
          sessionKey: shared ? `${fx.id}-shared` : `${fx.id}-r${rep}`,
          sessionId: shared ? `exp-${fx.id}` : `exp-${fx.id}-${rep}`,
          teamId: "exp-team",
          userId: "exp-user",
          agentId: "exp-agent",
          baseDir: scratch,
          config: {},
          logger: {
            error: (m: string) => console.error("[l1-err]", m.slice(0, 300)),
            warn: (m: string) => console.warn("[l1-warn]", m.slice(0, 200)),
            info: (m: string) => { if (/dedup|upsert|vec-dual|fts|hybrid/i.test(m)) console.log("[l1-info]", m.slice(0, 240)) },
            debug: (m: string) => { if (/L1-upsert|vec-dual|hybrid-fts|conflict|No similar|No vector|FTS5 query/i.test(m)) console.log("[l1-dbg]", m.slice(0, 240)) },
          },
          options: {
            promptMode: "code",
            enableDedup: true,
            maxMessagesPerExtraction: 10,
            llmRunner: runner,
            vectorStore: store as never,
          },
        })
        memories = (res.records ?? []).map((r) => ({
          record_id: (r as unknown as { record_id?: string }).record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          epistemic_status: r.epistemic_status ?? "inferred",
          authority_source: r.authority_source ?? "unknown",
          source_message_ids: r.source_message_ids ?? [],
        }))
        if (!res.success) error = "extractL1Memories returned success=false"
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      const triagedNow = getTriaged()
      const triagedDelta = triagedNow - prevTriaged
      prevTriaged = triagedNow

      const decNow = getL1DedupDecisionCounts()
      const outNow = getL1DedupWriteOutcomeCounts()
      const decDelta = {
        decisions: {
          store: decNow.store - prevDec.store,
          update: decNow.update - prevDec.update,
          merge: decNow.merge - prevDec.merge,
          skip: decNow.skip - prevDec.skip,
        },
        write: {
          written: outNow.written - prevOut.written,
          skipped: outNow.skipped - prevOut.skipped,
          failed: outNow.failed - prevOut.failed,
        },
      }
      prevDec = decNow
      prevOut = outNow

      let storeRowCount = -1
      try {
        const rows = (store as unknown as { queryL1Records: (f: unknown) => Promise<unknown[]> }).queryL1Records({ sessionKey: shared ? `${fx.id}-shared` : `${fx.id}-r${rep}` })
        storeRowCount = Array.isArray(rows) ? rows.length : (await rows).length
      } catch { /* count is best-effort */ }

      results.push({
        fixture: fx.id,
        rep,
        durationMs: Date.now() - t0,
        error: error ?? null,
        triagedCount: triagedDelta,
        memoryCount: memories.length,
        storeRowCount,
        dedupDelta: decDelta,
        memories,
      })
      console.log(`${fx.id} rep${rep}: ${memories.length} memories, triaged=${triagedDelta}, storeRows=${storeRowCount}, dedup[s/u/m/s]=${decDelta.decisions.store}/${decDelta.decisions.update}/${decDelta.decisions.merge}/${decDelta.decisions.skip} write[w/s/f]=${decDelta.write.written}/${decDelta.write.skipped}/${decDelta.write.failed}${error ? " ERROR: " + error.slice(0, 120) : ""} (${Date.now() - t0}ms)`)

      // Close per-rep stores only; a shared store must stay open across reps
      // (it is closed once after the fixture loop below).
      if (!shared) { try { store.close?.() } catch { /* best effort */ } }
      fs.writeFileSync(outPath, envelope())
    }
    if (shared) { try { shared.store?.close?.() } catch { /* best effort */ } }
  }

  console.log(`results -> ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
