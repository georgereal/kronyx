import { MongoClient } from "mongodb";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { newDumpRef, saveDump, loadDump } from "/Users/jacobgeorge/Workspace/kronyx/backend/src/lib/dumpStore.ts";

const env = Object.fromEntries(readFileSync("/Users/jacobgeorge/Workspace/kronyx/backend/.env","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)]}));
const client = new MongoClient(env.MONGODB_URI);
await client.connect();
const db = client.db("kronyx");

const ev = await db.collection("run_events").find({ "event.type": "compaction" }).sort({ ingestedAt: -1 }).limit(1).next();
if (!ev) { console.log("no compaction events found"); process.exit(1); }
console.log("event:", ev.uid.slice(0,8), ev.runId.slice(0,12), "seq", ev.seq, "session", String(ev.sessionId).slice(0,8));

const tdoc = await db.collection("run_transcripts").findOne({ uid: ev.uid, runId: ev.runId, agentIndex: { $in: [0, null] } });
let messages = [];
if (tdoc?.data) messages = JSON.parse(gunzipSync(Buffer.from(tdoc.data.buffer ?? tdoc.data)).toString("utf8"));
if (!messages.length) { console.log("no transcript for that run — using latest transcript in session");
  const t2 = await db.collection("run_transcripts").find({ uid: ev.uid, sessionId: ev.sessionId }).sort({ savedAt: -1 }).limit(1).next();
  if (t2?.data) messages = JSON.parse(gunzipSync(Buffer.from(t2.data.buffer ?? t2.data)).toString("utf8"));
}
console.log("transcript messages:", messages.length);

const CAP = {"tool-call":8000,"tool-result":8000};
const dump = (msgs) => msgs.map((m, idx) => {
  const parts = (m.content ?? []).map((p) => {
    const b = { type: p.type, text: "" };
    let raw = "";
    if (p.type === "text" || p.type === "reasoning") raw = String(p.text ?? "");
    else if (p.type === "tool-call") { b.toolName = p.toolName; b.toolCallId = p.toolCallId; raw = JSON.stringify(p.input ?? null); }
    else if (p.type === "tool-result") { b.toolName = p.toolName; b.toolCallId = p.toolCallId; b.isError = p.isError; raw = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null); }
    else raw = `[${p.type}]`;
    const cap = CAP[p.type] ?? 2000;
    b.truncated = raw.length > cap;
    b.text = b.truncated ? raw.slice(0,cap) + `\n…[${raw.length-cap} chars elided]` : raw;
    return b;
  });
  const kinds = new Set((m.content??[]).map(p=>p.type));
  const kind = kinds.has("tool-result")?"tool-result":kinds.has("tool-call")?"tool-call":kinds.has("reasoning")?"reasoning":"text";
  return { idx, role: m.role, kind, chars: parts.reduce((n,p)=>n+p.text.length,0), estTokens: Math.ceil(JSON.stringify(m.content??[]).length/4), parts };
});

const before = dump(messages);
// simulate the "after" projection: stub tool results older than the last 6
const resultIdx = messages.map((m,i)=>({i, has:(m.content??[]).some(p=>p.type==="tool-result")})).filter(x=>x.has).map(x=>x.i);
const keepFrom = resultIdx[Math.max(0, resultIdx.length-6)] ?? messages.length;
const afterMsgs = messages.map((m,i)=> i>=keepFrom ? m : ({...m, content:(m.content??[]).map(p=> p.type==="tool-result" ? {...p, output:`[output elided by context compaction — call recall_context with toolCallId "${p.toolCallId}" to retrieve]`} : p)}));
const after = dump(afterMsgs);
console.log("dump lines:", before.length, "->", after.length, "| bytes:", JSON.stringify(before).length, JSON.stringify(after).length);

const ref = newDumpRef(ev.runId);
await saveDump(ev.uid, ref, { before, after });
await db.collection("run_events").updateOne({ _id: ev._id }, { $set: { "event.dumpRef": ref } });
const back = await loadDump(ev.uid, ref);
console.log("dumpRef:", ref, "| roundtrip lines:", back?.before?.length, back?.after?.length);
await client.close();
