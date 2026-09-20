// One-off: generate a VAPID keypair for Web Push (Phase G reach — browser push).
// Run: node scripts/generate-vapid-keys.mjs
//
// Uses Node's BUILT-IN crypto only (no npm package) — this is plain EC key
// generation, not the fragile RFC 8291 message-encryption protocol, so it's safe
// to do without a reference library. Prints the two values to set as env vars:
//   VAPID_PUBLIC_KEY   — safe to expose to the browser (served by
//                        GET /api/push/vapid-public-key)
//   VAPID_PRIVATE_KEY  — server-only secret, never sent to a client
//
// Generate ONCE per deployment and keep it stable: every subscribed browser is
// bound to the public key it subscribed with, and rotating it invalidates every
// existing subscription (users would need to re-subscribe).
import { createECDH } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();

// Public key: the raw uncompressed EC point (0x04 || X || Y), 65 bytes — exactly
// the format PushManager.subscribe({ applicationServerKey }) expects.
const publicKey = ecdh.getPublicKey();
// Private key: the raw 32-byte scalar, left-padded with zeros if Node returns it
// shorter (a small-magnitude scalar can serialize shorter than 32 bytes).
const rawPrivate = ecdh.getPrivateKey();
const privateKey = Buffer.concat([Buffer.alloc(32 - rawPrivate.length, 0), rawPrivate]);

const b64url = (buf) => buf.toString('base64url');

console.log('VAPID keypair generated. Add these to your environment (Vercel + .env.local):\n');
console.log(`VAPID_PUBLIC_KEY=${b64url(publicKey)}`);
console.log(`VAPID_PRIVATE_KEY=${b64url(privateKey)}`);
console.log('\nKeep VAPID_PRIVATE_KEY secret — never commit it or expose it to the client.');
