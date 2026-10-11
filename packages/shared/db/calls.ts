export type CallSource = "manual" | "calendar";

export interface CallRow {
  id: string;
  tenant_id: string;
  meeting_url: string;
  status: string;
  source: CallSource;
  source_event_id: string | null;
}

export interface SharedCall {
  id: string;
  tenantId: string;
  meetingUrl: string;
  status: string;
  source: CallSource;
  sourceEventId: string | null;
}

export function callFromRow(row: CallRow): SharedCall {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    meetingUrl: row.meeting_url,
    status: row.status,
    source: row.source,
    sourceEventId: row.source_event_id,
  };
}
