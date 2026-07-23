-- Normalize role scopes written by earlier Worker versions to Baserow's registry names.
UPDATE enterprise_roleassignment SET scope_type='application' WHERE scope_type='database';
UPDATE enterprise_roleassignment SET scope_type='database_table' WHERE scope_type='table';
UPDATE enterprise_roleassignment SET scope_type='database_view' WHERE scope_type='view';
UPDATE enterprise_roleassignment SET scope_type='database_field' WHERE scope_type='field';

-- Keep the newest value before enforcing Baserow's one-assignment/permission rules.
DELETE FROM enterprise_roleassignment
 WHERE id NOT IN (
   SELECT MAX(id)
     FROM enterprise_roleassignment
    GROUP BY subject_id, subject_type, scope_id, scope_type
 );

DELETE FROM enterprise_fieldpermission
 WHERE id NOT IN (
   SELECT MAX(id)
     FROM enterprise_fieldpermission
    GROUP BY field_id
 );

DELETE FROM enterprise_teamsubject
 WHERE id NOT IN (
   SELECT MAX(id)
     FROM enterprise_teamsubject
    GROUP BY team_id, subject_id, subject_type
 );

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_roleassignment_subject_scope_unique
  ON enterprise_roleassignment(subject_id, subject_type, scope_id, scope_type);

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_fieldpermission_field_unique
  ON enterprise_fieldpermission(field_id);

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_teamsubject_team_subject_unique
  ON enterprise_teamsubject(team_id, subject_id, subject_type);

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_team_active_name_unique
  ON enterprise_team(workspace_id, name)
  WHERE trashed=0;

INSERT OR IGNORE INTO enterprise_roleassignment
  (role_id, subject_id, subject_type, scope_id, scope_type)
SELECT r.id, t.id, 'baserow_enterprise.Team', t.workspace_id, 'workspace'
  FROM enterprise_team t
  JOIN enterprise_role r ON r.uid=t.default_role_uid
 WHERE t.default_role_uid IS NOT NULL;
