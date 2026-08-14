/**
 * Stateless OAuth 2.1 authorization server for hosted-agent connectors.
 *
 * Hosted agents (claude.ai custom connectors, ChatGPT connectors, …) only
 * speak MCP-spec OAuth — they have no "paste a bearer token" field — so this
 * module implements the minimum that profile requires:
 *
 *   - RFC 9728 protected-resource metadata + RFC 8414 AS metadata discovery
 *   - RFC 7591 dynamic client registration (public clients only)
 *   - /authorize with mandatory PKCE S256, /token accepting form-urlencoded
 *   - refresh tokens (agents append offline_access when advertised)
 *
 * Header-capable clients (Claude Code, Codex CLI, Cursor, MCP Inspector, …)
 * can skip all of this and send the static bearer directly.
 *
 * Everything is stateless: codes/tokens/client ids are HMAC-signed blobs, no
 * KV or Durable Objects. The signing key is derived from MCP_BEARER_TOKEN,
 * so rotating that one secret revokes every OAuth session at once — the
 * single-user revocation lever.
 *
 * Single-user consent model: /authorize asks for the connector password,
 * which IS the MCP_BEARER_TOKEN. Whoever holds it could call /mcp directly
 * anyway, so the consent gate adds no new trust boundary.
 *
 * Accepted stateless tradeoffs (fine for one user, documented on purpose):
 *   - Authorization codes are not single-use; they expire in 2 minutes and
 *     are PKCE-bound, so replay additionally requires the code_verifier.
 *   - Refresh rotation issues a new token without revoking the old one; the
 *     old one simply ages out at its own expiry.
 */

const enc = new TextEncoder();

// ---------------------------------------------------------------- base64url

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ signed tokens

