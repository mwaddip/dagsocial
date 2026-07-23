import type { NetNode } from '@dagsocial/net';

let netInstance: NetNode | null = null;

export function getNet(): NetNode | null {
  return netInstance;
}

export function setNet(n: NetNode): void {
  netInstance = n;
}
