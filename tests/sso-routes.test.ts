import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SignedXml } from "xml-crypto";
import worker from "../src/index";
import { verifyToken } from "../src/middleware/auth";

vi.mock("cloudflare:sockets", () => ({
  connect: vi.fn(),
}));

type TestD1 = {
  database: DatabaseSync;
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: any[] }>; first<T = any>(): Promise<T | null>; run(): Promise<object> };
    all(): Promise<{ results: any[] }>;
    first<T = any>(): Promise<T | null>;
    run(): Promise<object>;
  };
  batch(statements: Array<{ all?: () => Promise<any>; first?: () => Promise<any>; run?: () => Promise<any> }>): Promise<any[]>;
};

function d1Value(value: unknown): unknown {
  return value === undefined ? null : value;
}

function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_initial.sql", "0014_completed_guided_tours.sql", "0031_auth_provider_users.sql", "0048_account_creation_allowlist.sql"]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
  return {
    database,
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const executeAll = (args: unknown[]) => Promise.resolve({ results: statement.all(...args.map(d1Value)) });
      const executeFirst = <T = any>(args: unknown[]) => Promise.resolve((statement.get(...args.map(d1Value)) || null) as T | null);
      const executeRun = (args: unknown[]) => Promise.resolve(statement.run(...args.map(d1Value)));
      return {
        bind(...args: unknown[]) {
          return {
            all: () => executeAll(args),
            first: <T = any>() => executeFirst<T>(args),
            run: () => executeRun(args),
          };
        },
        all: () => executeAll([]),
        first: <T = any>() => executeFirst<T>([]),
        run: () => executeRun([]),
      };
    },
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run ? statement.run() : statement.first ? statement.first() : statement.all?.()));
    },
  };
}

function createKv() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) || null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

function createEnv(db = createTestD1()) {
  const kv = createKv();
  return {
    DB: db,
    CACHE: kv,
    FILES: { head: async () => null },
    JOBS_QUEUE: { send: async () => undefined },
    WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    MCP_SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) },
    JWT_SIGNING_KEY: "test-secret",
    SECRET_KEY: "secret",
    ENVIRONMENT: "test",
    JWT_ACCESS_TTL_MINUTES: "10",
    JWT_REFRESH_TTL_DAYS: "7",
    PUBLIC_URL: "https://api.opentabl.test",
    PUBLIC_WEB_FRONTEND_URL: "https://web.opentabl.test",
  } as any as { DB: TestD1; CACHE: ReturnType<typeof createKv> } & Record<string, any>;
}

const samlMetadata = `
<EntityDescriptor entityID="https://idp.example.com/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

const samlPrivateKey = readFileSync(join(process.cwd(), "tests", "fixtures", "saml-idp-private-key.pem"), "utf8");
const samlCertificate = readFileSync(join(process.cwd(), "tests", "fixtures", "saml-idp-certificate.pem"), "utf8");
const samlCertificateBody = samlCertificate.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
const signedSamlMetadata = `
<EntityDescriptor entityID="https://idp.example.com/metadata" xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${samlCertificateBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

const samlAcsUrl = "https://api.opentabl.test/api/sso/saml/acs/";

function samlResponse(options: {
  email: string;
  destination?: string;
  audience?: string;
  notBefore?: string;
  notOnOrAfter?: string;
}) {
  const now = Date.now();
  const notBefore = options.notBefore || new Date(now - 60_000).toISOString();
  const notOnOrAfter = options.notOnOrAfter || new Date(now + 300_000).toISOString();
  const destination = options.destination || samlAcsUrl;
  const audience = options.audience || samlAcsUrl;
  return `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${destination}">
      <saml:Issuer>https://idp.example.com/metadata</saml:Issuer>
      <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
      <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
        <saml:Issuer>https://idp.example.com/metadata</saml:Issuer>
        <saml:Subject>
          <saml:NameID>${options.email}</saml:NameID>
          <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
            <saml:SubjectConfirmationData Recipient="${destination}" NotOnOrAfter="${notOnOrAfter}"/>
          </saml:SubjectConfirmation>
        </saml:Subject>
        <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
          <saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>
        </saml:Conditions>
        <saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}" SessionIndex="_session"/>
        <saml:AttributeStatement>
          <saml:Attribute Name="email"><saml:AttributeValue>${options.email}</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="first_name"><saml:AttributeValue>Saml</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="last_name"><saml:AttributeValue>User</saml:AttributeValue></saml:Attribute>
        </saml:AttributeStatement>
      </saml:Assertion>
    </samlp:Response>`;
}

function signSamlAssertion(xml: string) {
  const signer = new SignedXml({ privateKey: samlPrivateKey, publicCert: samlCertificate });
  signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" },
  });
  return signer.getSignedXml();
}

