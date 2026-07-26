import { encode, decode } from 'cbor-x';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import { encodeFrame, decodeFrame, MAGIC_TESTNET } from './frame.js';

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
}

/** Build a handshake frame for our node. */
export function buildHandshakeFrame(
  magic: number,
  msg: HandshakeMsg,
): Uint8Array {
  const body = new Uint8Array(encode(msg));
  return encodeFrame(magic, 1, body);
}

/** Parse a handshake frame body. */
export function parseHandshakeBody(body: Uint8Array): HandshakeMsg {
  return decode(body) as HandshakeMsg;
}

/** Validate an incoming handshake. */
export function validateHandshake(
  msg: HandshakeMsg,
  requiredProtocolVersions: number[],
): HandshakeResult {
  if (!requiredProtocolVersions.includes(msg.protocolVersion)) {
    return {
      ok: false,
      error: `unsupported protocol version ${msg.protocolVersion}`,
      peerHeight: 0,
      peerCapabilities: [],
    };
  }
  if (!msg.agentName || typeof msg.agentName !== 'string') {
    return {
      ok: false,
      error: 'missing or invalid agentName',
      peerHeight: 0,
      peerCapabilities: [],
    };
  }
  if (!Number.isInteger(msg.sessionMagic) || msg.sessionMagic < 0) {
    return {
      ok: false,
      error: 'missing or invalid sessionMagic',
      peerHeight: 0,
      peerCapabilities: [],
    };
  }
  return {
    ok: true,
    peerHeight: msg.chainHeight,
    peerCapabilities: msg.capabilities,
  };
}
