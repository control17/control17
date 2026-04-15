/**
 * TraceBuffer unit tests.
 */

import { describe, expect, it } from 'vitest';
import { TraceBuffer } from '../../src/runtime/trace/buffer.js';
import type { KeylogEntry } from '../../src/runtime/trace/keylog.js';
import type { ProxyChunk } from '../../src/runtime/trace/proxy.js';

function chunk(bytes: string, sessionId = 1): ProxyChunk {
  return {
    sessionId,
    ts: Date.now(),
    direction: 'client_to_upstream',
    upstream: { host: 'api.example.com', port: 443 },
    bytes: Buffer.from(bytes),
  };
}

function key(label: string): KeylogEntry {
  return {
    label,
    clientRandom: 'aaaa',
    secret: 'bbbb',
    seenAt: Date.now(),
    rawLine: `${label} aaaa bbbb`,
  };
}

describe('TraceBuffer', () => {
  it('opens and closes a span, capturing chunks + keys between', () => {
    const buf = new TraceBuffer({ log: () => {} });
    buf.openSpan('obj-1');
    expect(buf.hasOpenSpan('obj-1')).toBe(true);

    buf.ingestChunk(chunk('hello'));
    buf.ingestKey(key('CLIENT_HANDSHAKE_TRAFFIC_SECRET'));
    buf.ingestChunk(chunk('world'));

    const snap = buf.closeSpan('obj-1');
    expect(snap).not.toBeNull();
    expect(snap?.chunks).toHaveLength(2);
    expect(snap?.keys).toHaveLength(1);
    expect(snap?.bytesRecorded).toBe(10);
    expect(snap?.truncated).toBe(false);
    expect(buf.hasOpenSpan('obj-1')).toBe(false);
  });

  it('drops chunks + keys when no spans are open', () => {
    const buf = new TraceBuffer({ log: () => {} });
    // No span open.
    buf.ingestChunk(chunk('ignored'));
    buf.ingestKey(key('CLIENT_RANDOM'));
    // Opening a span now shouldn't retroactively include prior data.
    buf.openSpan('obj-1');
    const snap = buf.closeSpan('obj-1');
    expect(snap?.chunks).toHaveLength(0);
    expect(snap?.keys).toHaveLength(0);
  });

  it('broadcasts chunks to all currently-open spans', () => {
    const buf = new TraceBuffer({ log: () => {} });
    buf.openSpan('a');
    buf.openSpan('b');
    buf.ingestChunk(chunk('shared'));
    const snapA = buf.closeSpan('a');
    const snapB = buf.closeSpan('b');
    expect(snapA?.chunks).toHaveLength(1);
    expect(snapB?.chunks).toHaveLength(1);
    expect(snapA?.chunks[0]?.bytes.toString()).toBe('shared');
  });

  it('truncates per-span when the byte cap is exceeded', () => {
    const buf = new TraceBuffer({ byteSoftCapPerSpan: 8, log: () => {} });
    buf.openSpan('obj-1');
    buf.ingestChunk(chunk('12345')); // 5 bytes, fits
    buf.ingestChunk(chunk('6789ab')); // 6 bytes, 5+6=11 > 8 → truncated
    buf.ingestChunk(chunk('cdef')); // dropped after truncation
    const snap = buf.closeSpan('obj-1');
    expect(snap?.truncated).toBe(true);
    expect(snap?.chunks).toHaveLength(1);
    expect(snap?.bytesRecorded).toBe(5);
  });

  it('still accepts keys after a span is truncated', () => {
    const buf = new TraceBuffer({ byteSoftCapPerSpan: 4, log: () => {} });
    buf.openSpan('obj-1');
    buf.ingestChunk(chunk('12345')); // overflows immediately
    buf.ingestKey(key('CLIENT_RANDOM'));
    const snap = buf.closeSpan('obj-1');
    expect(snap?.truncated).toBe(true);
    expect(snap?.keys).toHaveLength(1);
  });

  it('copies chunk bytes so the caller can recycle the source buffer', () => {
    const buf = new TraceBuffer({ log: () => {} });
    const source = Buffer.from('mutable');
    buf.openSpan('obj-1');
    buf.ingestChunk({
      sessionId: 1,
      ts: Date.now(),
      direction: 'client_to_upstream',
      upstream: { host: 'x', port: 1 },
      bytes: source,
    });
    source.fill(0); // simulate the relay recycling its read buffer
    const snap = buf.closeSpan('obj-1');
    expect(snap?.chunks[0]?.bytes.toString()).toBe('mutable');
  });

  it('openSpan on an already-open id is a no-op (no buffer reset)', () => {
    const buf = new TraceBuffer({ log: () => {} });
    buf.openSpan('obj-1');
    buf.ingestChunk(chunk('first'));
    buf.openSpan('obj-1'); // should not reset
    buf.ingestChunk(chunk('second'));
    const snap = buf.closeSpan('obj-1');
    expect(snap?.chunks).toHaveLength(2);
  });

  it('closeSpan returns null for unknown ids', () => {
    const buf = new TraceBuffer({ log: () => {} });
    expect(buf.closeSpan('nope')).toBeNull();
  });
});