async function insertProvider(db: TestD1, type: string, metadata: Record<string, unknown>, domain: string | null = null, id = 1) {
  await db.prepare("INSERT INTO core_authprovider (id, type, enabled, domain, metadata) VALUES (?, ?, 1, ?, ?)")
    .bind(id, type, domain, JSON.stringify(metadata))
    .run();
}

async function insertWorkspaceInvitation(db: TestD1, email: string, token = "invite-token", permissions = "VIEWER") {
  await db.prepare(
    `INSERT INTO auth_user
     (id, password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
     VALUES (1, '!', NULL, 0, 'owner@example.com', 'Owner', '', 'owner@example.com', 1, 1, ?)`
  ).bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO core_userprofile (user_id) VALUES (1)").run();
  await db.prepare("INSERT INTO core_workspace (id, name, created_on, storage_usage, seats_taken) VALUES (1, 'Invited workspace', ?, 0, 1)")
    .bind(new Date().toISOString())
    .run();
  await db.prepare("INSERT INTO core_workspaceuser (id, workspace_id, user_id, [order], permissions, to_be_deleted) VALUES (1, 1, 1, 1, 'ADMIN', 0)")
    .run();
  await db.prepare(
    `INSERT INTO core_workspaceinvitation (id, workspace_id, invited_by_id, email, permissions, message, token, created_on)
     VALUES (1, 1, 1, ?, ?, '', ?, ?)`
  ).bind(email, permissions, token, new Date().toISOString()).run();
  const domain = email.toLowerCase().split("@")[1];
  await db.prepare(
    `INSERT OR IGNORE INTO core_account_email_allowlist (kind, normalized_value, created_by_id, created_on)
     VALUES ('domain', ?, 1, ?)`
  ).bind(domain, new Date().toISOString()).run();
}

function base64Text(value: string) {
  return btoa(value);
}

