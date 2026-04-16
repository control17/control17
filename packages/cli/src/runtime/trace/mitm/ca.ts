/**
 * Per-session local CA + on-demand leaf cert issuance for MITM TLS
 * termination.
 *
 * The runner creates a fresh CA at startup, writes its public cert
 * PEM to a tmp file, and points the agent child at it via
 * `NODE_EXTRA_CA_CERTS`. When the proxy intercepts a `CONNECT host:
 * 443` tunnel, it asks this module for a leaf cert valid for `host`
 * (cached per hostname across the runner's lifetime), signed by the
 * CA. The agent sees the leaf cert during its TLS handshake, trusts
 * it because the root lives in its extra CA store, and completes
 * the handshake against our MITM. Meanwhile the MITM has its own
 * real TLS client connected to the upstream — so the agent talks to
 * us, we talk to the upstream, and both legs are real TLS.
 *
 * Key design decisions:
 *
 *   - **One CA + one leaf keypair, reused for all hostnames.**
 *     Generating RSA keys is expensive (~50ms via Node's built-in
 *     crypto) and per-hostname keys would add real latency to the
 *     first request to a new host. Reusing the leaf keypair across
 *     every leaf cert is unusual in public-internet PKI but
 *     completely fine for a loopback-scoped session-lifetime CA.
 *     The security boundary is "this user's runner process"; the
 *     leaf private key never leaves the runner.
 *
 *   - **Ephemeral CA — generated fresh every runner start.** We
 *     never persist the CA to disk beyond the session's tmpdir, and
 *     the tmp file is unlinked on `TraceHost.close()`. If the runner
 *     crashes, the CA is orphaned in tmpdir but carries no secrets
 *     the kernel can't already see (it's a single user's loopback
 *     TLS cert).
 *
 *   - **Fast key generation via Node's crypto module.** node-forge
 *     can generate keys in pure JS but it's noticeably slow; we do
 *     the keygen in Node's OpenSSL-backed API, export PEMs, and
 *     re-import them into forge's cert-signing pipeline. ~50ms per
 *     keypair on modern hardware.
 *
 *   - **SANs for both DNS and IP forms.** If the agent CONNECTs to
 *     `127.0.0.1:443`, the leaf cert must have `127.0.0.1` as an IP
 *     SAN, not a DNS SAN. We detect the shape of the hostname and
 *     populate the right SAN type.
 */

import { generateKeyPairSync } from 'node:crypto';
import { isIP } from 'node:net';
import forge from 'node-forge';

export interface TraceCa {
  /** PEM-encoded CA certificate — safe to share with the agent via NODE_EXTRA_CA_CERTS. */
  readonly caCertPem: string;
  /** Opaque internal — node-forge cert object used as the leaf issuer. */
  readonly caCert: forge.pki.Certificate;
  /** Opaque internal — node-forge private key used to sign leaves. */
  readonly caPrivateKey: forge.pki.rsa.PrivateKey;
  /** Shared leaf private key, reused across every leaf cert. */
  readonly leafPrivateKey: forge.pki.rsa.PrivateKey;
  readonly leafPublicKey: forge.pki.rsa.PublicKey;
  /** PEM-encoded leaf private key — same for every leaf cert. */
  readonly leafKeyPem: string;
}

export interface IssuedCert {
  /** PEM-encoded leaf certificate for a single hostname. */
  readonly certPem: string;
  /** PEM-encoded private key (shared across all leaves). */
  readonly keyPem: string;
}

export interface CertPool {
  /**
   * Get a leaf cert valid for `hostname`. Cached per hostname across
   * the CertPool's lifetime, so the second MITM flow to the same
   * host reuses the cert without re-signing. Safe to call from
   * multiple concurrent sessions.
   */
  issueLeaf(hostname: string): IssuedCert;
  readonly ca: TraceCa;
}

interface ForgeKeys {
  forgePrivate: forge.pki.rsa.PrivateKey;
  forgePublic: forge.pki.rsa.PublicKey;
  privatePem: string;
}

/**
 * Generate RSA keys via Node's OpenSSL-backed crypto API, then
 * rebuild a forge private key from the resulting PKCS#1 components.
 *
 * Why not just import the PEM with `forge.pki.privateKeyFromPem`?
 * Because Node exports PKCS#8 by default, and round-tripping
 * PKCS#8 → forge's ASN.1 parser can lose the CRT parameters
 * (p/q/dP/dQ/qInv) that forge needs to sign with. The
 * resulting "key" will look valid but produce corrupt signatures
 * that Node's X509 parser rejects with `asn1 encoding routines::
 * illegal padding`.
 *
 * Workaround: export the Node key as JWK, pull out the raw BigInt
 * components, and use `forge.pki.setRsaPrivateKey` to build a
 * forge private key from scratch. This is exactly equivalent to
 * what `forge.pki.rsa.generateKeyPair` produces internally — we
 * just sourced the underlying BigInts from fast Node crypto instead
 * of slow pure-JS forge keygen.
 */
