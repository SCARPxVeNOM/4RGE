/**
 * The Intel SGX Root CA — the trust anchor for TDX quote verification.
 *
 * PROVENANCE (this is the part that matters)
 *
 * Fetched 2026-08-27 from Intel's own distribution point:
 *
 *   https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem
 *
 * and confirmed byte-identical to the root certificate embedded in a live TDX
 * quote captured from 0G Galileo (artifacts/attestation/*.raw.json).
 *
 * That cross-check is the whole point of vendoring. Every TDX quote carries
 * its own PCK chain, root included, so a verifier that simply used the root it
 * was handed would be checking a signature against a key supplied by the party
 * being verified — which proves nothing at all. Pinning the root here turns
 * the chain into evidence.
 *
 *   subject/issuer  CN=Intel SGX Root CA, O=Intel Corporation,
 *                   L=Santa Clara, ST=CA, C=US   (self-signed)
 *   validity        2018-05-21 .. 2049-12-31
 *   key             P-256
 *   DER length      659 bytes
 *   sha256(DER)     44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3
 *
 * TO RE-VERIFY THIS FILE, from a shell:
 *
 *   curl -s https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem \
 *     | openssl x509 -outform DER | sha256sum
 *
 * The digest must equal INTEL_SGX_ROOT_CA_SHA256 below, and a test asserts the
 * constant here hashes to it — so a corrupted or swapped root fails the build
 * rather than silently becoming the anchor of trust.
 */

import { base64ToBytes } from './x509.js';

const INTEL_SGX_ROOT_CA_BASE64 =
  'MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIwaDEaMBgGA1UE' +
  'AwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQH' +
  'DAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYTAlVTMB4XDTE4MDUyMTEwNDUxMFoX' +
  'DTQ5MTIzMTIzNTk1OVowaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUlu' +
  'dGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNV' +
  'BAYTAlVTMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi71OiOSLRF' +
  'hWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxFP2sJBK5zlKOBuzCBuDAfBgNVHSMEGDAW' +
  'gBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJMEegRaBDhkFodHRwczovL2NlcnRpZmlj' +
  'YXRlcy50cnVzdGVkc2VydmljZXMuaW50ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4E' +
  'FgQUImUM1lqdNInzg7SVUr9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8C' +
  'AQEwCgYIKoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9CiSDcNoowLuPRLsWGf/Yi7GSX94BgwTwgAiEA' +
  '4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=';

/** sha256 of the DER form. Asserted by a test against the constant below. */
export const INTEL_SGX_ROOT_CA_SHA256 =
  '0x44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3';

/** The pinned root, as DER. */
export const INTEL_SGX_ROOT_CA_DER: Uint8Array = base64ToBytes(INTEL_SGX_ROOT_CA_BASE64);
