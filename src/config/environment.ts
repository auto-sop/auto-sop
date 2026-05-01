/**
 * Environment URL configuration.
 * Single source of truth for all API and app URLs.
 *
 * Priority chain (highest wins):
 *   AUTO_SOP_API_URL env var > build-time __API_BASE_URL__ > production fallback
 *   AUTO_SOP_APP_URL env var > build-time __APP_BASE_URL__ > production fallback
 *
 * Build-time values (__API_BASE_URL__, __APP_BASE_URL__, __ENVIRONMENT__) are
 * injected by tsup define (see tsup.config.ts).
 */

declare const __API_BASE_URL__: string;
declare const __APP_BASE_URL__: string;
declare const __ENVIRONMENT__: string;

export const API_BASE_URL: string =
  process.env.AUTO_SOP_API_URL ||
  (typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : 'https://auto-sop.com/api/v1');

export const APP_BASE_URL: string =
  process.env.AUTO_SOP_APP_URL ||
  (typeof __APP_BASE_URL__ !== 'undefined' ? __APP_BASE_URL__ : 'https://auto-sop.com');

export const ENVIRONMENT: 'staging' | 'production' =
  typeof __ENVIRONMENT__ !== 'undefined'
    ? (__ENVIRONMENT__ as 'staging' | 'production')
    : 'production';
