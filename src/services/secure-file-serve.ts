import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../types/env";

export type SecureFileServePermission = "DISABLED" | "SIGNED_IN" | "WORKSPACE_ACCESS";

type SecureFilePayload = {
  token_type: "secure_file";
  name: string;
  workspace_id: number | null;
};

const DEFAULT_PUBLIC_URL = "https://supertask.mbza.workers.dev";

function baseUrl(env: Pick<Env, "PUBLIC_URL">): string {
  return env.PUBLIC_URL || DEFAULT_PUBLIC_URL;
}

function truthy(value: unknown): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function jwtSecret(env: Pick<Env, "JWT_SIGNING_KEY" | "SECRET_KEY">): Uint8Array {
  return new TextEncoder().encode(env.JWT_SIGNING_KEY || env.SECRET_KEY);
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function secureFileServeEnabled(env: Pick<Env, "BASEROW_SERVE_FILES_THROUGH_BACKEND">): boolean {
  return truthy(env.BASEROW_SERVE_FILES_THROUGH_BACKEND);
}

export function secureFileServePermission(
  env: Pick<Env, "BASEROW_SERVE_FILES_THROUGH_BACKEND_PERMISSION">
): SecureFileServePermission {
  const value = String(env.BASEROW_SERVE_FILES_THROUGH_BACKEND_PERMISSION || "DISABLED").trim().toUpperCase();
  if (value === "SIGNED_IN" || value === "WORKSPACE_ACCESS") return value;
  return "DISABLED";
}

function secureFileServeExpiresInSeconds(
  env: Pick<Env, "BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS">
): number {
  const seconds = Number(env.BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

export function publicMediaUrl(env: Pick<Env, "PUBLIC_URL">, key: string): string {
  return `${baseUrl(env)}/media/${encodeKey(key)}`;
}

export async function signSecureFileData(
  env: Pick<Env, "JWT_SIGNING_KEY" | "SECRET_KEY" | "BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS">,
  key: string,
  workspaceId?: number | null
): Promise<string> {
  let token = new SignJWT({
    token_type: "secure_file",
    name: key,
    workspace_id: workspaceId === undefined ? null : workspaceId,
  } satisfies SecureFilePayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt();
  const expiresIn = secureFileServeExpiresInSeconds(env);
  if (expiresIn > 0) token = token.setExpirationTime(`${expiresIn}s`);
  return token.sign(jwtSecret(env));
}

export async function buildFileUrl(
  env: Pick<
    Env,
    | "PUBLIC_URL"
    | "JWT_SIGNING_KEY"
    | "SECRET_KEY"
    | "BASEROW_SERVE_FILES_THROUGH_BACKEND"
    | "BASEROW_SERVE_FILES_THROUGH_BACKEND_EXPIRE_SECONDS"
  >,
  key: string,
  workspaceId?: number | null
): Promise<string> {
  if (!secureFileServeEnabled(env)) return publicMediaUrl(env, key);
  const signedData = await signSecureFileData(env, key, workspaceId);
  return `${baseUrl(env)}/api/files/${encodeURIComponent(signedData)}`;
}

export async function verifySecureFileData(
  env: Pick<Env, "JWT_SIGNING_KEY" | "SECRET_KEY">,
  signedData: string
): Promise<SecureFilePayload | null> {
  try {
    const { payload } = await jwtVerify(decodeURIComponent(signedData), jwtSecret(env));
    if (payload.token_type !== "secure_file" || typeof payload.name !== "string") return null;
    const rawWorkspaceId = payload.workspace_id;
    return {
      token_type: "secure_file",
      name: payload.name,
      workspace_id: rawWorkspaceId === null || rawWorkspaceId === undefined ? null : Number(rawWorkspaceId),
    };
  } catch {
    return null;
  }
}
