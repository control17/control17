/**
 * TraceHost integration tests.
 *
 * Starts the trace host end-to-end, verifies it writes a CA cert
 * file Node can parse, produces the expected env delta, and
 * cleans up everything on close. Full MITM flow (spawning a real
 * upstream + routing an HTTPS client through the proxy) lives in
 * trace-proxy.test.ts — the host-level tests here focus on
 * lifecycle + configuration.
 */

import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client as BrokerClient } from '@control17/sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTraceHost } from '../../src/runtime/trace/host.js';

/**
 * Stub broker client — the trace host needs one to hand to its
 * activity uploader, but these tests don't exercise real uploads.
 * We swallow every `uploadAgentActivity` call and resolve.
 */
function stubBrokerClient(): BrokerClient {
  return {
    uploadAgentActivity: vi.fn(async (_callsign: string, req: { events: unknown[] }) => ({
      accepted: req.events.length,
    })),
  } as unknown as BrokerClient;
}

describe('TraceHost', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'c17-trace-host-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts a proxy + writes the CA cert PEM on disk', async () => {
    const caCertPath = join(tmpDir, 'ca.pem');
    const host = await startTraceHost({
      log: () => {},
      caCertPath,
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
    });
    try {
      expect(host.proxy.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(existsSync(caCertPath)).toBe(true);
      const pem = readFileSync(caCertPath, 'utf8');
      const parsed = new X509Certificate(pem);
      expect(parsed.ca).toBe(true);
      expect(parsed.subject).toContain('CN=c17 trace CA');
    } finally {
      await host.close();
    }
  });

  it('envVars includes HTTPS_PROXY, CA cert path, and NO_PROXY loopback bypass', async () => {
    const caCertPath = join(tmpDir, 'env-ca.pem');
    const host = await startTraceHost({
      log: () => {},
      caCertPath,
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
    });
    try {
      const env = host.envVars({});
      expect(env.HTTPS_PROXY).toBe(host.proxy.proxyUrl);
      expect(env.HTTP_PROXY).toBe(host.proxy.proxyUrl);
      expect(env.ALL_PROXY).toBe(host.proxy.proxyUrl);
      expect(env.HTTPS_PROXY?.startsWith('http://')).toBe(true);
      expect(env.NODE_USE_ENV_PROXY).toBe('1');
      expect(env.NODE_EXTRA_CA_CERTS).toBe(caCertPath);
      // Default posture: TLS validation stays ON in the agent child.
      // The MITM CA is trusted via NODE_EXTRA_CA_CERTS; bypass is opt-in only.
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(env.NO_PROXY).toContain('127.0.0.1');
      expect(env.NO_PROXY).toContain('localhost');
      expect(env.NO_PROXY).toContain('::1');
    } finally {
      await host.close();
    }
  });

  it('envVars sets NODE_TLS_REJECT_UNAUTHORIZED=0 only when unsafeTls is opted in', async () => {
    const host = await startTraceHost({
      log: () => {},
      caCertPath: join(tmpDir, 'unsafe-ca.pem'),
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
      unsafeTls: true,
    });
    try {
      const env = host.envVars({});
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    } finally {
      await host.close();
    }
  });

  it('envVars merges with an existing NO_PROXY instead of overwriting', async () => {
    const host = await startTraceHost({
      log: () => {},
      caCertPath: join(tmpDir, 'merge-ca.pem'),
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
    });
    try {
      const env = host.envVars({ NO_PROXY: 'internal.corp,10.0.0.0/8' });
      expect(env.NO_PROXY).toContain('internal.corp');
      expect(env.NO_PROXY).toContain('10.0.0.0/8');
      expect(env.NO_PROXY).toContain('127.0.0.1');
    } finally {
      await host.close();
    }
  });

  it('deletes the CA cert file on close()', async () => {
    const caCertPath = join(tmpDir, 'ephemeral.pem');
    const host = await startTraceHost({
      log: () => {},
      caCertPath,
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
    });
    expect(existsSync(caCertPath)).toBe(true);
    await host.close();
    expect(existsSync(caCertPath)).toBe(false);
  });

  it('close() is idempotent', async () => {
    const host = await startTraceHost({
      log: () => {},
      caCertPath: join(tmpDir, 'idem.pem'),
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
    });
    await host.close();
    await host.close(); // second call must not throw
  });

  it('exposes the certPool so the proxy can mint leaves', async () => {
    const host = await startTraceHost({
      log: () => {},
      caCertPath: join(tmpDir, 'pool.pem'),
      brokerClient: stubBrokerClient(),
      callsign: 'TEST',
    });
    try {
      const leaf = host.certPool.issueLeaf('api.anthropic.com');
      expect(leaf.certPem).toContain('BEGIN CERTIFICATE');
      expect(leaf.keyPem).toContain('BEGIN RSA PRIVATE KEY');
    } finally {
      await host.close();
    }
  });
});
