/**
 * Zero-network test harness.
 * Overrides all Node.js network primitives to throw on any attempt.
 * Pure test infrastructure — does NOT import anything from src/.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

const FORBIDDEN_MSG = (call: string) => `PHASE 0 NETWORK ACCESS FORBIDDEN: ${call}`;

let originalFetch: typeof globalThis.fetch | undefined;
let originalHttpRequest: typeof http.request;
let originalHttpGet: typeof http.get;
let originalHttpsRequest: typeof https.request;
let originalHttpsGet: typeof https.get;
let originalNetConnect: typeof net.Socket.prototype.connect;
let originalDnsLookup: typeof dns.lookup;
let originalDnsResolve: typeof dns.resolve;
let originalDnsResolve4: typeof dns.resolve4;
let originalDnsResolve6: typeof dns.resolve6;
let originalDnsResolveAny: typeof dns.resolveAny;
let originalDnsPromisesResolve: typeof dns.promises.resolve;
let originalDnsPromisesResolve4: typeof dns.promises.resolve4;
let originalDnsPromisesResolve6: typeof dns.promises.resolve6;
let originalDnsPromisesResolveAny: typeof dns.promises.resolveAny;
let installed = false;

export function installNoNetworkGuards(): void {
  if (installed) return;
  installed = true;

  // Save originals
  originalFetch = globalThis.fetch;
  originalHttpRequest = http.request;
  originalHttpGet = http.get;
  originalHttpsRequest = https.request;
  originalHttpsGet = https.get;
  originalNetConnect = net.Socket.prototype.connect;
  originalDnsLookup = dns.lookup;
  originalDnsResolve = dns.resolve;
  originalDnsResolve4 = dns.resolve4;
  originalDnsResolve6 = dns.resolve6;
  originalDnsResolveAny = dns.resolveAny;
  originalDnsPromisesResolve = dns.promises.resolve;
  originalDnsPromisesResolve4 = dns.promises.resolve4;
  originalDnsPromisesResolve6 = dns.promises.resolve6;
  originalDnsPromisesResolveAny = dns.promises.resolveAny;

  // Stub globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error(FORBIDDEN_MSG('fetch'));
  }) as typeof globalThis.fetch;

  // Stub http.request / http.get
  http.request = (() => {
    throw new Error(FORBIDDEN_MSG('http.request'));
  }) as typeof http.request;
  http.get = (() => {
    throw new Error(FORBIDDEN_MSG('http.get'));
  }) as typeof http.get;

  // Stub https.request / https.get
  https.request = (() => {
    throw new Error(FORBIDDEN_MSG('https.request'));
  }) as typeof https.request;
  https.get = (() => {
    throw new Error(FORBIDDEN_MSG('https.get'));
  }) as typeof https.get;

  // Stub net.Socket.prototype.connect
  net.Socket.prototype.connect = (() => {
    throw new Error(FORBIDDEN_MSG('net.Socket.connect'));
  }) as typeof net.Socket.prototype.connect;

  // Stub dns.lookup
  dns.lookup = (() => {
    throw new Error(FORBIDDEN_MSG('dns.lookup'));
  }) as typeof dns.lookup;

  // Stub dns.resolve variants (SEC-003)
  dns.resolve = (() => {
    throw new Error(FORBIDDEN_MSG('dns.resolve'));
  }) as typeof dns.resolve;
  dns.resolve4 = (() => {
    throw new Error(FORBIDDEN_MSG('dns.resolve4'));
  }) as typeof dns.resolve4;
  dns.resolve6 = (() => {
    throw new Error(FORBIDDEN_MSG('dns.resolve6'));
  }) as typeof dns.resolve6;
  dns.resolveAny = (() => {
    throw new Error(FORBIDDEN_MSG('dns.resolveAny'));
  }) as typeof dns.resolveAny;

  // Stub dns.promises equivalents (SEC-003)
  dns.promises.resolve = (() => {
    throw new Error(FORBIDDEN_MSG('dns.promises.resolve'));
  }) as typeof dns.promises.resolve;
  dns.promises.resolve4 = (() => {
    throw new Error(FORBIDDEN_MSG('dns.promises.resolve4'));
  }) as typeof dns.promises.resolve4;
  dns.promises.resolve6 = (() => {
    throw new Error(FORBIDDEN_MSG('dns.promises.resolve6'));
  }) as typeof dns.promises.resolve6;
  dns.promises.resolveAny = (() => {
    throw new Error(FORBIDDEN_MSG('dns.promises.resolveAny'));
  }) as typeof dns.promises.resolveAny;
}

export function restoreNetworkGuards(): void {
  if (!installed) return;
  installed = false;

  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }
  http.request = originalHttpRequest;
  http.get = originalHttpGet;
  https.request = originalHttpsRequest;
  https.get = originalHttpsGet;
  net.Socket.prototype.connect = originalNetConnect;
  dns.lookup = originalDnsLookup;
  dns.resolve = originalDnsResolve;
  dns.resolve4 = originalDnsResolve4;
  dns.resolve6 = originalDnsResolve6;
  dns.resolveAny = originalDnsResolveAny;
  dns.promises.resolve = originalDnsPromisesResolve;
  dns.promises.resolve4 = originalDnsPromisesResolve4;
  dns.promises.resolve6 = originalDnsPromisesResolve6;
  dns.promises.resolveAny = originalDnsPromisesResolveAny;
}

// Auto-install when loaded as a vitest setupFile
installNoNetworkGuards();
