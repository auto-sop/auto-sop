import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { installNoNetworkGuards, restoreNetworkGuards } from './no-network.js';

describe('no-network harness', () => {
  installNoNetworkGuards();

  afterAll(() => {
    restoreNetworkGuards();
  });

  it('should throw on fetch', () => {
    expect(() => fetch('https://example.com')).toThrow(/NETWORK ACCESS FORBIDDEN.*fetch/);
  });

  it('should throw on http.request', () => {
    expect(() => http.request('http://example.com')).toThrow(
      /NETWORK ACCESS FORBIDDEN.*http\.request/,
    );
  });

  it('should throw on https.request', () => {
    expect(() => https.request('https://example.com')).toThrow(
      /NETWORK ACCESS FORBIDDEN.*https\.request/,
    );
  });

  it('should throw on net.Socket.connect', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(80, 'example.com')).toThrow(
      /NETWORK ACCESS FORBIDDEN.*net\.Socket\.connect/,
    );
  });

  it('should throw on dns.lookup', () => {
    expect(() => dns.lookup('example.com', () => {})).toThrow(
      /NETWORK ACCESS FORBIDDEN.*dns\.lookup/,
    );
  });
});
