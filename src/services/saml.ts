import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const HTTP_REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const MAX_SAML_XML_BYTES = 2 * 1024 * 1024;

type SamlAttributeValue = string | string[];

export type SamlMetadata = {
  entityId: string;
  singleSignOnUrl: string;
  signingCertificates: string[];
};

export type SamlIdentity = {
  issuer: string;
  nameId: string;
  attributes: Record<string, SamlAttributeValue>;
  signed: boolean;
};

function invalidSaml(message: string): never {
  throw new Error(`Invalid SAML response: ${message}`);
}

function parseXml(xml: string): Document {
  if (!xml || new TextEncoder().encode(xml).byteLength > MAX_SAML_XML_BYTES) {
    invalidSaml("payload size");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalidSaml("document type declarations are not allowed");

  const errors: string[] = [];
  const document = new DOMParser({
    locator: {},
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(String(message)),
      fatalError: (message) => errors.push(String(message)),
    },
  }).parseFromString(xml, "text/xml");
  if (!document?.documentElement || errors.length > 0 || document.getElementsByTagName("parsererror").length > 0) {
    invalidSaml("malformed XML");
  }
  return document;
}

function elements(expression: string, node: Node): Element[] {
  const selected = xpath.select(expression, node);
  return (Array.isArray(selected) ? selected : [selected]).filter((item): item is Element => Boolean(item && (item as Node).nodeType === 1));
}

function firstElement(expression: string, node: Node): Element | null {
  return elements(expression, node)[0] || null;
}

function text(element: Element | null): string {
  return element?.textContent?.trim() || "";
}

function exactAttribute(element: Element, name: string): string {
  return element.getAttribute(name)?.trim() || "";
}

function validateInstant(value: string, mode: "before" | "after", now: number): void {
  if (!value) return;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalidSaml("invalid timestamp");
  if (mode === "before" && now < timestamp) invalidSaml("assertion is not yet valid");
  if (mode === "after" && now >= timestamp) invalidSaml("assertion has expired");
}

function validateTemporalElement(element: Element | null, now: number): void {
  if (!element) return;
  validateInstant(exactAttribute(element, "NotBefore"), "before", now);
  validateInstant(exactAttribute(element, "NotOnOrAfter"), "after", now);
}

function profileValue(value: unknown): SamlAttributeValue | null {
  if (Array.isArray(value)) {
    const values = value.map((item) => String(item ?? "").trim()).filter(Boolean);
    return values.length > 0 ? values : null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized ? normalized : null;
  }
  return null;
}

function responseStructure(xml: string, expectedIssuer?: string, acsUrl?: string): SamlIdentity & { hasSignature: boolean } {
  const document = parseXml(xml);
  const response = document.documentElement;
  if (response.localName !== "Response" || response.namespaceURI !== SAML_PROTOCOL_NS) invalidSaml("root element");

  const assertions = elements("./*[local-name()='Assertion']", response);
  const encryptedAssertions = elements("./*[local-name()='EncryptedAssertion']", response);
  if (assertions.length !== 1 || encryptedAssertions.length > 0) invalidSaml("exactly one plain assertion is required");
  const assertion = assertions[0];

  const status = firstElement("./*[local-name()='Status']/*[local-name()='StatusCode']", response);
  if (status && exactAttribute(status, "Value") !== SAML_SUCCESS) invalidSaml("identity provider returned an error");

  const responseIssuer = text(firstElement("./*[local-name()='Issuer']", response));
  const assertionIssuer = text(firstElement("./*[local-name()='Issuer']", assertion));
  const issuer = responseIssuer || assertionIssuer;
  if (!issuer) invalidSaml("missing issuer");
  if (responseIssuer && assertionIssuer && responseIssuer !== assertionIssuer) invalidSaml("issuer mismatch");
  if (expectedIssuer && issuer !== expectedIssuer) invalidSaml("unknown issuer");

  if (acsUrl) {
    const destination = exactAttribute(response, "Destination");
    if (destination && destination !== acsUrl) invalidSaml("destination mismatch");
  }

  const now = Date.now();
  const conditions = elements("./*[local-name()='Conditions']", assertion);
  if (conditions.length > 1) invalidSaml("multiple condition blocks");
  validateTemporalElement(conditions[0] || null, now);

  if (acsUrl && conditions[0]) {
    const audiences = elements("./*[local-name()='AudienceRestriction']/*[local-name()='Audience']", conditions[0]).map(text).filter(Boolean);
    if (audiences.length > 0 && !audiences.includes(acsUrl)) invalidSaml("audience mismatch");
  }

  const confirmations = elements("./*[local-name()='Subject']/*[local-name()='SubjectConfirmation']/*[local-name()='SubjectConfirmationData']", assertion);
  for (const confirmation of confirmations) {
    validateTemporalElement(confirmation, now);
    if (acsUrl) {
      const recipient = exactAttribute(confirmation, "Recipient");
      if (recipient && recipient !== acsUrl) invalidSaml("recipient mismatch");
    }
  }

  const nameId = text(firstElement("./*[local-name()='Subject']/*[local-name()='NameID']", assertion));
  if (!nameId) invalidSaml("missing NameID");

  const attributes: Record<string, SamlAttributeValue> = {};
  for (const attribute of elements("./*[local-name()='AttributeStatement']/*[local-name()='Attribute']", assertion)) {
    const name = exactAttribute(attribute, "Name") || exactAttribute(attribute, "FriendlyName");
    if (!name) continue;
    const values = elements("./*[local-name()='AttributeValue']", attribute).map(text).filter(Boolean);
    if (values.length === 1) attributes[name] = values[0];
    else if (values.length > 1) attributes[name] = values;
  }

  const hasSignature = Boolean(
    firstElement("./*[local-name()='Signature']", response) || firstElement("./*[local-name()='Signature']", assertion)
  );
  return { issuer, nameId, attributes, signed: hasSignature, hasSignature };
}

