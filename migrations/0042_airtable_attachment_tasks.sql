CREATE TABLE IF NOT EXISTS database_airtable_attachment_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES core_job(id) ON DELETE CASCADE,
  database_id INTEGER NOT NULL REFERENCES core_application(id) ON DELETE CASCADE,
  table_id INTEGER NOT NULL REFERENCES database_table(id) ON DELETE CASCADE,
  row_id INTEGER NOT NULL,
  field_id INTEGER NOT NULL REFERENCES database_field(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL UNIQUE,
  file_index INTEGER NOT NULL,
  airtable_row_id TEXT NOT NULL,
  airtable_column_id TEXT NOT NULL,
  file_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_on TEXT NOT NULL,
  updated_on TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS database_airtable_attachment_task_job_status_idx
  ON database_airtable_attachment_task(job_id, status, id);
