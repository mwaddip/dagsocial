import { multiaddr } from '@multiformats/multiaddr';
import { MAGIC_MAINNET } from './frame.js';

/**
 * Bogus-address classification for peer discovery (NET_INTERFACE → "Bogus
 * Address Classification").
 *
 * Addresses arriving in `Peers` messages are hearsay from untrusted peers; the
 * ones that can never be a dialable public peer are dropped before they reach
 * PeerDb — silently, because a NAT'd peer advertising its private address is
 * normal, not misbehavior.
 *
 * Two tiers: ranges that are bogus on any network, and ranges (RFC 1918,
 * CGN, documentation, unique-local) that are legitimate on a testnet/LAN and
 * bogus only when `magic` is mainnet's.
 */

// Multiaddr protocol codes for the IP transports (fixed by the multicodec
// table — the same values `multiaddr().tuples()` reports).
const CODE_IP4 = 4;
const CODE_IP6 = 41;

function isBogusIp4(b: Uint8Array, mainnet: boolean): boolean {
  const o0 = b[0] ?? 0;
  const o1 = b[1] ?? 0;
  const o2 = b[2] ?? 0;
  const o3 = b[3] ?? 0;

  // Always bogus, any network.
  if (o0 === 127) return true; // loopback 127/8
  if (o0 === 169 && o1 === 254) return true; // link-local 169.254/16
  if (o0 >= 224 && o0 <= 239) return true; // multicast 224/4
  if (o0 >= 240) return true; // reserved Class E 240/4, incl. broadcast 255.255.255.255
  if (o0 === 0 && o1 === 0 && o2 === 0 && o3 === 0) return true; // unspecified 0.0.0.0
  if (o0 === 198 && (o1 === 18 || o1 === 19)) return true; // benchmark 198.18/15

  if (!mainnet) return false;

  // Mainnet-only bogus — valid on testnet/LAN.
  if (o0 === 10) return true; // RFC 1918 10/8
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true; // RFC 1918 172.16/12
  if (o0 === 192 && o1 === 168) return true; // RFC 1918 192.168/16
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true; // CGN 100.64/10
  if (o0 === 192 && o1 === 0 && o2 === 2) return true; // documentation 192.0.2/24
  if (o0 === 198 && o1 === 51 && o2 === 100) return true; // documentation 198.51.100/24
  if (o0 === 203 && o1 === 0 && o2 === 113) return true; // documentation 203.0.113/24

  return false;
}

function isBogusIp6(b: Uint8Array, mainnet: boolean): boolean {
  const o0 = b[0] ?? 0;
  const o1 = b[1] ?? 0;

  // Always bogus, any network.
  if (o0 === 0xff) return true; // multicast ff00::/8
  if (o0 === 0xfe && (o1 & 0xc0) === 0x80) return true; // link-local fe80::/10

  let leadingZero = 0;
  while (leadingZero < 16 && b[leadingZero] === 0) leadingZero++;
  // loopback ::1 and unspecified :: — 15 zero bytes then 0x00 or 0x01
  if (leadingZero >= 15 && (b[15] === 0 || b[15] === 1)) return true;
  // IPv4-mapped ::ffff:0:0/96 — 10 zero bytes then 0xffff
  if (leadingZero >= 10 && b[10] === 0xff && b[11] === 0xff) return true;

  if (!mainnet) return false;

  // Mainnet-only bogus — valid on testnet/LAN.
  if ((o0 & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (o0 === 0x20 && o1 === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation 2001:db8::/32

  return false;
}

/**
 * True when `addr` can never name a dialable peer on the network identified by
 * `magic`.
 *
 * `addr` is a multiaddr string; classification runs on the raw bytes of its
 * first `ip4`/`ip6` component — the dial target. Fails closed: a string that
 * does not parse as a multiaddr, or parses to one with no IP component, is
 * bogus. Never throws.
 */
export function isBogusAddress(addr: string, magic: number): boolean {
  const mainnet = magic === MAGIC_MAINNET;

  let tuples: Array<[number, Uint8Array?]>;
  try {
    tuples = multiaddr(addr).tuples();
  } catch {
    return true;
  }

  for (const [code, bytes] of tuples) {
    if (code === CODE_IP4 && bytes !== undefined && bytes.length === 4) {
      return isBogusIp4(bytes, mainnet);
    }
    if (code === CODE_IP6 && bytes !== undefined && bytes.length === 16) {
      return isBogusIp6(bytes, mainnet);
    }
  }

  return true;
}
