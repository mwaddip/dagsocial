import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import { PenaltyKind } from './types.js';
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

/**
 * Why a handshake was refused.
 *
 * The two classes are treated differently on purpose (NET_INTERFACE → Handshake
 * → Ban policy):
 *
 * - `malformed` — missing or wrong-typed fields, negative or over-bound heights.
 *   Nothing legitimate produces this, so the peer is adversarial and earns a
 *   permanent ban.
 * - `unsupported-version` — a well-formed handshake from a node speaking a
 *   protocol version we do not implement. That is a compatibility mismatch, not
 *   an attack: permanently banning it would partition the network on a routine
 *   `PROTOCOL_VERSION` bump, since every not-yet-upgraded peer would be banned
 *   by every upgraded one, permanently, with no path back once they upgrade.
 */
export type HandshakeRejection = 'malformed' | 'unsupported-version';

export interface HandshakeResult {
  ok: boolean;
  error?: string;
  /** Why the handshake was refused. Present only when `ok` is false. */
  rejection?: HandshakeRejection;
  peerHeight: number;
  peerCapabilities: number[];
  /** The validated, normalized handshake. Present only when `ok` is true. */
  msg?: HandshakeMsg;
}

/**
 * Penalty tier for a refused handshake — the ban policy in one place, so the
 * inbound and outbound paths cannot drift apart.
 *
 * A soft refusal still costs the peer a cooldown: `Transient` accrues ban
 * pressure so a peer cannot hammer us with version-mismatched handshakes for
 * free, but it can only ever produce a temporal ban that expires on its own.
 */
export function handshakePenalty(rejection: HandshakeRejection | undefined): PenaltyKind {
  return rejection === 'unsupported-version'
    ? PenaltyKind.Transient
    : PenaltyKind.ProtocolViolation;
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

function reject(
  error: string,
  rejection: HandshakeRejection = 'malformed',
): HandshakeResult {
  return { ok: false, error, rejection, peerHeight: 0, peerCapabilities: [] };
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
 *
 * Shape and bounds are checked *before* protocol-version support, so that a body
 * which is malformed **and** version-mismatched is classified `malformed`: only a
 * handshake we could otherwise have accepted earns the soft `unsupported-version`
 * refusal, and an attacker cannot dodge the permanent ban by tacking a bogus
 * version onto garbage.
 */
export function validateHandshake(
  raw: unknown,
  requiredProtocolVersions: number[],
): HandshakeResult {
  if (!isRecord(raw)) {
    return reject('handshake body is not a map');
  }
  if (!isBoundedInt(raw.protocolVersion, MAX_CAPABILITY_CODE)) {
    return reject(`missing or invalid protocolVersion ${String(raw.protocolVersion)}`);
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

  // Structurally sound. The only remaining reason to refuse is a version we do
  // not speak — a compatibility mismatch, so a soft refusal rather than a ban.
  if (!requiredProtocolVersions.includes(raw.protocolVersion)) {
    return reject(
      `unsupported protocol version ${raw.protocolVersion}`,
      'unsupported-version',
    );
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