export interface TokenPayload {
  /** code | at (access) | rt (refresh) | client */
  t: "code" | "at" | "rt" | "client";
  /** Unix seconds; absent = never expires (client ids only). */
  exp?: number;
  iat: number;
  /** code only: PKCE S256 challenge this code is bound to. */
  ch?: string;
  /** code only: exact redirect_uri the code was issued for. */
  ru?: string;
  scope?: string;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  // Domain-separated derivation so the bearer token itself never doubles as
  // an HMAC key directly.
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`stalwart-mcp-oauth-v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function mintToken(payload: TokenPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await signingKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `v1.${body}.${b64url(mac)}`;
}

export async function verifyToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<TokenPayload | null> {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const [, body, macStr] = m;
  const mac = b64urlDecode(macStr!);
  if (!mac) return null;
  const key = await signingKey(secret);
  // crypto.subtle.verify is constant-time.
  const bodyBytes = enc.encode(body!);
  const macBuf = new Uint8Array(mac).buffer as ArrayBuffer;
  if (!(await crypto.subtle.verify("HMAC", key, macBuf, bodyBytes))) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body!)!));
  } catch {
    return null;
  }
  if (payload.exp !== undefined && payload.exp <= now) return null;
  return payload;
}

// ------------------------------------------------------------------- PKCE

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  // RFC 7636 §4.2: verifier is 43-128 chars of [A-Za-z0-9-._~].
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return b64url(digest) === challenge;
}

// -------------------------------------------------------- redirect allowlist

/**
 * Parse the OAUTH_ALLOWED_REDIRECTS config var: extra callback URLs for
 * agents other than Claude, comma- or whitespace-separated, https only
 * (loopback is already built in). Invalid entries are dropped silently —
 * a typo must not open the list up.
 */
export function parseExtraRedirects(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((s) => {
      try {
        return new URL(s).protocol === "https:";
      } catch {
        return false;
      }
    });
}

/**
 * Callbacks that may receive authorization codes, regardless of what a
 * client registers:
 *   - Claude's hosted callback (verified against production)
 *   - RFC 8252 loopback on any port AND any path — native agents differ
 *     (Claude Code /callback, Codex CLI /auth/callback, …), and a loopback
 *     listener is by definition under the local user's control
 *   - operator-configured extras (exact URL match), for other hosted agents
 */
export function isAllowedRedirect(uri: string, extra: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") {
    if (
      (u.hostname === "claude.ai" || u.hostname === "claude.com") &&
      u.pathname === "/api/mcp/auth_callback"
    ) {
      return true;
    }
    return extra.includes(uri);
  }
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  }
  return false;
}

// -------------------------------------------------------------- lifetimes

const CODE_TTL = 120; // seconds — one browser redirect round-trip
const ACCESS_TTL = 7 * 24 * 3600; // Claude refreshes proactively before expiry
const REFRESH_TTL = 90 * 24 * 3600;

// ------------------------------------------------------------- discovery

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["mail"],
    bearer_methods_supported: ["header"],
  };
}

export function authServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Mandatory for claude.ai: it sends S256 PKCE on every request and checks
    // the advertisement before starting the flow.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // offline_access advertised so Claude requests a refresh token.
    scopes_supported: ["mail", "offline_access"],
  };
}

// ---------------------------------------------------------------- register

export async function handleRegister(
  req: Request,
  secret: string,
  extraRedirects: string[] = [],
): Promise<Response> {
  let body: { redirect_uris?: unknown };
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON", 400);
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || !uris.every((u) => isAllowedRedirect(u, extraRedirects))) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris not in this server's allowlist — add your agent's callback " +
        "URL to the OAUTH_ALLOWED_REDIRECTS var (see README)",
      400,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  // The client id is itself a signed blob — registration needs no storage.
  const clientId = await mintToken({ t: "client", iat: now }, secret);
  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}

// --------------------------------------------------------------- authorize

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  scope: string;
}

function readAuthorizeParams(
  src: URLSearchParams,
  extraRedirects: string[],
): { ok: true; p: AuthorizeParams } | { ok: false; err: string } {
  if ((src.get("response_type") ?? "code") !== "code") return { ok: false, err: "response_type must be code" };
  const redirect_uri = src.get("redirect_uri") ?? "";
  if (!isAllowedRedirect(redirect_uri, extraRedirects)) {
    // Echo the URI so the operator can copy it straight into config — this
    // is the onboarding path for a not-yet-known agent. Plain text, no HTML.
    return {
      ok: false,
      err:
        `redirect_uri is not in this server's allowlist:\n  ${redirect_uri}\n` +
        `To allow this agent, add that exact URL to the OAUTH_ALLOWED_REDIRECTS ` +
        `var in wrangler.jsonc and redeploy.`,
    };
  }
  const code_challenge = src.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(code_challenge)) return { ok: false, err: "S256 code_challenge required" };
  if ((src.get("code_challenge_method") ?? "S256") !== "S256") return { ok: false, err: "only S256 is supported" };
  return {
    ok: true,
    p: {
      client_id: src.get("client_id") ?? "",
      redirect_uri,
      state: src.get("state") ?? "",
      code_challenge,
      scope: src.get("scope") ?? "mail",
    },
  };
}

