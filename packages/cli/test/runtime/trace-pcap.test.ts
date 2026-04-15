/**
 * Pcap writer unit tests.
 *
 * Without tshark available on the box we can't assert "tshark
 * successfully decrypts this," but we can round-trip the binary
 * format ourselves: parse the global header, count records, and
 * verify each packet has a valid IPv4 + TCP header with the
 * expected src/dst, flags, and payload bytes.
 *
 * Catching format bugs here is the whole value — anything that makes
 * it into tshark with a malformed global header or a bad record
 * length fails silently (tshark just reports zero packets) and we'd
 * spend hours chasing it down at integration time.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePcap } from '../../src/runtime/trace/pcap.js';
import type { ProxyChunk } from '../../src/runtime/trace/proxy.js';

describe('writePcap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'c17-pcap-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid pcap global header even for an empty span', () => {
    const path = join(tmpDir, 'empty.pcap');
    const count = writePcap(path, []);
    expect(count).toBe(0);

    const file = readFileSync(path);
    expect(file.length).toBe(24); // just the global header
    expect(file.readUInt32LE(0)).toBe(0xa1b2c3d4); // magic
    expect(file.readUInt16LE(4)).toBe(2); // version major
    expect(file.readUInt16LE(6)).toBe(4); // version minor
    expect(file.readUInt32LE(20)).toBe(101); // LINKTYPE_RAW
  });

  it('emits handshake + PSH + FIN packets for a one-session flow', () => {
    const path = join(tmpDir, 'flow.pcap');
    const chunks: ProxyChunk[] = [
      {
        sessionId: 1,
        ts: 1_700_000_000_000,
        direction: 'client_to_upstream',
        upstream: { host: 'api.example.com', port: 443 },
        bytes: Buffer.from('CLIENT-DATA'),
      },
      {
        sessionId: 1,
        ts: 1_700_000_000_010,
        direction: 'upstream_to_client',
        upstream: { host: 'api.example.com', port: 443 },
        bytes: Buffer.from('SERVER-REPLY'),
      },
    ];
    const count = writePcap(path, chunks);
    // 3 handshake + 2 data + 2 close = 7
    expect(count).toBe(7);

    const packets = parsePcap(readFileSync(path));
    expect(packets).toHaveLength(7);

    // Handshake: SYN, SYN+ACK, ACK
    expect(packets[0]?.flags).toBe(0x02); // SYN
    expect(packets[1]?.flags).toBe(0x12); // SYN+ACK
    expect(packets[2]?.flags).toBe(0x10); // ACK

    // Data packets carry the payload and PSH+ACK flag.
    expect(packets[3]?.payload.toString('utf8')).toBe('CLIENT-DATA');
    expect(packets[3]?.flags).toBe(0x18); // PSH+ACK
    expect(packets[4]?.payload.toString('utf8')).toBe('SERVER-REPLY');

    // Close: FIN+ACK, ACK
    expect(packets[5]?.flags).toBe(0x11);
    expect(packets[6]?.flags).toBe(0x10);
  });

  it('uses real upstream port as the synthetic destination port', () => {
    const path = join(tmpDir, 'port.pcap');
    const chunks: ProxyChunk[] = [
      {
        sessionId: 1,
        ts: 1_700_000_000_000,
        direction: 'client_to_upstream',
        upstream: { host: 'api.example.com', port: 443 },
        bytes: Buffer.from('ABC'),
      },
    ];
    writePcap(path, chunks);
    const packets = parsePcap(readFileSync(path));
    // First SYN goes client -> upstream, so dstPort should be 443.
    expect(packets[0]?.dstPort).toBe(443);
  });

  it('interleaves packets from multiple sessions by timestamp', () => {
    const path = join(tmpDir, 'multi.pcap');
    const chunks: ProxyChunk[] = [
      // Session 1 first chunk
      {
        sessionId: 1,
        ts: 100,
        direction: 'client_to_upstream',
        upstream: { host: 'a', port: 443 },
        bytes: Buffer.from('A1'),
      },
      // Session 2 first chunk — comes earlier in time
      {
        sessionId: 2,
        ts: 50,
        direction: 'client_to_upstream',
        upstream: { host: 'b', port: 443 },
        bytes: Buffer.from('B1'),
      },
    ];
    writePcap(path, chunks);

    const file = readFileSync(path);
    // Parse all record timestamps — they should be monotonic.
    let offset = 24;
    const timestamps: number[] = [];
    while (offset < file.length) {
      const tsSec = file.readUInt32LE(offset);
      const tsUsec = file.readUInt32LE(offset + 4);
      timestamps.push(tsSec * 1000 + Math.floor(tsUsec / 1000));
      const inclLen = file.readUInt32LE(offset + 8);
      offset += 16 + inclLen;
    }
    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1] ?? 0;
      const cur = timestamps[i] ?? 0;
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it('fragments oversized chunks into multiple IP packets', () => {
    // Node sockets commonly deliver 64KB reads in a single chunk,
    // which is larger than the 16-bit IP total_length ceiling. The
    // writer must split such chunks across multiple packets and
    // advance seq numbers so tshark still reassembles the flow.
    // Regression guard for the "value out of range >= 0 && <= 65535"
    // crash that fired on a ~65KB chunk in real traffic.
    const path = join(tmpDir, 'big.pcap');
    // Build a 100KB payload with a repeating marker so we can
    // assert the concatenated result is bit-for-bit identical.
    const big = Buffer.alloc(100_000, 0x5a); // 100,000 bytes of 'Z'
    const chunks: ProxyChunk[] = [
      {
        sessionId: 1,
        ts: 1_700_000_000_000,
        direction: 'client_to_upstream',
        upstream: { host: 'api.example.com', port: 443 },
        bytes: big,
      },
    ];
    expect(() => writePcap(path, chunks)).not.toThrow();

    const packets = parsePcap(readFileSync(path));
    // Handshake is 3 packets. A 100_000-byte chunk fragments into
    // ceil(100_000 / 65495) = 2 packets. Close is 2 packets. Total 7.
    expect(packets).toHaveLength(7);

    const data = packets.slice(3, 5);
    expect(data[0]?.payload.length).toBe(65_495);
    expect(data[1]?.payload.length).toBe(100_000 - 65_495);
    // Every byte is 0x5a in both halves.
    expect(data[0]?.payload.every((b) => b === 0x5a)).toBe(true);
    expect(data[1]?.payload.every((b) => b === 0x5a)).toBe(true);
    // Second fragment's seq = first fragment's seq + first length.
    expect(data[1]?.seq).toBe(((data[0]?.seq ?? 0) + 65_495) >>> 0);
  });

  it('tracks seq/ack numbers correctly across multiple data chunks', () => {
    const path = join(tmpDir, 'seq.pcap');
    const chunks: ProxyChunk[] = [
      {
        sessionId: 1,
        ts: 10,
        direction: 'client_to_upstream',
        upstream: { host: 'a', port: 443 },
        bytes: Buffer.from('AAA'),
      },
      {
        sessionId: 1,
        ts: 20,
        direction: 'client_to_upstream',
        upstream: { host: 'a', port: 443 },
        bytes: Buffer.from('BBBB'),
      },
    ];
    writePcap(path, chunks);
    const packets = parsePcap(readFileSync(path));
    // Skip 3 handshake packets, look at two data packets.
    const dataA = packets[3];
    const dataB = packets[4];
    expect(dataA?.payload.toString()).toBe('AAA');
    expect(dataB?.payload.toString()).toBe('BBBB');
    // Second packet's seq = first packet's seq + payload length.
    expect(dataB?.seq).toBe(((dataA?.seq ?? 0) + 3) >>> 0);
  });
});

// ─── Minimal pcap parser for tests ─────────────────────────────────

interface ParsedPacket {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  payload: Buffer;
}

function parsePcap(file: Buffer): ParsedPacket[] {
  // Skip global header (24 bytes)
  let offset = 24;
  const out: ParsedPacket[] = [];
  while (offset < file.length) {
    const inclLen = file.readUInt32LE(offset + 8);
    offset += 16;
    const ipStart = offset;
    const ipVerIhl = file[ipStart] ?? 0;
    const ihl = (ipVerIhl & 0x0f) * 4;
    const tcpStart = ipStart + ihl;
    const srcPort = file.readUInt16BE(tcpStart);
    const dstPort = file.readUInt16BE(tcpStart + 2);
    const seq = file.readUInt32BE(tcpStart + 4);
    const ack = file.readUInt32BE(tcpStart + 8);
    const dataOffset = ((file[tcpStart + 12] ?? 0) >> 4) * 4;
    const flags = file[tcpStart + 13] ?? 0;
    const payloadStart = tcpStart + dataOffset;
    const payloadEnd = ipStart + inclLen;
    const payload = file.slice(payloadStart, payloadEnd);
    out.push({ srcPort, dstPort, seq, ack, flags, payload });
    offset += inclLen;
  }
  return out;
}
