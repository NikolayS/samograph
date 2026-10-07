import type { SQL } from "bun";

export const CONTEXT_BYTES = 32 * 1024;
export interface ContextLine { seq: number; ts: string; speaker: string | null; text: string; kind: "speech" | "chat" }
export interface ContextPage {
  binding: { id: string; call_id: string; provider: string; native_session_id: string };
  status: string; ingest_degraded: boolean; lines: ContextLine[]; omitted: Array<{seq:number;reason:"oversized"}>;
  next_seq: number; has_more: boolean; truncated: boolean;
}
/** SQL projects bounded fields before transfer; oversized rows are explicit omissions. */
export async function readContext(tx: SQL, binding: ContextPage["binding"] & {min_seq: number}, call: {status: string; ingest_degraded:boolean}, cursor?: number): Promise<ContextPage> {
  const rows = await tx`SELECT seq::text, ts,
    CASE WHEN octet_length(speaker) <= 512 THEN speaker ELSE NULL END AS speaker,
    CASE WHEN octet_length(text) <= 8192 THEN text ELSE NULL END AS text,
    (octet_length(text) > 8192 OR octet_length(speaker) > 512) AS oversized, kind
    FROM transcripts WHERE call_id = ${binding.call_id} AND seq >= ${binding.min_seq}
    AND seq > ${cursor ?? binding.min_seq - 1} ORDER BY seq ASC LIMIT 51`;
  const page: ContextPage = {binding: {id:binding.id,call_id:binding.call_id,provider:binding.provider,native_session_id:binding.native_session_id},...call,lines:[],omitted:[],next_seq:cursor ?? binding.min_seq - 1,has_more:false,truncated:false};
  for (let i=0;i<rows.length;i++) {
    if(i===50) { page.has_more=true; break; }
    const row=rows[i]; const seq=Number(row.seq);
    const line = {seq,ts:new Date(row.ts).toISOString(),speaker:row.speaker,text:row.text,kind:row.kind};
    if(row.oversized) page.omitted.push({seq,reason:"oversized"}); else page.lines.push(line);
    const previous=page.next_seq; page.next_seq=seq;
    if (Buffer.byteLength(JSON.stringify(page),"utf8") > CONTEXT_BYTES - 64) {
      if(row.oversized) page.omitted.pop(); else page.lines.pop();
      page.next_seq=previous; page.has_more=true; page.truncated=true; break;
    }
  }
  page.truncated ||= page.has_more || page.omitted.length>0;
  return page;
}