function consentPage(p: AuthorizeParams, errorMsg?: string): Response {
  const host = new URL(p.redirect_uri).host;
  const hidden = (Object.entries(p) as Array<[string, string]>)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("\n      ");
  // Redirect host shown prominently — the MCP auth spec requires the consent
  // screen to make the destination unmistakable.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Stalwart MCP — connector consent</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:14vh auto;padding:0 1rem;color:#222}
  .card{border:1px solid #ddd;border-radius:10px;padding:1.5rem}
  .host{font-weight:600}
  input[type=password]{width:100%;box-sizing:border-box;font-size:1rem;padding:.5rem;margin:.75rem 0;border:1px solid #bbb;border-radius:6px}
  button{font-size:1rem;padding:.5rem 1.25rem;border:0;border-radius:6px;background:#2E75B6;color:#fff;cursor:pointer}
  .err{color:#b00020;margin:.5rem 0}
  .fine{color:#666;font-size:.85rem;margin-top:1rem}
  @media (prefers-color-scheme: dark){body{background:#111;color:#ddd}.card{border-color:#333}input[type=password]{background:#1a1a1a;color:#ddd;border-color:#444}.fine{color:#999}}
</style></head><body>
  <div class="card">
    <h1 style="font-size:1.2rem;margin-top:0">Authorize mail access</h1>
    <p>After you approve, the browser returns to <span class="host">${esc(host)}</span> and the
    connecting agent gains read/draft/send access to the connected mailbox.</p>
    ${errorMsg ? `<p class="err">${esc(errorMsg)}</p>` : ""}
    <form method="post" action="/authorize">
      ${hidden}
      <label for="pw">Connector password (MCP_BEARER_TOKEN)</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Approve</button>
    </form>
    <p class="fine">Single-user server — the password is this deployment's MCP_BEARER_TOKEN secret.</p>
  </div>
</body></html>`;
  return new Response(html, {
    status: errorMsg ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function handleAuthorizeGet(req: Request, extraRedirects: string[] = []): Response {
  const r = readAuthorizeParams(new URL(req.url).searchParams, extraRedirects);
  if (!r.ok) return new Response(r.err, { status: 400 });
  return consentPage(r.p);
}

export async function handleAuthorizePost(
  req: Request,
  secret: string,
  compareSecret: (candidate: string, expected: string) => Promise<boolean>,
  extraRedirects: string[] = [],
): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const r = readAuthorizeParams(form, extraRedirects);
  if (!r.ok) return new Response(r.err, { status: 400 });
  const password = form.get("password") ?? "";
  if (!(await compareSecret(password, secret))) {
    return consentPage(r.p, "Wrong password — paste the current MCP_BEARER_TOKEN.");
  }
  const now = Math.floor(Date.now() / 1000);
  const code = await mintToken(
    { t: "code", iat: now, exp: now + CODE_TTL, ch: r.p.code_challenge, ru: r.p.redirect_uri, scope: r.p.scope },
    secret,
  );
  const dest = new URL(r.p.redirect_uri);
  dest.searchParams.set("code", code);
  if (r.p.state) dest.searchParams.set("state", r.p.state);
  return new Response(null, {
    status: 302,
    headers: { location: dest.toString(), "cache-control": "no-store" },
  });
}

// ------------------------------------------------------------------- token

function oauthError(error: string, description: string, status: number): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function issueTokens(secret: string, scope: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const [access_token, refresh_token] = await Promise.all([
    mintToken({ t: "at", iat: now, exp: now + ACCESS_TTL, scope }, secret),
    mintToken({ t: "rt", iat: now, exp: now + REFRESH_TTL, scope }, secret),
  ]);
  return Response.json(
    { access_token, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token, scope },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function handleToken(req: Request, secret: string): Promise<Response> {
  // Claude sends application/x-www-form-urlencoded (RFC 6749 §4.1.3).
  const form = new URLSearchParams(await req.text());
  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const code = await verifyToken(form.get("code") ?? "", secret);
    if (!code || code.t !== "code") {
      return oauthError("invalid_grant", "authorization code is invalid or expired", 400);
    }
    if ((form.get("redirect_uri") ?? "") !== code.ru) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request", 400);
    }
    if (!(await pkceMatches(form.get("code_verifier") ?? "", code.ch ?? ""))) {
      return oauthError("invalid_grant", "PKCE verification failed", 400);
    }
    return issueTokens(secret, code.scope ?? "mail");
  }

  if (grant === "refresh_token") {
    const rt = await verifyToken(form.get("refresh_token") ?? "", secret);
    if (!rt || rt.t !== "rt") {
      // invalid_grant specifically — Claude treats other codes as fatal
      // rather than falling back to a fresh authorization.
      return oauthError("invalid_grant", "refresh token is invalid or expired", 400);
    }
    return issueTokens(secret, rt.scope ?? "mail");
  }

  return oauthError("unsupported_grant_type", "use authorization_code or refresh_token", 400);
}

// ------------------------------------------------- resource-server helpers

/** 401 shape claude.ai keys on to discover the authorization server. */
export function unauthorized(origin: string): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

/** True when the header carries a valid OAuth access token minted above. */
export async function verifyAccessToken(
  authorizationHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  if (!m) return false;
  const payload = await verifyToken(m[1]!, secret);
  return payload !== null && payload.t === "at";
}
