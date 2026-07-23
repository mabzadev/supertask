CREATE TABLE IF NOT EXISTS premium_aifieldscheduledupdate (
    field_id INTEGER NOT NULL,
    row_id INTEGER NOT NULL,
    updated_on TEXT NOT NULL,
    PRIMARY KEY (field_id, row_id),
    FOREIGN KEY (field_id) REFERENCES database_field(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS premium_ai_scheduled_update_field_updated_idx
    ON premium_aifieldscheduledupdate(field_id, updated_on);
