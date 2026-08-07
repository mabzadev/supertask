#!/usr/bin/env node

const baseUrl = (process.env.OPENTABL_API_URL || "https://opentabl.mbza.workers.dev").replace(/\/$/, "");
const stamp = Date.now();
const email = `opentabl-sso-${stamp}@example.com`;
const password = `OpenTabl-SSO-${stamp}!`;
let accessToken = "";
let workspaceId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(method, path, body, options = {}) {
  const headers = new Headers();
  if (accessToken && options.auth !== false) headers.set("authorization", `JWT ${accessToken}`);
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, redirect: "manual" });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function rawRequest(method, path, body) {
  return fetch(`${baseUrl}${path}`, { method, body, redirect: "manual" });
}

try {
  const signup = await jsonRequest("POST", "/api/user/", {
    name: "OpenTabl SSO smoke",
    email,
    password,
    authenticate: true,
  }, { auth: false });
  accessToken = signup.access_token;
  const workspace = await jsonRequest("POST", "/api/workspaces/", { name: `SSO smoke ${stamp}` });
  workspaceId = workspace.id;
  const database = await jsonRequest("POST", `/api/applications/workspace/${workspace.id}/`, {
    name: "SSO users database",
    type: "database",
  });
  const table = await jsonRequest("POST", `/api/database/tables/database/${database.id}/`, { name: "SSO users" });
  const emailField = table.fields[0];
  const builder = await jsonRequest("POST", `/api/applications/workspace/${workspace.id}/`, {
    name: "SSO builder",
    type: "builder",
  });
  const integration = await jsonRequest("POST", `/api/application/${builder.id}/integrations/`, {
    type: "local_baserow",
    name: "SSO users database",
  });
  const issuer = `https://saml-${stamp}.example/metadata`;
  const metadata = `
    <EntityDescriptor entityID="${issuer}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">
      <IDPSSODescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://saml-${stamp}.example/sso"/></IDPSSODescriptor>
    </EntityDescriptor>`;
  const userSource = await jsonRequest("POST", `/api/application/${builder.id}/user-sources/`, {
    type: "local_baserow",
    name: "SSO users",
    integration_id: integration.id,
    table_id: table.id,
    email_field_id: emailField.id,
    name_field_id: emailField.id,
    role_field_id: null,
    auth_providers: [
      {
        id: 1,
        type: "saml",
        domain: "example.com",
        metadata,
        email_attr_key: "email",
        first_name_attr_key: "first_name",
        last_name_attr_key: "last_name",
      },
      {
        id: 2,
        type: "openid_connect",
        name: "Google OpenID",
        base_url: "https://accounts.google.com",
        client_id: `smoke-client-${stamp}`,
        secret: `smoke-secret-${stamp}`,
      },
    ],
  });
  const original = `https://tabl.mbza.dev/sso-smoke-${stamp}`;
  const oidcLogin = await rawRequest(
    "GET",
    `/api/user-source/${encodeURIComponent(userSource.uid)}/sso/oauth2/openid_connect/login/?iss=${encodeURIComponent("https://accounts.google.com")}&original=${encodeURIComponent(original)}`,
  );
  const oidcLocation = new URL(oidcLogin.headers.get("location"));
  assert(
    oidcLogin.status === 302 && oidcLocation.searchParams.get("code_challenge_method") === "S256",
    `OIDC login failed: ${oidcLogin.status} ${oidcLocation}`,
  );
  const login = await rawRequest(
    "GET",
    `/api/user-source/${encodeURIComponent(userSource.uid)}/sso/saml/login/?email=${encodeURIComponent(`person-${stamp}@example.com`)}&original=${encodeURIComponent(original)}`,
  );
  const loginLocation = new URL(login.headers.get("location"));
  const relayState = loginLocation.searchParams.get("RelayState");
  assert(login.status === 302 && relayState, `SAML login failed: ${login.status} ${loginLocation}`);

  const acsUrl = `${baseUrl}/api/user-source/sso/saml/acs/`;
  const userEmail = `person-${stamp}@example.com`;
  const now = new Date().toISOString();
  const notBefore = new Date(Date.now() - 60_000).toISOString();
  const notOnOrAfter = new Date(Date.now() + 300_000).toISOString();
  const responseXml = `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${now}" Destination="${acsUrl}">
      <saml:Issuer>${issuer}</saml:Issuer>
      <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
      <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${now}">
        <saml:Issuer>${issuer}</saml:Issuer>
        <saml:Subject><saml:NameID>${userEmail}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="${acsUrl}" NotOnOrAfter="${notOnOrAfter}"/></saml:SubjectConfirmation></saml:Subject>
        <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${acsUrl}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
        <saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${userEmail}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="first_name"><saml:AttributeValue>Production</saml:AttributeValue></saml:Attribute><saml:Attribute Name="last_name"><saml:AttributeValue>SSO</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>
      </saml:Assertion>
    </samlp:Response>`;
  const form = new FormData();
  form.set("SAMLResponse", Buffer.from(responseXml).toString("base64"));
  form.set("RelayState", relayState);
  const completed = await rawRequest("POST", "/api/user-source/sso/saml/acs/", form);
  const completedLocation = new URL(completed.headers.get("location"));
  const refreshToken = completedLocation.searchParams.get(`user_source_saml_token__${userSource.id}`);
  assert(
    completed.status === 302 && `${completedLocation.origin}${completedLocation.pathname}` === original && refreshToken,
    `SAML ACS failed: ${completed.status} ${completedLocation.toString()}`,
  );
  const refreshed = await jsonRequest("POST", "/api/user-source-auth-refresh/", { refresh_token: refreshToken }, { auth: false });
  assert(refreshed.access_token && refreshed.refresh_token, "SAML refresh token failed");
  console.log(`Builder SSO production smoke passed: source ${userSource.id}`);
} catch (error) {
  console.error(`Builder SSO production smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (workspaceId && accessToken) {
    try {
      await jsonRequest("DELETE", `/api/workspaces/${workspaceId}/`);
      console.log(`Cleaned SSO smoke workspace ${workspaceId}`);
    } catch (error) {
      console.error(`Failed to clean SSO smoke workspace ${workspaceId}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
