const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET[i]!] = i;
}

export function base58Encode(buffer: Uint8Array): string {
  if (buffer.length === 0) return '';
  let leadingZeros = 0;
  for (const byte of buffer) {
    if (byte !== 0) break;
    leadingZeros++;
  }

  const digits: number[] = [0];
  for (const byte of buffer) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  return '1'.repeat(leadingZeros) + digits.reverse().map(d => ALPHABET[d]).join('');
}

export function base58Decode(encoded: string): Uint8Array {
  let leadingOnes = 0;
  for (const ch of encoded) {
    if (ch !== '1') break;
    leadingOnes++;
  }

  const bytes: number[] = [0];
  for (const ch of encoded) {
    const digit = ALPHABET_MAP[ch];
    if (digit === undefined) throw new Error(`Invalid base58 character: ${ch}`);
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }

  const result = new Uint8Array(leadingOnes + bytes.length);
  result.set(bytes.reverse(), leadingOnes);
  return result;
}
