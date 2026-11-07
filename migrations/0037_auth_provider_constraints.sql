-- Supertask owns exactly one non-creatable and non-deletable password provider.
INSERT OR IGNORE INTO core_authprovideruser (auth_provider_id, user_id)
SELECT canonical.id, link.user_id
  FROM core_authprovider link_provider
  JOIN core_authprovideruser link ON link.auth_provider_id=link_provider.id
  JOIN (SELECT MIN(id) AS id FROM core_authprovider WHERE type='password') canonical
 WHERE link_provider.type='password' AND link_provider.id!=canonical.id;

DELETE FROM core_authprovider
 WHERE type='password'
   AND id!=(SELECT MIN(id) FROM core_authprovider WHERE type='password');

CREATE UNIQUE INDEX IF NOT EXISTS core_authprovider_single_password_idx
  ON core_authprovider(type) WHERE type='password';

INSERT OR IGNORE INTO core_authprovider (type, enabled, domain, metadata)
VALUES ('password', 1, NULL, '{}');

INSERT OR IGNORE INTO core_authprovideruser (auth_provider_id, user_id)
SELECT password_provider.id, user.id
  FROM auth_user user
  JOIN core_authprovider password_provider ON password_provider.type='password'
 WHERE NOT EXISTS (
   SELECT 1 FROM core_authprovideruser existing WHERE existing.user_id=user.id
 );
