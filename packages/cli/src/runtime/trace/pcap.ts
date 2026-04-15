/**
 * Minimal pcap writer for captured proxy session bytes.
 *
 * We take the chunks our proxy relay reported for a span and synthesize
 * a pcap file that tshark can decrypt. The synthesized trace has one
 * TCP flow per proxy session with fake source/destination IPs on the
 * loopback prefix (127.0.0.0/8), a proper TCP 3-way handshake, and
 * real PSH+ACK data packets whose seq/ack numbers track cumulative
 * bytes flowing in each direction. A FIN/FIN-ACK pair closes the flow.
 *
 * Why synthesize rather than capture raw packets:
 *   - We observe bytes at the CONNECT proxy boundary (user-space), so
 *     the TCP framing is already stripped by the time we see them. We
 *     have to reinvent it to make tshark happy.
 *   - Using LINKTYPE_RAW (101) skips the ethernet header entirely,
 *     which removes one layer of boilerplate and works identically
 *     across Linux / macOS / BSD.
 *   - Fake IPs live in 127.0.0.0/8 so nothing in the decoded output
 *     confuses a reader into thinking the trace came from real
 *     external infrastructure. Fake source ports start at 40000 and
 *     increment per session; destination ports are the real upstream
 *     port the client asked for (so you can still tell HTTPS
 *     flows from other TLS services in the decoded view).
 *
 * Checksums are zeroed. Tshark accepts this — it warns about invalid
 * checksums but happily continues dissecting. We skip calculating them
 * because (a) it's one more thing to go wrong and (b) the pcap never
 * touches a real NIC, so there's no possibility of silent corruption.
 *
 * Output file format:
 *   [global header]
 *   for each packet:
 *     [record header][raw IP+TCP+payload]
 *
 * The file is written atomically via temp + rename in the same
 * directory (same pattern we use everywhere else in the cli).
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants as FS, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProxyChunk } from './proxy.js';

const LINKTYPE_RAW = 101;
const PCAP_MAGIC = 0xa1b2c3d4;
const PCAP_VERSION_MAJOR = 2;
const PCAP_VERSION_MINOR = 4;
const SNAPLEN = 0xffff;

const IP_HEADER_LEN = 20;
const TCP_HEADER_LEN = 20;
/**
 * Largest payload that can fit in a single IP packet given our fixed
 * header sizes. The IP `total_length` field is 16-bit (max 65535) and
 * must cover the full packet — header + payload. That leaves 65495
 * bytes for the payload itself.
 *
 * We need to care about this because the user-space chunks we see
 * from the SOCKS/CONNECT relay don't respect any MSS — Node's
 * `socket.on('data')` commonly delivers 64KB reads in one event, and
 * larger on tuned kernels. Real TCP fragments at the MSS (typically
 * 1460 bytes) before the IP layer ever sees the bytes, but we're
 * synthesizing the whole stack after the fact, so the fragmenting
 * is our job.
 */
const MAX_IP_PAYLOAD = 0xffff - IP_HEADER_LEN - TCP_HEADER_LEN;

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_ACK = 0x10;
const TCP_PSH = 0x08;

/**
 * Write a span's worth of proxy chunks to a pcap file. Groups chunks
 * by session id, synthesizes one TCP flow per session, and interleaves
 * the flows by wall-clock time so tshark's TLS reassembly sees the
 * bytes in the same order the real network did.
 *
 * Returns the number of packets written. A span with no chunks still
 * produces a valid (empty) pcap file — tshark will decode nothing and
 * the decryption layer will fall back to a raw-bytes record.
 */
