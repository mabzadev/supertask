import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignedXml } from "xml-crypto";

const privateKey = readFileSync(join(process.cwd(), "tests", "fixtures", "saml-idp-private-key.pem"), "utf8");
export const samlCertificate = readFileSync(join(process.cwd(), "tests", "fixtures", "saml-idp-certificate.pem"), "utf8");
export const samlCertificateBody = samlCertificate.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");

/** `<KeyDescriptor>` advertising the test IdP signing certificate, for IdP metadata fixtures. */
export const samlSigningKeyDescriptor =
  `<KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${samlCertificateBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>`;

/** Signs the single assertion of a SAML response with the test IdP key. */
export function signSamlAssertion(xml: string) {
  const signer = new SignedXml({ privateKey, publicCert: samlCertificate });
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
