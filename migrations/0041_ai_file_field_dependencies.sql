INSERT INTO database_fielddependency
    (dependant_id, via_id, dependency_id, broken_reference_field_name)
SELECT ai.id, NULL, file_field.id, NULL
FROM database_field ai
JOIN database_field file_field
  ON file_field.id = CAST(json_extract(COALESCE(ai.field_settings, '{}'), '$.ai_file_field_id') AS INTEGER)
 AND file_field.table_id = ai.table_id
 AND file_field.trashed = 0
WHERE ai.type = 'ai'
  AND ai.trashed = 0
  AND json_extract(COALESCE(ai.field_settings, '{}'), '$.ai_file_field_id') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM database_fielddependency dependency
    WHERE dependency.dependant_id = ai.id
      AND dependency.dependency_id = file_field.id
      AND dependency.via_id IS NULL
  );
