#!/usr/bin/env npx tsx
/**
 * One-shot audit of existing prescriptive memory atoms (hardening patch §4.3).
 *
 * Scans l1_records for type IN ('instruction','work_method') — BOTH families,
 * the chat type AND the type actually running in this stack (promptMode=code) —
 * derives authority from the roles of each record's source_message_ids against
 * l0_conversations, and buckets:
 *
 *   ok          user_direct verified (all sources resolve, all user, nothing external)
 *   quarantine  assistant_involved, or user_relayed with external/unknown epistemic
 *   unknown     L0 absent or broken source ids — review queue, NOT auto-quarantined
 *
 * Default is DRY-RUN (read-only + report). --apply writes the derived
 * authority_source back into l1_records (data-plane §1 semantics); the
 * injection-side exclusion of quarantined rows is a recall-filter concern and
 * is reported as a pending item, not silently claimed by this script.
 *
 * @example
 *   npx tsx scripts/audit-prescriptive-atoms.ts --data-dir /path/to/memory-tdai
 *   npx tsx scripts/audit-prescriptive-atoms.ts --data-dir ... --apply
 */

import { createRequire } from "node:module"
import type { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

const require = createRequire(import.meta.url)

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite")
}

// ─────────────────────────────────────────────
// Derivation (mirrors l1-extractor.deriveAuthoritySource)
// ─────────────────────────────────────────────

type AuthoritySource = "user_direct" | "user_relayed" | "assistant_involved" | "unknown"
type Bucket = "ok" | "quarantine" | "unknown"

interface AtomRow {
  record_id: string
  type: string
  content: string
  session_key: string
  epistemic_status: string
  authority_source: string
  source_message_ids_json: string
}

interface AuditEntry extends AtomRow {
  derived: AuthoritySource
  bucket: Bucket
  brokenIds: string[]
}

function deriveAuthority(sourceIds: string[], roleById: Map<string, string>, epistemic: string): { derived: AuthoritySource; brokenIds: string[] } {
  let sawUser = false
  let sawAssistant = false
  let sawValid = false
  const brokenIds: string[] = []
  for (const id of sourceIds) {
    const role = roleById.get(id)
    if (!role) {
      brokenIds.push(id)
      continue
    }
    sawValid = true
    if (role === "assistant") sawAssistant = true
    else if (role === "user") sawUser = true
  }
  let derived: AuthoritySource
  if (!sawValid) derived = "unknown"
  else if (sawAssistant) derived = "assistant_involved"
  else if (epistemic === "external") derived = "user_relayed"
  else if (sawUser) derived = "user_direct"
  else derived = "unknown"
  return { derived, brokenIds }
}

