export interface ParsedArgs {
  command: string;
  url?: string;
  name?: string | null;
  dict?: string | null;
  port?: number;
  transcript_dir?: string | null;
  rtmp_url?: string | null;
  rtmp?: boolean;
  ws_video?: boolean;
  frame_dir?: string | null;
  bot_id?: string | null;
  out?: string | null;
  archive?: boolean;
  message?: string;
  transcript_file?: string;
  webhook_token?: string;
  call_id_file?: string;
  frame_token?: string;
}
