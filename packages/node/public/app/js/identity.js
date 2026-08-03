/**
 * identity.js — key management and the derived "profile" layer.
 *
 * The protocol has no profile records: an account *is* its Ed25519 public key.
 * X, however, needs a name, a handle and an avatar for every account it renders
 * — including accounts this browser has never held keys for.
 *
 * So everything cosmetic is *derived deterministically from the public key*.
 * Two people running two nodes see the same name and the same avatar for the
 * same account, with nothing stored on-chain and no server involved. A user may
 * override their own display name, but that override is local to this browser
 * and the UI labels it as such.
 *
 * Keys are shared with the demo UI: both read and write `dagsocial-identities`
 * in localStorage, so an identity created in one appears in the other.
 */
import { buf2hex, hex2buf } from './chain.js';

/** Shared with `public/index.html` — do not rename without migrating it too. */
const STORAGE_KEY = 'dagsocial-identities';
const ACTIVE_KEY = 'notis-x-active-identity';
const NICKNAME_KEY = 'notis-x-nicknames';

/** @typedef {{ pubKeyHex: string, privKeyBase64: string }} StoredIdentity */

/** @type {StoredIdentity[]} */
let identities = [];
let activeIndex = -1;

/** The active identity's imported CryptoKey. Null until `activate()` runs. */
let privKey = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readStored() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i.pubKeyHex === 'string') : [];
  } catch {
    return [];
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identities));
  localStorage.setItem(ACTIVE_KEY, String(activeIndex));
}

// ---------------------------------------------------------------------------
// Key generation / import
// ---------------------------------------------------------------------------

async function generateKeypair() {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubKeyHex = buf2hex(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)));
  const privBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
  return { pubKeyHex, privKeyBase64: btoa(String.fromCharCode(...privBytes)) };
}

/**
 * Load stored identities and activate one, generating a first keypair if this
 * browser has none. Resolves once the active key is usable for signing.
 */
export async function init() {
  identities = readStored();
  if (identities.length === 0) {
    identities.push(await generateKeypair());
  }
  const stored = parseInt(localStorage.getItem(ACTIVE_KEY) ?? '0', 10);
  await activate(Number.isInteger(stored) && stored >= 0 && stored < identities.length ? stored : 0);
}

export async function activate(index) {
  if (index < 0 || index >= identities.length) return;
  const ident = identities[index];
  const privBytes = Uint8Array.from(atob(ident.privKeyBase64), (c) => c.charCodeAt(0));
  // Import before mutating state so a corrupt entry cannot leave us with an
  // active identity whose key is unusable.
  privKey = await crypto.subtle.importKey('pkcs8', privBytes, 'Ed25519', true, ['sign']);
  activeIndex = index;
  persist();
}

/** Generate a fresh keypair, store it, and switch to it. Returns its index. */
export async function createIdentity() {
  identities.push(await generateKeypair());
  const index = identities.length - 1;
  await activate(index);
  return index;
}

/**
 * Import an identity exported by this UI or the demo UI.
 * @throws {Error} with a user-facing message when the file is malformed.
 */
export async function importIdentity(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data?.pubKeyHex || !data?.privKeyBase64) {
    throw new Error('Invalid identity file: missing pubKeyHex or privKeyBase64');
  }
  if (!/^[0-9a-f]{64}$/i.test(data.pubKeyHex)) {
    throw new Error('Invalid identity file: pubKeyHex must be 64 hex characters');
  }
  const existing = identities.findIndex((i) => i.pubKeyHex === data.pubKeyHex);
  if (existing !== -1) {
    await activate(existing);
    return existing;
  }
  identities.push({ pubKeyHex: data.pubKeyHex, privKeyBase64: data.privKeyBase64 });
  const index = identities.length - 1;
  await activate(index);
  return index;
}

/** The active identity as a downloadable JSON blob, or null if none is active. */
export function exportActive() {
  const ident = identities[activeIndex];
  if (!ident) return null;
  return JSON.stringify({ pubKeyHex: ident.pubKeyHex, privKeyBase64: ident.privKeyBase64 }, null, 2);
}

/**
 * Forget an identity. The key is erased from this browser — if it was not
 * exported first it is gone, along with the karma it owns.
 */
export async function removeIdentity(index) {
  if (index < 0 || index >= identities.length) return;
  identities.splice(index, 1);
  if (identities.length === 0) {
    identities.push(await generateKeypair());
    await activate(0);
    return;
  }
  await activate(Math.min(index, identities.length - 1));
}

// ---------------------------------------------------------------------------
// Active-identity accessors
// ---------------------------------------------------------------------------

/** Hex public key of the active identity — the protocol's userId. */
export const userId = () => identities[activeIndex]?.pubKeyHex ?? null;

/** Raw 32-byte public key of the active identity. */
export const pubKeyBytes = () => {
  const hex = userId();
  return hex ? hex2buf(hex) : null;
};

export const privateKey = () => privKey;
export const listIdentities = () => identities.map((i) => i.pubKeyHex);
export const activeIdentityIndex = () => activeIndex;
export const isSelf = (hex) => Boolean(hex) && hex === userId();

// ---------------------------------------------------------------------------
// Derived profiles
// ---------------------------------------------------------------------------

/**
 * Word lists for derived display names. Both are powers of two so the index is
 * a clean bit slice of the key, and both are deliberately bland — a derived
 * name should read as a placeholder, never as a claim about who someone is.
 */
