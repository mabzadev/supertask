CREATE TABLE IF NOT EXISTS database_autonumbersequence (
  field_id INTEGER PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0),
  FOREIGN KEY (field_id) REFERENCES database_field(id) ON DELETE CASCADE
);
