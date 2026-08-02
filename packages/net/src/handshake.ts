import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import {
  isRecord,
  isBoundedInt,
  isHeight,
  isBoundedIntArray,
  MAX_ADVERTISED_HEIGHT,
  MAX_CAPABILITY_CODE,
  MAX_UINT32,
} from './msg-guards.js';

export interface HandshakeMsg {
  agentName: string;
  protocolVersion: number;
  nodeName: string;
  chainHeight: number;
  declaredAddress?: string;
  capabilities: number[];
  sessionMagic: number;
}

export interface HandshakeResult {
  ok: boolean;
  error?: string;
  peerHeight: number;
  peerCapabilities: number[];
  /** The validated, normalized handshake. Present only when `ok` is true. */
  msg?: HandshakeMsg;
}

/** Build a handshake frame for our node. */
export function buildHandshakeFrame(
  magic: number,
  msg: HandshakeMsg,
): Uint8Array {
  const body = new Uint8Array(encode(msg));
  return encodeFrame(magic, 1, body);
}

/**
 * CBOR-decode a handshake body.
 *
 * Returns the raw decoded value — `unknown`, because nothing about it is
 * trustworthy yet — or `null` if the bytes are not well-formed CBOR. Never
 * throws. Pass the result to `validateHandshake` to get a typed message.
 */
export function parseHandshakeBody(body: Uint8Array): unknown {
  try {
    return decode(body);
  } catch {
    return null;
  }
}

function reject(error: string): HandshakeResult {
  return { ok: false, error, peerHeight: 0, peerCapabilities: [] };
}

/**
 * Validate a decoded handshake.
 *
 * This is the decode boundary for the handshake path: `raw` comes straight off
 * the wire from an unauthenticated peer, so every field is shape- and
 * bounds-checked before any of it is used. On success the result carries a
 * normalized `msg` rebuilt from the checked fields — unknown extra fields are
 * ignored (forward compat) and nothing unvalidated leaks inward.
 *
 * `chainHeight` in particular drives the serve loop, which walks the chain one
 * height at a time; a negative or unbounded value there is a node freeze.
 */
export function validateHandshake(
  raw: unknown,
  requiredProtocolVersions: number[],
): HandshakeResult {
  if (!isRecord(raw)) {
    return reject('handshake body is not a map');
  }
  if (
    !isBoundedInt(raw.protocolVersion, MAX_CAPABILITY_CODE) ||
    !requiredProtocolVersions.includes(raw.protocolVersion)
  ) {
    return reject(`unsupported protocol version ${String(raw.protocolVersion)}`);
  }
  if (typeof raw.agentName !== 'string' || raw.agentName.length === 0) {
    return reject('missing or invalid agentName');
  }
  if (typeof raw.nodeName !== 'string') {
    return reject('missing or invalid nodeName');
  }
  if (!isHeight(raw.chainHeight)) {
    return reject(
      `chainHeight must be an integer in [0, ${MAX_ADVERTISED_HEIGHT}], got ${String(raw.chainHeight)}`,
    );
  }
  if (raw.declaredAddress !== undefined && typeof raw.declaredAddress !== 'string') {
    return reject('invalid declaredAddress');
  }
  // Absent capabilities means "tells us nothing", not "malformed" — older peers
  // may omit the field entirely. Present means it must be a list of codes.
  if (raw.capabilities !== undefined && !isBoundedIntArray(raw.capabilities, MAX_CAPABILITY_CODE)) {
    return reject('invalid capabilities');
  }
  if (!isBoundedInt(raw.sessionMagic, MAX_UINT32)) {
    return reject('missing or invalid sessionMagic');
  }

  const capabilities = raw.capabilities === undefined ? [] : [...raw.capabilities];
  const msg: HandshakeMsg = {
    agentName: raw.agentName,
    protocolVersion: raw.protocolVersion,
    nodeName: raw.nodeName,
    chainHeight: raw.chainHeight,
    capabilities,
    sessionMagic: raw.sessionMagic,
  };
  if (raw.declaredAddress !== undefined) msg.declaredAddress = raw.declaredAddress;

  return {
    ok: true,
    peerHeight: msg.chainHeight,
    peerCapabilities: capabilities,
    msg,
  };
}