export function writePcap(path: string, chunks: readonly ProxyChunk[]): number {
  const dir = dirname(path);
  const nonce = randomBytes(6).toString('hex');
  const tmp = join(dir, `.c17-pcap-${nonce}.tmp`);

  // eslint-disable-next-line no-bitwise
  const fd = openSync(tmp, FS.O_CREAT | FS.O_WRONLY | FS.O_EXCL, 0o600);

  try {
    writeSync(fd, buildGlobalHeader());

    // Group chunks by session so we can build per-flow seq/ack state.
    const bySession = new Map<number, ProxyChunk[]>();
    for (const chunk of chunks) {
      const list = bySession.get(chunk.sessionId);
      if (list) {
        list.push(chunk);
      } else {
        bySession.set(chunk.sessionId, [chunk]);
      }
    }

    // Emit per-session packets. We batch the session handshake + data
    // packets into a single sorted queue keyed on timestamp so the
    // final pcap is time-ordered across sessions.
    const packets: SynthPacket[] = [];
    for (const [sessionId, sessionChunks] of bySession) {
      if (sessionChunks.length === 0) continue;
      packets.push(...synthesizeFlow(sessionId, sessionChunks));
    }
    packets.sort((a, b) => a.ts - b.ts);

    let total = 0;
    for (const pkt of packets) {
      writeSync(fd, buildRecordHeader(pkt.ts, pkt.bytes.length));
      writeSync(fd, pkt.bytes);
      total++;
    }

    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
    return total;
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      // Best-effort unlink of the temp file on failure.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ─── Global + record headers ───────────────────────────────────────

function buildGlobalHeader(): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(PCAP_MAGIC, 0);
  buf.writeUInt16LE(PCAP_VERSION_MAJOR, 4);
  buf.writeUInt16LE(PCAP_VERSION_MINOR, 6);
  buf.writeInt32LE(0, 8); // thiszone
  buf.writeUInt32LE(0, 12); // sigfigs
  buf.writeUInt32LE(SNAPLEN, 16);
  buf.writeUInt32LE(LINKTYPE_RAW, 20);
  return buf;
}

function buildRecordHeader(tsMs: number, payloadLen: number): Buffer {
  const buf = Buffer.alloc(16);
  const tsSec = Math.floor(tsMs / 1000);
  const tsUsec = (tsMs % 1000) * 1000;
  buf.writeUInt32LE(tsSec, 0);
  buf.writeUInt32LE(tsUsec, 4);
  buf.writeUInt32LE(payloadLen, 8);
  buf.writeUInt32LE(payloadLen, 12);
  return buf;
}

// ─── TCP flow synthesis ────────────────────────────────────────────

interface SynthPacket {
  ts: number;
  bytes: Buffer;
}

interface FlowEndpoints {
  clientIp: string;
  clientPort: number;
  upstreamIp: string;
  upstreamPort: number;
}

/**
 * Build a realistic-looking TCP flow for a proxy session: SYN,
 * SYN+ACK, ACK (handshake), then PSH+ACK packets mirroring the real
 * byte chunks, then FIN+ACK / ACK to close cleanly. Seq/ack numbers
 * increment correctly so tshark's TCP reassembly follows the TLS
 * records end-to-end.
 *
 * The 3-way handshake is essential: tshark won't start reassembling a
 * TLS flow until it's seen a SYN on the expected direction. Even a
 * one-packet flow with missing handshake gets ignored by the TLS
 * dissector.
 */
function synthesizeFlow(sessionId: number, chunks: ProxyChunk[]): SynthPacket[] {
  const first = chunks[0];
  if (!first) return [];

  const endpoints: FlowEndpoints = {
    clientIp: `127.0.1.${sessionId & 0xff || 1}`,
    clientPort: 40000 + (sessionId % 20000),
    // Upstream IP is a deterministic fake — tshark doesn't resolve
    // it, and a real DNS lookup at decrypt-time would be bad.
    upstreamIp: `127.0.99.${sessionId & 0xff || 2}`,
    upstreamPort: first.upstream.port,
  };

  let clientSeq = 1_000_000 + sessionId * 1000;
  let serverSeq = 2_000_000 + sessionId * 1000;
  const out: SynthPacket[] = [];
  const startTs = first.ts;

  // Handshake
  out.push({
    ts: startTs,
    bytes: buildIpTcp(endpoints, 'c2s', clientSeq, 0, TCP_SYN, Buffer.alloc(0)),
  });
  clientSeq += 1; // SYN consumes one seq
  out.push({
    ts: startTs,
    bytes: buildIpTcp(endpoints, 's2c', serverSeq, clientSeq, TCP_SYN | TCP_ACK, Buffer.alloc(0)),
  });
  serverSeq += 1;
  out.push({
    ts: startTs,
    bytes: buildIpTcp(endpoints, 'c2s', clientSeq, serverSeq, TCP_ACK, Buffer.alloc(0)),
  });

  // Data packets. Chunks larger than the 16-bit IP total_length
  // ceiling have to be split into multiple packets — Node's socket
  // 'data' events commonly deliver 64KB reads in a single chunk,
  // which overflows the IP header field. We fragment at the max
  // payload size; the seq/ack numbers advance naturally across the
  // resulting sub-packets so tshark reassembles them into one TLS
  // record stream.
  for (const chunk of chunks) {
    if (chunk.bytes.length === 0) continue;
    for (let offset = 0; offset < chunk.bytes.length; offset += MAX_IP_PAYLOAD) {
      const slice = chunk.bytes.slice(offset, offset + MAX_IP_PAYLOAD);
      if (chunk.direction === 'client_to_upstream') {
        out.push({
          ts: chunk.ts,
          bytes: buildIpTcp(endpoints, 'c2s', clientSeq, serverSeq, TCP_PSH | TCP_ACK, slice),
        });
        clientSeq = (clientSeq + slice.length) >>> 0;
      } else {
        out.push({
          ts: chunk.ts,
          bytes: buildIpTcp(endpoints, 's2c', serverSeq, clientSeq, TCP_PSH | TCP_ACK, slice),
        });
        serverSeq = (serverSeq + slice.length) >>> 0;
      }
    }
  }

  // Graceful close — FIN from client, ACK from server. Not strictly
  // required for tshark decryption but keeps the pcap clean so
  // Wireshark UIs show a complete flow if an operator opens the file.
  const lastTs = chunks[chunks.length - 1]?.ts ?? startTs;
  out.push({
    ts: lastTs,
    bytes: buildIpTcp(endpoints, 'c2s', clientSeq, serverSeq, TCP_FIN | TCP_ACK, Buffer.alloc(0)),
  });
  clientSeq = (clientSeq + 1) >>> 0;
  out.push({
    ts: lastTs,
    bytes: buildIpTcp(endpoints, 's2c', serverSeq, clientSeq, TCP_ACK, Buffer.alloc(0)),
  });

  return out;
}

// ─── IP + TCP header serialization ─────────────────────────────────

function buildIpTcp(
  endpoints: FlowEndpoints,
  direction: 'c2s' | 's2c',
  seq: number,
  ack: number,
  flags: number,
  payload: Buffer,
): Buffer {
  if (payload.length > MAX_IP_PAYLOAD) {
    throw new Error(
      `pcap: payload ${payload.length} exceeds MAX_IP_PAYLOAD ${MAX_IP_PAYLOAD}; ` +
        'caller must fragment before calling buildIpTcp',
    );
  }
  const totalLen = IP_HEADER_LEN + TCP_HEADER_LEN + payload.length;
  const ip = Buffer.alloc(IP_HEADER_LEN);
  ip[0] = 0x45; // version=4, IHL=5 (20 bytes)
  ip[1] = 0x00; // DSCP/ECN
  ip.writeUInt16BE(totalLen, 2);
  ip.writeUInt16BE(0, 4); // id
  ip.writeUInt16BE(0x4000, 6); // flags=DF
  ip[8] = 64; // ttl
  ip[9] = 6; // protocol=TCP
  ip.writeUInt16BE(0, 10); // checksum (zeroed, tshark tolerates)

  const srcIp = direction === 'c2s' ? endpoints.clientIp : endpoints.upstreamIp;
  const dstIp = direction === 'c2s' ? endpoints.upstreamIp : endpoints.clientIp;
  writeIp(ip, 12, srcIp);
  writeIp(ip, 16, dstIp);

  const tcp = Buffer.alloc(TCP_HEADER_LEN);
  const srcPort = direction === 'c2s' ? endpoints.clientPort : endpoints.upstreamPort;
  const dstPort = direction === 'c2s' ? endpoints.upstreamPort : endpoints.clientPort;
  tcp.writeUInt16BE(srcPort, 0);
  tcp.writeUInt16BE(dstPort, 2);
  tcp.writeUInt32BE(seq >>> 0, 4);
  tcp.writeUInt32BE(ack >>> 0, 8);
  tcp[12] = 0x50; // data offset = 5 (20 bytes), reserved/ns = 0
  tcp[13] = flags & 0xff;
  tcp.writeUInt16BE(0xffff, 14); // window
  tcp.writeUInt16BE(0, 16); // checksum (zeroed)
  tcp.writeUInt16BE(0, 18); // urgent

  return Buffer.concat([ip, tcp, payload]);
}

function writeIp(buf: Buffer, offset: number, ip: string): void {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`invalid ipv4: ${ip}`);
  for (let i = 0; i < 4; i++) {
    const octet = Number(parts[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`invalid ipv4 octet: ${ip}`);
    }
    buf[offset + i] = octet;
  }
}
