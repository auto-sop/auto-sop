import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ─── module mocks (hoisted by vitest) ─── */

vi.mock('../../src/license/x25519-encrypt.js', () => ({
  encryptRequest: vi.fn(() => ({
    ephemeral_public: 'mock-ephemeral',
    nonce: 'mock-nonce',
    ciphertext: 'mock-ciphertext',
  })),
}));

vi.mock('../../src/license/server-public-key.js', () => ({
  API_BASE_URL: 'https://test.auto-sop.com/api/v1',
  SERVER_X25519_PUBLIC_KEY_B64: 'mock-server-key-b64',
}));

import { syncStats, type SyncStatsOpts } from '../../src/license/stats-sync.js';
import { encryptRequest } from '../../src/license/x25519-encrypt.js';

/* ─── typed mock refs ─── */

const mockedEncryptRequest = vi.mocked(encryptRequest);

/* ─── helpers ─── */

const OPTS: SyncStatsOpts = {
  key: 'test-license-key',
  machineId: 'test-machine-id',
  projects: [
    {
      project_slug: 'my-project',
      total_tokens_saved: 1500,
      total_errors_prevented: 12,
      total_time_saved_minutes: 45,
      directive_count: 8,
    },
  ],
};

function mockFetchResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body ?? {}),
  };
}

/* ─── per-test setup ─── */

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  // Restore default mock return value after resetAllMocks
  mockedEncryptRequest.mockReturnValue({
    ephemeral_public: 'mock-ephemeral',
    nonce: 'mock-nonce',
    ciphertext: 'mock-ciphertext',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ─── syncStats ─── */

describe('syncStats', () => {
  it('returns success on 200 response', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: true });
  });

  it('calls encryptRequest with correct payload', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200));

    await syncStats(OPTS);

    expect(mockedEncryptRequest).toHaveBeenCalledOnce();
    const [plaintext, serverKey] = mockedEncryptRequest.mock.calls[0]!;
    const parsed = JSON.parse(plaintext);
    expect(parsed.key).toBe('test-license-key');
    expect(parsed.machine_id).toBe('test-machine-id');
    expect(parsed.projects).toEqual(OPTS.projects);
    expect(serverKey).toBe('mock-server-key-b64');
  });

  it('sends encrypted body with correct Content-Type', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200));

    await syncStats(OPTS);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://test.auto-sop.com/api/v1/stats');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-asop-encrypted');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.ephemeral_public).toBe('mock-ephemeral');
    expect(sentBody.nonce).toBe('mock-nonce');
    expect(sentBody.ciphertext).toBe('mock-ciphertext');
  });

  it('returns error on 401 response', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(401));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'invalid_key' });
  });

  it('returns error on 403 response', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(403));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'forbidden' });
  });

  it('returns error on 429 response', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(429));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'rate_limited' });
  });

  it('returns error on 500 response', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(500));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'server_error_500' });
  });

  it('returns error on 502 response', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(502));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'server_error_502' });
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await syncStats(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('returns error on timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'timeout' });
  });

  it('never throws on any error', async () => {
    // Encryption failure
    mockedEncryptRequest.mockImplementation(() => {
      throw new Error('crypto failed');
    });

    const result = await syncStats(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('crypto failed');
  });

  it('handles non-Error thrown values', async () => {
    mockFetch.mockRejectedValue('string error');

    const result = await syncStats(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });

  it('handles multiple projects in payload', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200));

    const multiOpts: SyncStatsOpts = {
      ...OPTS,
      projects: [
        {
          project_slug: 'proj-a',
          total_tokens_saved: 100,
          total_errors_prevented: 5,
          total_time_saved_minutes: 10,
          directive_count: 3,
        },
        {
          project_slug: 'proj-b',
          total_tokens_saved: 200,
          total_errors_prevented: 10,
          total_time_saved_minutes: 20,
          directive_count: 6,
        },
      ],
    };

    const result = await syncStats(multiOpts);

    expect(result.success).toBe(true);
    const [plaintext] = mockedEncryptRequest.mock.calls[0]!;
    const parsed = JSON.parse(plaintext);
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0].project_slug).toBe('proj-a');
    expect(parsed.projects[1].project_slug).toBe('proj-b');
  });

  it('returns generic error for non-standard HTTP status', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(418));

    const result = await syncStats(OPTS);

    expect(result).toEqual({ success: false, error: 'http_418' });
  });

  it('includes directive_previews in payload when provided (V48)', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200));

    const optsWithPreviews: SyncStatsOpts = {
      ...OPTS,
      projects: [
        {
          project_slug: 'my-project',
          total_tokens_saved: 1500,
          total_errors_prevented: 12,
          total_time_saved_minutes: 45,
          directive_count: 8,
          directive_ids: ['llm-7ced', 'llm-abcd'],
          directive_previews: {
            'llm-7ced': 'Never add comments that describe WHAT a function...',
            'llm-abcd': 'Always use the dedicated Read tool to...',
          },
        },
      ],
    };

    const result = await syncStats(optsWithPreviews);

    expect(result.success).toBe(true);
    const [plaintext] = mockedEncryptRequest.mock.calls[0]!;
    const parsed = JSON.parse(plaintext);
    expect(parsed.projects[0].directive_previews).toEqual({
      'llm-7ced': 'Never add comments that describe WHAT a function...',
      'llm-abcd': 'Always use the dedicated Read tool to...',
    });
  });

  it('omits directive_previews from payload when not provided (V48)', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200));

    const result = await syncStats(OPTS);

    expect(result.success).toBe(true);
    const [plaintext] = mockedEncryptRequest.mock.calls[0]!;
    const parsed = JSON.parse(plaintext);
    expect(parsed.projects[0].directive_previews).toBeUndefined();
  });
});