describe("SSO route parity", () => {
  it("returns the Baserow SAML login-url contract and validates provider selection", async () => {
    const db = createTestD1();
    await insertProvider(db, "saml", { metadata: samlMetadata }, "example.com");
    const env = createEnv(db);

    const response = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/saml/login-url/?email=user@example.com&original=/database/1&language=fr"),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.redirect_url).toBe("https://api.opentabl.test/api/sso/saml/login/?email=user%40example.com&original=%2Fdatabase%2F1&language=fr");

    const missing = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/saml/login-url/?email=user@missing.com"),
      env
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "ERROR_SAML_INVALID_LOGIN_REQUEST" });

    const invalidEmail = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/saml/login-url/?email=invalid_email"),
      env
    );
    expect(invalidEmail.status).toBe(400);
    expect(await invalidEmail.json()).toMatchObject({ error: "ERROR_QUERY_PARAMETER_VALIDATION" });

    const externalOriginal = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/saml/login-url/?email=user@example.com&original=http://external-site.com"),
      env
    );
    expect(externalOriginal.status).toBe(200);
    expect(await externalOriginal.json()).toMatchObject({
      redirect_url: "https://api.opentabl.test/api/sso/saml/login/?email=user%40example.com",
    });
  });

  it("redirects SAML login requests to the identity provider with relay state", async () => {
    const db = createTestD1();
    await insertProvider(db, "saml", { metadata: samlMetadata }, "example.com");
    const env = createEnv(db);

    const response = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/saml/login/?email=user@example.com&original=/database/1&workspace_invitation_token=invite"),
      env
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://idp.example.com/sso");
    expect(location.searchParams.get("SAMLRequest")).toBeTruthy();
    expect(location.searchParams.get("RelayState")).toBe("https://web.opentabl.test/database/1?workspace_invitation_token=invite");
  });

  it("starts OAuth2 login and stores request data by state", async () => {
    const db = createTestD1();
    await insertProvider(db, "github", { name: "GitHub", client_id: "client", secret: "secret" }, null, 8);
    const env = createEnv(db);

    const response = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/oauth2/login/8/?original=/dashboard&language=fr"),
      env
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client");
    expect(location.searchParams.get("redirect_uri")).toBe("https://api.opentabl.test/api/sso/oauth2/callback/8/");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = location.searchParams.get("state")!;
    expect(JSON.parse((await env.CACHE.get(`sso:oauth2:${state}`))!)).toMatchObject({
      provider_id: 8,
      original: "/dashboard",
      language: "fr",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{80,90}$/),
    });
  });

  it("blocks first-time OAuth2 account creation without a workspace invitation", async () => {
    const db = createTestD1();
    await insertProvider(db, "google", { name: "Google", client_id: "client", secret: "secret" }, null, 9);
    const env = createEnv(db);
    await env.CACHE.put("sso:oauth2:state-1", JSON.stringify({ provider_id: 9, original: "/dashboard", language: "fr", code_verifier: "verifier-1" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/v4/token")) {
        expect(String(init?.body)).toContain("code_verifier=verifier-1");
        return new Response(JSON.stringify({ access_token: "access" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/oauth2/v1/userinfo")) {
        return new Response(JSON.stringify({ email: "sso@example.com", name: "SSO User" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const response = await worker.fetch(
        new Request("https://api.opentabl.test/api/sso/oauth2/callback/9/?state=state-1&code=code-1"),
        env
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe("https://web.opentabl.test/login/error");
      expect(location.searchParams.get("error")).toBe("errorSignupDisabled");
      expect(await env.CACHE.get("sso:oauth2:state-1")).toBeNull();
      expect(await db.prepare("SELECT id FROM auth_user WHERE email='sso@example.com'").first()).toBeNull();
      expect(await db.prepare("SELECT auth_provider_id, user_id FROM core_authprovideruser").all()).toMatchObject({ results: [] });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects OAuth2 login for an existing user created by a different auth provider", async () => {
    const db = createTestD1();
    await db.prepare(
      `INSERT INTO auth_user
       (id, password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
       VALUES (1, '!', NULL, 0, 'existing@example.com', 'Existing', '', 'existing@example.com', 0, 1, ?)`
    ).bind(new Date().toISOString()).run();
    await db.prepare("INSERT INTO core_userprofile (user_id) VALUES (1)").run();
    await insertProvider(db, "google", { name: "Google", client_id: "client", secret: "secret" }, null, 9);
    const env = createEnv(db);
    await env.CACHE.put("sso:oauth2:state-existing", JSON.stringify({ provider_id: 9, original: "/dashboard" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/v4/token")) {
        return new Response(JSON.stringify({ access_token: "access" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/oauth2/v1/userinfo")) {
        return new Response(JSON.stringify({ email: "existing@example.com", name: "Existing User" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const response = await worker.fetch(
        new Request("https://api.opentabl.test/api/sso/oauth2/callback/9/?state=state-existing&code=code-1"),
        env
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe("https://web.opentabl.test/login/error");
      expect(location.searchParams.get("error")).toBe("errorDifferentProvider");
      expect(await db.prepare("SELECT auth_provider_id, user_id FROM core_authprovideruser").all()).toMatchObject({ results: [] });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts workspace invitations during OAuth2 callback without creating an extra workspace", async () => {
    const db = createTestD1();
    await insertWorkspaceInvitation(db, "sso@example.com", "oauth-invite", "VIEWER");
    await insertProvider(db, "google", { name: "Google", client_id: "client", secret: "secret" }, null, 9);
    await db.prepare("UPDATE core_settings SET allow_new_signups=0, allow_signups_via_workspace_invitations=1 WHERE id=1").run();
    const env = createEnv(db);
    await env.CACHE.put("sso:oauth2:invite-state", JSON.stringify({
      provider_id: 9,
      original: "/dashboard",
      language: "fr",
      workspace_invitation_token: "oauth-invite",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/v4/token")) {
        return new Response(JSON.stringify({ access_token: "access" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/oauth2/v1/userinfo")) {
        return new Response(JSON.stringify({ email: "sso@example.com", name: "Invited User" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const response = await worker.fetch(
        new Request("https://api.opentabl.test/api/sso/oauth2/callback/9/?state=invite-state&code=code-1"),
        env
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      const payload = await verifyToken(location.searchParams.get("token")!, "test-secret");
      expect(payload.email).toBe("sso@example.com");
      const user = await db.prepare("SELECT id, email FROM auth_user WHERE email='sso@example.com'").first<any>();
      expect(user.id).toBe(2);
      const membership = await db.prepare("SELECT workspace_id, permissions FROM core_workspaceuser WHERE user_id=?").bind(user.id).all();
      expect(membership.results).toEqual([{ workspace_id: 1, permissions: "VIEWER" }]);
      expect(await db.prepare("SELECT id FROM core_workspaceinvitation WHERE token='oauth-invite'").first()).toBeNull();
      expect(await db.prepare("SELECT language, email_verified FROM core_userprofile WHERE user_id=?").bind(user.id).first()).toMatchObject({
        language: "fr",
        email_verified: 1,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("redirects SSO invitation email mismatches with the Baserow error and preserves the invitation", async () => {
    const db = createTestD1();
    await insertWorkspaceInvitation(db, "invitee@example.com", "mismatch-invite", "VIEWER");
    await insertProvider(db, "google", { name: "Google", client_id: "client", secret: "secret" }, null, 9);
    const env = createEnv(db);
    await env.CACHE.put("sso:oauth2:mismatch-state", JSON.stringify({
      provider_id: 9,
      original: "/dashboard",
      workspace_invitation_token: "mismatch-invite",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/v4/token")) {
        return new Response(JSON.stringify({ access_token: "access" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/oauth2/v1/userinfo")) {
        return new Response(JSON.stringify({ email: "other@example.com", name: "Wrong User" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const response = await worker.fetch(
        new Request("https://api.opentabl.test/api/sso/oauth2/callback/9/?state=mismatch-state&code=code-1"),
        env
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe("https://web.opentabl.test/login/error");
      expect(location.searchParams.get("error")).toBe("errorWorkspaceInvitationEmailMismatch");
      expect(await db.prepare("SELECT id FROM auth_user WHERE email='other@example.com'").first()).toBeNull();
      expect(await db.prepare("SELECT id FROM core_workspaceinvitation WHERE token='mismatch-invite'").first()).toMatchObject({ id: 1 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("completes OpenID Connect callbacks by verifying the signed id_token", async () => {
    const db = createTestD1();
    await insertWorkspaceInvitation(db, "oidc@example.com", "oidc-invite");
    await insertProvider(db, "openid_connect", {
      name: "OIDC",
      base_url: "https://idp.example.com",
      client_id: "oidc-client",
      secret: "secret",
      authorization_url: "https://idp.example.com/oauth/authorize",
      access_token_url: "https://idp.example.com/oauth/token",
      user_info_url: "https://idp.example.com/oauth/userinfo",
      jwks_url: "https://idp.example.com/oauth/jwks",
      issuer: "https://idp.example.com",
      use_id_token: true,
      email_attr_key: "email",
      first_name_attr_key: "name",
      last_name_attr_key: "",
    }, null, 10);
    const env = createEnv(db);
    await env.CACHE.put("sso:oauth2:oidc-state", JSON.stringify({
      provider_id: 10,
      original: "/dashboard",
      language: "en",
      code_verifier: "oidc-verifier",
      oidc_nonce: "oidc-nonce",
      workspace_invitation_token: "oidc-invite",
    }));

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "oidc-key", alg: "RS256", use: "sig" });
    const idToken = await new SignJWT({ email: "oidc@example.com", name: "OIDC Signed User", nonce: "oidc-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "oidc-key" })
      .setIssuer("https://idp.example.com")
      .setAudience("oidc-client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://idp.example.com/oauth/token") {
        return new Response(JSON.stringify({ access_token: "access", id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://idp.example.com/oauth/userinfo") {
        return new Response(JSON.stringify({ ignored: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://idp.example.com/oauth/jwks") {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const response = await worker.fetch(
        new Request("https://api.opentabl.test/api/sso/oauth2/callback/10/?state=oidc-state&code=code-1"),
        env
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      const token = location.searchParams.get("token")!;
      const payload = await verifyToken(token, "test-secret");
      expect(payload.email).toBe("oidc@example.com");
      expect(await env.CACHE.get("sso:oauth2:oidc-state")).toBeNull();
      const user = await db.prepare("SELECT email, first_name FROM auth_user WHERE email='oidc@example.com'").first<any>();
      expect(user).toMatchObject({ email: "oidc@example.com", first_name: "OIDC Signed" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts workspace invitations from SAML RelayState during ACS sign in", async () => {
    const db = createTestD1();
    await insertWorkspaceInvitation(db, "saml-invite@example.com", "saml-invite", "MEMBER");
    await insertProvider(db, "saml", { metadata: samlMetadata }, "example.com");
    const env = createEnv(db);
    const relayState = "https://web.opentabl.test/database/1?workspace_invitation_token=saml-invite&language=fr";
    const samlXml = samlResponse({ email: "saml-invite@example.com" });

    const response = await worker.fetch(
      new Request("https://api.opentabl.test/api/sso/saml/acs/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ SAMLResponse: base64Text(samlXml), RelayState: relayState }),
      }),
      env
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://web.opentabl.test/database/1");
    const payload = await verifyToken(location.searchParams.get("token")!, "test-secret");
    expect(payload.email).toBe("saml-invite@example.com");
    expect(location.searchParams.has("workspace_invitation_token")).toBe(false);
    expect(location.searchParams.has("language")).toBe(false);
    const user = await db.prepare("SELECT id FROM auth_user WHERE email='saml-invite@example.com'").first<any>();
    expect(await db.prepare("SELECT workspace_id, permissions FROM core_workspaceuser WHERE user_id=?").bind(user.id).all()).toMatchObject({
      results: [{ workspace_id: 1, permissions: "MEMBER" }],
    });
    expect(await db.prepare("SELECT id FROM core_workspaceinvitation WHERE token='saml-invite'").first()).toBeNull();
  });

  it("rejects malformed, expired and wrong-audience SAML assertions without creating users", async () => {
    const db = createTestD1();
    await insertProvider(db, "saml", { metadata: samlMetadata }, "example.com");
    const env = createEnv(db);
    const invalidResponses = [
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><broken>`,
      samlResponse({ email: "expired@example.com", notOnOrAfter: new Date(Date.now() - 60_000).toISOString() }),
      samlResponse({ email: "audience@example.com", audience: "https://attacker.example.com/acs" }),
      samlResponse({ email: "destination@example.com", destination: "https://attacker.example.com/acs" }),
    ];

    for (const xml of invalidResponses) {
      const response = await worker.fetch(
        new Request(samlAcsUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ SAMLResponse: base64Text(xml), RelayState: "https://web.opentabl.test/dashboard" }),
        }),
        env
      );
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login/error");
      expect(location.searchParams.get("error")).toBe("errorInvalidSamlResponse");
    }

    expect(await db.prepare("SELECT COUNT(*) AS count FROM auth_user").first()).toMatchObject({ count: 0 });
  });

  it("verifies signed SAML assertions and rejects payload tampering", async () => {
    const db = createTestD1();
    await insertWorkspaceInvitation(db, "signed@example.com", "signed-invite");
    await insertProvider(db, "saml", { metadata: signedSamlMetadata }, "example.com");
    const env = createEnv(db);
    const signed = signSamlAssertion(samlResponse({ email: "signed@example.com" }));

    const accepted = await worker.fetch(
      new Request(samlAcsUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ SAMLResponse: base64Text(signed), RelayState: "https://web.opentabl.test/dashboard?workspace_invitation_token=signed-invite" }),
      }),
      env
    );
    expect(new URL(accepted.headers.get("location")!).pathname).toBe("/dashboard");
    expect(await db.prepare("SELECT email FROM auth_user WHERE email='signed@example.com'").first()).toMatchObject({ email: "signed@example.com" });

    const tampered = signed.replace("signed@example.com", "forged@example.com");
    const rejected = await worker.fetch(
      new Request(samlAcsUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ SAMLResponse: base64Text(tampered), RelayState: "https://web.opentabl.test/dashboard" }),
      }),
      env
    );
    const rejectedLocation = new URL(rejected.headers.get("location")!);
    expect(rejectedLocation.pathname).toBe("/login/error");
    expect(rejectedLocation.searchParams.get("error")).toBe("errorInvalidSamlResponse");
    expect(await db.prepare("SELECT email FROM auth_user WHERE email='forged@example.com'").first()).toBeNull();
  });

  it("rejects an OpenID Connect id_token whose nonce does not match the login request", async () => {
    const db = createTestD1();
    await insertProvider(db, "openid_connect", {
      name: "OIDC",
      base_url: "https://idp.example.com",
      client_id: "oidc-client",
      secret: "secret",
      authorization_url: "https://idp.example.com/oauth/authorize",
      access_token_url: "https://idp.example.com/oauth/token",
      user_info_url: "https://idp.example.com/oauth/userinfo",
      jwks_url: "https://idp.example.com/oauth/jwks",
      issuer: "https://idp.example.com",
      use_id_token: true,
      email_attr_key: "email",
      first_name_attr_key: "name",
      last_name_attr_key: "",
    }, null, 10);
    const env = createEnv(db);
    await env.CACHE.put("sso:oauth2:bad-nonce-state", JSON.stringify({
      provider_id: 10,
      original: "/dashboard",
      oidc_nonce: "expected-nonce",
    }));

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { kid: "nonce-key", alg: "RS256", use: "sig" });
    const idToken = await new SignJWT({ email: "nonce@example.com", name: "Nonce User", nonce: "wrong-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "nonce-key" })
      .setIssuer("https://idp.example.com")
      .setAudience("oidc-client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://idp.example.com/oauth/token") return new Response(JSON.stringify({ access_token: "access", id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://idp.example.com/oauth/userinfo") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://idp.example.com/oauth/jwks") return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404 });
    });

    try {
      const response = await worker.fetch(
        new Request("https://api.opentabl.test/api/sso/oauth2/callback/10/?state=bad-nonce-state&code=code-1"),
        env
      );
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login/error");
      expect(location.searchParams.get("error")).toBe("errorAuthFlowError");
      expect(await db.prepare("SELECT email FROM auth_user WHERE email='nonce@example.com'").first()).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
