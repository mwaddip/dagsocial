import { encode, decode } from 'cbor-x';
import type { Post, SlotToken } from './post.js';

export function encodePost(post: Post): Uint8Array {
  return encode(post) as unknown as Uint8Array;
}

export function decodePost(bytes: Uint8Array): Post {
  return decode(Buffer.from(bytes)) as Post;
}

export function encodeSlotToken(token: SlotToken): Uint8Array {
  return encode(token) as unknown as Uint8Array;
}

export function decodeSlotToken(bytes: Uint8Array): SlotToken {
  return decode(Buffer.from(bytes)) as SlotToken;
}
