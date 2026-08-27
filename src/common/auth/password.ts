// Password hashing with node:crypto scrypt. Owned code, no dependencies.
// Format: scrypt$N$r$p$saltHex$hashHex — parameters are stored with the hash
// so they can be raised later without invalidating existing credentials.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer, n: number, blockSize: number, parallelism: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r: blockSize, p: parallelism }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const key = await scryptAsync(password, Buffer.from(saltHex!, "hex"), Number(nStr), Number(rStr), Number(pStr));
  const expected = Buffer.from(hashHex!, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
