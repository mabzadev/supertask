ALTER TABLE "database_datasync"
ADD COLUMN "authorized_user_id" INTEGER REFERENCES "auth_user" ("id") ON DELETE SET NULL;

UPDATE "database_datasync"
   SET "authorized_user_id" = (
     SELECT wu.user_id
       FROM database_table t
       JOIN core_application a ON a.id=t.database_id
       JOIN core_workspaceuser wu ON wu.workspace_id=a.workspace_id
      WHERE t.id=database_datasync.table_id
        AND wu.to_be_deleted=0
      ORDER BY CASE UPPER(wu.permissions) WHEN 'ADMIN' THEN 0 ELSE 1 END, wu.id ASC
      LIMIT 1
   )
 WHERE "authorized_user_id" IS NULL;

CREATE INDEX IF NOT EXISTS "database_datasync_authorized_user_idx"
  ON "database_datasync" ("authorized_user_id");
