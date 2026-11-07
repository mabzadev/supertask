import { ValidationError } from "../middleware/error";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Value(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isNonPublicIpv4(hostname: string): boolean {
  const value = ipv4Value(hostname);
  if (value === null) return false;
  return [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ].some(([network, prefix]) => ipv4InCidr(value, network, prefix));
}

function isNonPublicIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!normalized.includes(":")) return false;
  if (normalized === "::" || normalized === "::1") return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isNonPublicIpv4(mappedIpv4) : false;
}

export function assertPublicHttpUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new ValidationError("The HTTP request URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Only HTTP and HTTPS URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new ValidationError("Credentials are not allowed in the HTTP request URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isNonPublicIpv4(hostname) ||
    isNonPublicIpv6(hostname)
  ) {
    throw new ValidationError("The HTTP request URL points to a non-public address.");
  }
  return url;
}

async function readResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ValidationError("The HTTP response exceeds the maximum allowed size.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ValidationError("The HTTP response exceeds the maximum allowed size.");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function redirectedRequest(status: number, method: string, body: BodyInit | undefined, headers: Headers) {
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    const nextHeaders = new Headers(headers);
    nextHeaders.delete("content-type");
    nextHeaders.delete("content-length");
    return { method: "GET", body: undefined, headers: nextHeaders };
  }
  return { method, body, headers };
}

export async function dispatchPublicHttpRequest(input: {
  url: URL;
  method: string;
  headers: Headers;
  body?: BodyInit;
  timeoutSeconds: number;
}) {
  let currentUrl = assertPublicHttpUrl(input.url);
  let method = input.method;
  let body = input.body;
  let headers = new Headers(input.headers);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let response: Response;
      try {
        response = await fetch(currentUrl.toString(), {
          method,
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ValidationError(`The HTTP request failed: ${detail}`);
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        const rawBody = await readResponseText(response);
        let parsedBody: unknown = rawBody;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          // A non-JSON response is returned as text, matching Supertask.
        }
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          raw_body: rawBody,
          body: parsedBody,
          headers: responseHeaders,
          status_code: response.status,
        };
      }

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirect === MAX_REDIRECTS) {
        throw new ValidationError("The HTTP request redirected too many times.");
      }
      currentUrl = assertPublicHttpUrl(new URL(location, currentUrl));
      ({ method, body, headers } = redirectedRequest(response.status, method, body, headers));
    }
    throw new ValidationError("The HTTP request redirected too many times.");
  } finally {
    clearTimeout(timeoutId);
  }
}
