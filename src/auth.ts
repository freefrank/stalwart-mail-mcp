/**
 * Inbound credential checks (spec §4.2, §8.2).
 */

/**
 * Constant-time equality for secrets of unknown length: both sides are
 * SHA-256 hashed first, so the byte comparison runs over fixed-length
 * digests regardless of input lengths.
 */
export async function compareSecret(candidate: string, expected: string): Promise<boolean> {
  if (!expected) return false; // secret not configured — fail closed
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

/** Static bearer check — the pre-OAuth path, kept for curl/Inspector/Claude Code. */
export async function verifyBearer(
  authorizationHeader: string | undefined,
  expectedToken: string,
): Promise<boolean> {
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  if (!m) return false;
  return compareSecret(m[1]!, expectedToken);
}
