export interface ParsedArgs {
  command: string;
  url?: string;
  name?: string | null;
  dict?: string | null;
  port?: number;
  transcript_dir?: string | null;
  rtmp_url?: string | null;
  rtmp?: boolean;
  bot_id?: string | null;
  out?: string;
  message?: string;
  transcript_file?: string;
  webhook_token?: string;
}