function generateRsaKeysFast(): ForgeKeys {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.n || !jwk.e || !jwk.d || !jwk.p || !jwk.q || !jwk.dp || !jwk.dq || !jwk.qi) {
    throw new Error('node crypto produced an incomplete RSA JWK');
  }
  const toBi = (b64url: string): forge.jsbn.BigInteger => {
    const buf = Buffer.from(b64url, 'base64url');
    return new forge.jsbn.BigInteger(buf.toString('hex'), 16);
  };
  const n = toBi(jwk.n);
  const e = toBi(jwk.e);
  const d = toBi(jwk.d);
  const p = toBi(jwk.p);
  const q = toBi(jwk.q);
  const dP = toBi(jwk.dp);
  const dQ = toBi(jwk.dq);
  const qInv = toBi(jwk.qi);
  const forgePrivate = forge.pki.setRsaPrivateKey(n, e, d, p, q, dP, dQ, qInv);
  const forgePublic = forge.pki.setRsaPublicKey(n, e);
  const privatePem = forge.pki.privateKeyToPem(forgePrivate);
  return { forgePrivate, forgePublic, privatePem };
}

/**
 * Create a fresh per-session CA. Generates the CA keypair, the
 * shared leaf keypair, and a self-signed CA cert that leaves can
 * point back at via `setIssuer`.
 */
export function createTraceCa(): TraceCa {
  const caKeys = generateRsaKeysFast();
  const leafKeys = generateRsaKeysFast();

  const now = new Date();
  // 24-hour validity — the CA is session-scoped, and a short
  // validity limits damage if the cert PEM is somehow leaked.
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const caAttrs = [
    { name: 'commonName', value: 'c17 trace CA' },
    { name: 'organizationName', value: 'control17' },
  ];
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.forgePublic;
  caCert.serialNumber = `01${Date.now().toString(16)}`;
  caCert.validity.notBefore = now;
  caCert.validity.notAfter = validUntil;
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.forgePrivate, forge.md.sha256.create());

  return {
    caCert,
    caCertPem: forge.pki.certificateToPem(caCert),
    caPrivateKey: caKeys.forgePrivate,
    leafPrivateKey: leafKeys.forgePrivate,
    leafPublicKey: leafKeys.forgePublic,
    leafKeyPem: leafKeys.privatePem,
  };
}

/**
 * Build a CertPool over an existing CA. Issues leaves lazily and
 * caches them so repeat hits on the same hostname are zero-cost.
 */
export function createCertPool(ca: TraceCa): CertPool {
  const cache = new Map<string, IssuedCert>();
  let serial = 2;

  const issueLeaf = (hostname: string): IssuedCert => {
    const cached = cache.get(hostname);
    if (cached) return cached;

    const now = new Date();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // IP vs DNS SAN — `isIP` returns 4 for IPv4, 6 for IPv6, 0 for
    // non-IPs (DNS hostnames). SubjectAltName `type: 7` is IP,
    // `type: 2` is DNS. @types/node-forge's public types model the
    // subject fields (string type), not the subjectAltName field
    // shape (numeric type), so we build as an untyped object and
    // pass through the extension builder.
    const ipVersion = isIP(hostname);
    const altName: Record<string, unknown> =
      ipVersion !== 0 ? { type: 7, ip: hostname } : { type: 2, value: hostname };

    const leafCert = forge.pki.createCertificate();
    leafCert.publicKey = ca.leafPublicKey;
    // Serial must be a hex string with no leading zeros. node-forge
    // encodes the literal hex as an ASN.1 INTEGER, and OpenSSL
    // rejects INTEGERs with illegal leading zero padding
    // ("asn1 encoding routines::illegal padding"). Prefixing with a
    // non-zero byte ("10") ensures every serial is unambiguously
    // positive and well-formed.
    leafCert.serialNumber = `10${serial.toString(16)}`;
    serial++;
    leafCert.validity.notBefore = now;
    leafCert.validity.notAfter = validUntil;
    leafCert.setSubject([
      { name: 'commonName', value: hostname },
      { name: 'organizationName', value: 'control17 trace' },
    ]);
    leafCert.setIssuer(ca.caCert.subject.attributes);
    // biome-ignore lint/suspicious/noExplicitAny: node-forge's
    // extension shape for subjectAltName uses numeric `type`
    // discriminators that don't fit its public TS types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exts: any = [
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [altName] },
      { name: 'subjectKeyIdentifier' },
    ];
    leafCert.setExtensions(exts);
    leafCert.sign(ca.caPrivateKey, forge.md.sha256.create());

    const out: IssuedCert = {
      certPem: forge.pki.certificateToPem(leafCert),
      keyPem: ca.leafKeyPem,
    };
    cache.set(hostname, out);
    return out;
  };

  return { issueLeaf, ca };
}