const ADJECTIVES = [
  'Amber', 'Arctic', 'Autumn', 'Azure', 'Bright', 'Bronze', 'Calm', 'Cedar',
  'Cobalt', 'Copper', 'Coral', 'Crimson', 'Crystal', 'Dusty', 'Ember', 'Fern',
  'Golden', 'Granite', 'Harbor', 'Hazel', 'Indigo', 'Iron', 'Ivory', 'Jade',
  'Lunar', 'Maple', 'Marble', 'Midnight', 'Misty', 'Neon', 'Northern', 'Obsidian',
  'Onyx', 'Opal', 'Pale', 'Pewter', 'Quartz', 'Quiet', 'Rapid', 'Rustic',
  'Sable', 'Sage', 'Sandy', 'Scarlet', 'Silent', 'Silver', 'Slate', 'Solar',
  'Steady', 'Stellar', 'Stormy', 'Summer', 'Sunlit', 'Teal', 'Timber', 'Tundra',
  'Umber', 'Velvet', 'Verdant', 'Vermilion', 'Violet', 'Winter', 'Wistful', 'Zephyr',
];

const NOUNS = [
  'Alder', 'Anchor', 'Aspen', 'Badger', 'Basin', 'Beacon', 'Birch', 'Bison',
  'Bluff', 'Brook', 'Canyon', 'Cinder', 'Comet', 'Compass', 'Coyote', 'Crane',
  'Current', 'Delta', 'Dune', 'Eagle', 'Ember', 'Falcon', 'Fathom', 'Ferry',
  'Fjord', 'Forge', 'Fox', 'Glacier', 'Grove', 'Harbor', 'Hawk', 'Heron',
  'Hollow', 'Horizon', 'Junction', 'Kestrel', 'Lantern', 'Ledger', 'Lynx', 'Meadow',
  'Meridian', 'Mesa', 'Otter', 'Pike', 'Pillar', 'Prairie', 'Quarry', 'Ridge',
  'Rook', 'Sable', 'Sparrow', 'Spruce', 'Summit', 'Thicket', 'Thistle', 'Tide',
  'Trail', 'Vale', 'Vertex', 'Warden', 'Willow', 'Wren', 'Yarrow', 'Zenith',
];

/**
 * Handle for an account: the first 8 hex characters of its public key.
 *
 * Short enough to read, long enough that a collision needs ~4 billion accounts,
 * and — unlike a chosen handle — impossible to squat.
 */
export function handleOf(pubKeyHex) {
  return pubKeyHex ? pubKeyHex.slice(0, 8) : 'unknown';
}

/** Locally-overridden display names, `{ [pubKeyHex]: name }`. */
function readNicknames() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NICKNAME_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Display name for an account: a local override if this browser set one, else
 * two words derived from the key. Callers that must show the *shared* name (so
 * every client agrees) should pass `{ derivedOnly: true }`.
 */
export function displayNameOf(pubKeyHex, { derivedOnly = false } = {}) {
  if (!pubKeyHex) return 'Unknown';
  if (!derivedOnly) {
    const override = readNicknames()[pubKeyHex];
    if (override) return override;
  }
  const adjective = ADJECTIVES[parseInt(pubKeyHex.slice(0, 2), 16) % ADJECTIVES.length];
  const noun = NOUNS[parseInt(pubKeyHex.slice(2, 4), 16) % NOUNS.length];
  return `${adjective} ${noun}`;
}

/** True when this browser has overridden the derived name for an account. */
export function hasNicknameOverride(pubKeyHex) {
  return Boolean(readNicknames()[pubKeyHex]);
}

/** Set (or clear, with an empty string) the local display-name override. */
export function setNickname(pubKeyHex, name) {
  const map = readNicknames();
  const trimmed = (name ?? '').trim();
  if (trimmed) map[pubKeyHex] = trimmed.slice(0, 50);
  else delete map[pubKeyHex];
  localStorage.setItem(NICKNAME_KEY, JSON.stringify(map));
}

// ---------------------------------------------------------------------------
// Derived avatars
// ---------------------------------------------------------------------------

/**
 * Two hues from the key, kept 60–180° apart so the gradient always has visible
 * contrast rather than collapsing into a flat wash.
 */
function avatarHues(pubKeyHex) {
  const h1 = (parseInt(pubKeyHex.slice(0, 4), 16) % 360);
  const spread = 60 + (parseInt(pubKeyHex.slice(4, 6), 16) % 120);
  return [h1, (h1 + spread) % 360];
}

/**
 * A deterministic identicon for an account, as an SVG data URI.
 *
 * A 5×5 grid mirrored across the vertical axis (so it reads as a face/emblem
 * rather than noise), drawn over a two-tone gradient. Every byte consumed comes
 * from the public key, so the same account looks the same in every client.
 */
export function avatarFor(pubKeyHex, size = 48) {
  if (!pubKeyHex) pubKeyHex = '0'.repeat(64);
  const [h1, h2] = avatarHues(pubKeyHex);
  const bytes = hex2buf(pubKeyHex);

  const cells = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      // One bit per cell, taken from the second half of the key so the hues
      // (drawn from the first bytes) and the pattern vary independently.
      const bit = bytes[16 + col * 5 + row] & 1;
      if (!bit) continue;
      cells.push([col, row]);
      if (col < 2) cells.push([4 - col, row]);
    }
  }

  const rects = cells
    .map(([c, r]) => `<rect x="${c}" y="${r}" width="1" height="1"/>`)
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="${size}" height="${size}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="hsl(${h1} 68% 52%)"/>` +
    `<stop offset="100%" stop-color="hsl(${h2} 68% 38%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="5" height="5" fill="url(#g)"/>` +
    `<g fill="rgba(255,255,255,0.82)">${rects}</g>` +
    `</svg>`;

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** A wide banner gradient for profile headers, derived from the same hues. */
export function bannerFor(pubKeyHex) {
  const [h1, h2] = avatarHues(pubKeyHex || '0'.repeat(64));
  return `linear-gradient(135deg, hsl(${h1} 45% 28%), hsl(${h2} 45% 18%))`;
}
