import Database from "better-sqlite3";
const db = new Database(process.argv[2]);
console.log("tables:", db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name).join(","));
const rows = db.prepare("SELECT id, memory_text FROM l1_records").all();
console.log("rows:", rows.length);
for (const r of rows.slice(0,3)) console.log("  sample:", (r.memory_text||"").slice(0,40));
