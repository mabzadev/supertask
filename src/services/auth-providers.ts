export type PasswordAuthProvider = {
  id: number;
  type: "password";
  enabled: number;
  domain: string | null;
  metadata: string;
};

export async function ensurePasswordAuthProvider(db: D1Database): Promise<PasswordAuthProvider> {
  await db.prepare(
    `INSERT OR IGNORE INTO core_authprovider (type, enabled, domain, metadata)
     SELECT 'password', 1, NULL, '{}'
      WHERE NOT EXISTS (SELECT 1 FROM core_authprovider WHERE type='password')`
  ).run();
  const provider = await db.prepare(
    "SELECT * FROM core_authprovider WHERE type='password' ORDER BY id ASC LIMIT 1"
  ).first<PasswordAuthProvider>();
  if (!provider) throw new Error("The password authentication provider could not be initialized.");
  return provider;
}

export async function isPasswordAuthProviderEnabled(db: D1Database): Promise<boolean> {
  return Boolean((await ensurePasswordAuthProvider(db)).enabled);
}

export function authProviderDisabledBody() {
  return {
    error: "ERROR_AUTH_PROVIDER_DISABLED",
    detail: "Authentication provider is disabled.",
  };
}