export function decodeSamlResponse(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_SAML_XML_BYTES) invalidSaml("payload size");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid SAML response:")) throw error;
    invalidSaml("invalid base64 payload");
  }
}

export function parseSamlMetadata(xml: string): SamlMetadata {
  const document = parseXml(xml);
  const descriptor = document.documentElement;
  if (descriptor.localName !== "EntityDescriptor") throw new Error("Invalid SAML metadata");
  const entityId = exactAttribute(descriptor, "entityID");
  if (!entityId) throw new Error("Invalid SAML metadata");

  const services = elements(".//*[local-name()='IDPSSODescriptor']/*[local-name()='SingleSignOnService']", descriptor);
  const preferred = services.find((item) => exactAttribute(item, "Binding") === HTTP_REDIRECT_BINDING) || services[0];
  const singleSignOnUrl = preferred ? exactAttribute(preferred, "Location") : "";
  if (!singleSignOnUrl) throw new Error("Invalid SAML metadata");
  const parsedUrl = new URL(singleSignOnUrl);
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("Invalid SAML metadata");

  const signingCertificates = elements(".//*[local-name()='IDPSSODescriptor']//*[local-name()='X509Certificate']", descriptor)
    .map((item) => text(item).replace(/\s+/g, ""))
    .filter(Boolean);
  return { entityId, singleSignOnUrl, signingCertificates: [...new Set(signingCertificates)] };
}

export function samlIssuerFromResponse(xml: string): string {
  return responseStructure(xml).issuer;
}

export async function validateSamlResponse(encoded: string, metadataXml: string, acsUrl: string): Promise<SamlIdentity> {
  const xml = decodeSamlResponse(encoded);
  const metadata = parseSamlMetadata(metadataXml);
  const parsed = responseStructure(xml, metadata.entityId, acsUrl);

  // Anyone can forge an unsigned response for a public IdP entityID, so the
  // response or its assertion must be signed by a certificate from the metadata.
  if (!parsed.hasSignature) invalidSaml("response is not signed");
  if (metadata.signingCertificates.length === 0) invalidSaml("metadata has no signing certificate");
  {
    const saml = new SAML({
      callbackUrl: acsUrl,
      issuer: acsUrl,
      audience: acsUrl,
      idpCert: metadata.signingCertificates,
      wantAssertionsSigned: false,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.never,
      disableRequestedAuthnContext: true,
      acceptedClockSkewMs: 0,
    });
    const result = await saml.validatePostResponseAsync({ SAMLResponse: encoded });
    if (!result.profile || result.loggedOut) invalidSaml("missing authenticated profile");
    if (result.profile.issuer && String(result.profile.issuer) !== metadata.entityId) invalidSaml("unknown signed issuer");

    // Identity comes from the signature-verified profile only, never from the
    // raw XML, so a wrapped unsigned assertion cannot change who logs in.
    const nameId = String(result.profile.nameID || "").trim();
    if (!nameId) invalidSaml("missing NameID");
    const attributes: Record<string, SamlAttributeValue> = {};
    for (const [key, value] of Object.entries(result.profile.attributes || {})) {
      const normalized = profileValue(value);
      if (normalized !== null) attributes[key] = normalized;
    }
    return { issuer: metadata.entityId, nameId, attributes, signed: true };
  }
}

export function samlClaim(identity: SamlIdentity, keys: unknown[]): string {
  for (const key of keys) {
    const value = identity.attributes[String(key || "")];
    if (Array.isArray(value) && value.length > 0) return String(value[0] || "");
    if (typeof value === "string" && value) return value;
  }
  return "";
}
