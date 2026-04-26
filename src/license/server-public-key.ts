/**
 * Server public key and API configuration for license validation.
 * The Ed25519 public key is used to verify server-signed license responses.
 */

/** Base64-encoded PEM of the server's Ed25519 public key. */
export const SERVER_PUBLIC_KEY_B64 =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQXU2cmhQTElaRTNtTlRJbDZHM05hdzlxOVN5ejVVZ0hsbjNPeXBaRDk5dWc9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=';

/** License validation API base URL. Override with AUTO_SOP_API_URL env var. */
export const API_BASE_URL = process.env.AUTO_SOP_API_URL || 'https://auto-sop.com/api/v1';
