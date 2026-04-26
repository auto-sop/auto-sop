/**
 * Server public keys and API configuration for license validation.
 * Ed25519: verify server-signed license responses.
 * X25519: encrypt license validation requests (BIND-8).
 */

/** Base64-encoded PEM of the server's Ed25519 public key (response signing). */
export const SERVER_PUBLIC_KEY_B64 =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQXU2cmhQTElaRTNtTlRJbDZHM05hdzlxOVN5ejVVZ0hsbjNPeXBaRDk5dWc9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=';

/** Base64-encoded PEM of the server's X25519 public key (BIND-8 request encryption). */
export const SERVER_X25519_PUBLIC_KEY_B64 =
  'MCowBQYDK2VuAyEAE5wsIYiHnr6fFF7gbS6+kq8KLH66jvBJPH5itEHvrHc=';

/** License validation API base URL. Override with AUTO_SOP_API_URL env var. */
export const API_BASE_URL = process.env.AUTO_SOP_API_URL || 'https://auto-sop.com/api/v1';