function bucketOf(entry: AuditEntry): Bucket {
  if (entry.brokenIds.length > 0 || entry.derived === "unknown") return "unknown"
  if (entry.derived === "assistant_involved") return "quarantine"
  if (entry.derived === "user_relayed" && entry.epistemic_status !== "declared") return "quarantine"
  if (entry.derived === "user_relayed") return "quarantine"
  return "ok"
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      apply: { type: "boolean", default: false },
      "report-out": { type: "string" },
    },
  })
  const dataDir = values["data-dir"]
  if (!dataDir) {
    console.error("--data-dir is required (directory containing vectors.db)")
    process.exit(1)
  }
  const dbPath = path.join(dataDir, "vectors.db")
  if (!fs.existsSync(dbPath)) {
    console.error(`vectors.db not found at ${dbPath}`)
    process.exit(1)
  }

  const { DatabaseSync } = requireNodeSqlite()
  const db = new DatabaseSync(dbPath)
  db.exec("PRAGMA query_only = ON") // read-only guard; --apply re-opens below

  // Prescriptive types of BOTH families: chat `instruction` + code `work_method`.
  // Pre-patch databases lack the provenance columns — fall back honestly:
  // empty sources + empty status land every row in the `unknown` review bucket.
  let atoms: AtomRow[]
  const hasProvenanceCols = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('l1_records') WHERE name IN ('epistemic_status','source_message_ids_json') HAVING n = 2")
    .get() != null
  if (hasProvenanceCols) {
    atoms = db
      .prepare(
        `SELECT record_id, type, content, session_key, epistemic_status, authority_source, source_message_ids_json
         FROM l1_records WHERE type IN ('instruction','work_method')`,
      )
      .all() as unknown as AtomRow[]
  } else {
    console.warn("NOTE: l1_records lacks provenance columns (pre-patch DB) — all prescriptive rows will be bucketed `unknown`")
    atoms = (
      db
        .prepare(
          `SELECT record_id, type, content, session_key, '' AS epistemic_status, '' AS authority_source, '[]' AS source_message_ids_json
           FROM l1_records WHERE type IN ('instruction','work_method')`,
        )
        .all() as unknown as AtomRow[]
    ).map((r) => ({ ...r, epistemic_status: "", authority_source: "" }))
  }

  // L0 role index.
  const roleById = new Map<string, string>()
  const l0Rows = db.prepare("SELECT record_id, role FROM l0_conversations").all() as unknown as Array<{ record_id: string; role: string }>
  for (const r of l0Rows) roleById.set(r.record_id, r.role)

  const entries: AuditEntry[] = atoms.map((row) => {
    let sourceIds: string[] = []
    try {
      const parsed = JSON.parse(row.source_message_ids_json || "[]")
      if (Array.isArray(parsed)) sourceIds = parsed.map(String)
    } catch { /* malformed -> stays empty -> unknown bucket */ }
    const epistemic = row.epistemic_status || "inferred"
    const { derived, brokenIds } = deriveAuthority(sourceIds, roleById, epistemic)
    const entry: AuditEntry = { ...row, epistemic_status: epistemic, derived, brokenIds }
    entry.bucket = bucketOf(entry)
    return entry
  })

  const counts = {
    total: entries.length,
    ok: entries.filter((e) => e.bucket === "ok").length,
    quarantine: entries.filter((e) => e.bucket === "quarantine").length,
    unknown: entries.filter((e) => e.bucket === "unknown").length,
  }
  const byType = {
    instruction: entries.filter((e) => e.type === "instruction").length,
    work_method: entries.filter((e) => e.type === "work_method").length,
  }

  const report = {
    generated_at: new Date().toISOString(),
    data_dir: dataDir,
    scanned_types: ["instruction", "work_method"],
    counts,
    by_type: byType,
    pending_items: [
      "Injection-side exclusion of quarantined rows requires a recall filter on authority_source (not part of this one-shot script).",
    ],
    entries,
  }

  const reportPath = values["report-out"] ?? path.join(dataDir, `prescriptive-atoms-audit-${Date.now()}.json`)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log("== Prescriptive atoms audit ==")
  console.log(`scanned: ${counts.total} (instruction=${byType.instruction}, work_method=${byType.work_method})`)
  console.log(`ok: ${counts.ok} | quarantine: ${counts.quarantine} | unknown: ${counts.unknown}`)
  console.log(`report: ${reportPath}`)

  if (values.apply) {
    if (!hasProvenanceCols) {
      console.error("--apply refused: l1_records lacks the provenance columns (patch the store first)")
      db.close()
      process.exit(1)
    }
    db.exec("PRAGMA query_only = OFF")
    const stmt = db.prepare("UPDATE l1_records SET authority_source = ? WHERE record_id = ?")
    let written = 0
    for (const e of entries) {
      if (e.authority_source !== e.derived) {
        stmt.run(e.derived, e.record_id)
        written++
      }
    }
    console.log(`--apply: wrote derived authority_source for ${written} record(s)`)
  } else {
    console.log("dry-run: no writes (use --apply to write derived authority_source)")
  }

  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
