// Global Cloudflare Worker bindings
export interface Env {
  // D1 Database
  DB: D1Database;
  // KV Cache
  CACHE: KVNamespace;
  // R2 File Storage
  FILES: R2Bucket;
  // Cloudflare Images transformation binding, when enabled on the account.
  IMAGES?: ImagesBinding;
  // Cloudflare Browser Rendering, used when Airtable rejects Worker HTTP egress.
  BROWSER?: { fetch: typeof fetch };
  // Workers AI and Vectorize bindings for the Enterprise assistant knowledge base.
  AI?: Ai;
  KNOWLEDGE_BASE?: VectorizeIndex;
  // Queue
  JOBS_QUEUE: Queue<JobMessage>;
  // Durable Objects
  WORKSPACE_ROOM: DurableObjectNamespace;
  CONTENT_ROOM: DurableObjectNamespace;
  MCP_SESSION: DurableObjectNamespace;
  HYPERDRIVE?: Hyperdrive;

  // Secrets & Config
  SECRET_KEY: string;
  JWT_SIGNING_KEY: string;
  ENVIRONMENT: string;
  JWT_ACCESS_TTL_MINUTES: string;
  JWT_REFRESH_TTL_DAYS: string;
  PUBLIC_URL: string;
  PUBLIC_WEB_FRONTEND_URL?: string;
  MEDIA_URL?: string;
  BASEROW_SERVE_FILES_THROUGH_BACKEND?: string;
  BASEROW_SERVE_FILES_THROUGH_BACKEND_PERMISSION?: string;
  BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS?: string;
  BASEROW_FILE_UPLOAD_SIZE_LIMIT_MB?: string;
  BATCH_ROWS_SIZE_LIMIT?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

// ── Job message shapes ────────────────────────────────────────────────────────
export type JobType =
  | "airtable"
  | "export_table"
  | "import_csv"
  | "import_airtable"
  | "export_applications"
  | "import_applications"
  | "workspace_import"
  | "airtable_attachment_retry"
  | "cleanup_user_files"
  | "duplicate_table"
  | "duplicate_field"
  | "sync_data_sync_table"
  | "sync_data_source"
  | "cleanup_trash"
  | "cleanup_jobs"
  | "create_snapshot"
  | "restore_snapshot"
  | "row_count"
  | "webhook_trigger"
  | "duplicate_automation_workflow"
  | "publish_automation_workflow"
  | "sync_assistant_knowledge"
  | "generate_ai_values";

export interface JobMessage {
  job_id: number;
  job_type: JobType;
  payload: Record<string, unknown>;
  user_id: number;
  workspace_id: number;
}

// ── Cron job types ────────────────────────────────────────────────────────────
export type CronSchedule =
  | "*/5 * * * *"
  | "0 3 * * *"
  | "0 * * * *";

// ── Request context extensions ────────────────────────────────────────────────
export interface RequestUser {
  id: number;
  email: string;
  username: string;
  is_staff: boolean;
  is_active: boolean;
}

export interface RequestVariables {
  user?: RequestUser;
  db_token_permissions?: {
    token_id: number;
    workspace_id: number;
    permissions: Array<{
      type: string;
      table_id: number | null;
      database_id: number | null;
    }>;
  };
  client_session_id?: string;
  websocket_id?: string;
}

// ── WebSocket DO message shapes ───────────────────────────────────────────────
export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface PageAddMessage extends WSMessage {
  type: "page_add";
  page: string;
}

export interface PageDiscardMessage extends WSMessage {
  type: "page_discard";
  page: string;
}

export interface BroadcastMessage extends WSMessage {
  type: string;
  sender_websocket_id?: string;
  exclude_current?: boolean;
}
