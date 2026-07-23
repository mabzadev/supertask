-- Backfill grid field options for tables/fields created before the field-options
-- creation path was complete. Without these rows the frontend can create fields,
-- but existing grids may fail to display or manipulate those columns correctly.

INSERT OR IGNORE INTO database_gridviewfieldoptions
  (grid_view_id, field_id, width, hidden, [order], aggregation_type, aggregation_raw_type)
SELECT
  v.id AS grid_view_id,
  f.id AS field_id,
  200 AS width,
  0 AS hidden,
  COALESCE(f.[order], 1) * 32768 AS [order],
  '' AS aggregation_type,
  '' AS aggregation_raw_type
FROM database_view v
JOIN database_field f ON f.table_id = v.table_id
WHERE v.type = 'grid'
  AND v.trashed = 0
  AND f.trashed = 0;
