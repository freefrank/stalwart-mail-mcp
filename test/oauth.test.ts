import { describe, it, expect } from "vitest";
import {
  b64url,
  b64urlDecode,
  mintToken,
  verifyToken,
  pkceMatches,
  isAllowedRedirect,
  parseExtraRedirects,
  handleRegister,
  handleAuthorizePost,
  handleToken,
  verifyAccessToken,
  unauthorized,
  authServerMetadata,
  protectedResourceMetadata,
} from "../src/oauth.js";
import { compareSecret } from "../src/auth.js";

const SECRET = "test-secret-of-reasonable-length-42";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
// 43 chars of unreserved characters — a valid RFC 7636 verifier.
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789-".slice(0, 43);

async function challengeFor(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

describe("b64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 62, 63]);
    expect(Array.from(b64urlDecode(b64url(bytes))!)).toEqual(Array.from(bytes));
  });

  it("rejects garbage", () => {
    expect(b64urlDecode("!!not-base64!!")).toBeNull();
  });
});

describe("signed tokens", () => {
  it("round-trips a payload", async () => {
    const tok = await mintToken({ t: "at", iat: 1, exp: 9999999999 }, SECRET);
    const back = await verifyToken(tok, SECRET);
    expect(back?.t).toBe("at");
  });

  it("rejects a tampered payload", async () => {
    const tok = await mintToken({ t: "rt", iat: 1, exp: 9999999999 }, SECRET);
    const [v, body, mac] = tok.split(".");
    const forged = JSON.parse(new TextDecoder().decode(b64urlDecode(body!)!));
    forged.t = "at"; // try to upgrade a refresh token into an access token
    const forgedTok = `${v}.${b64url(new TextEncoder().encode(JSON.stringify(forged)))}.${mac}`;
    expect(await verifyToken(forgedTok, SECRET)).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const tok = await mintToken({ t: "at", iat: 1, exp: 9999999999 }, SECRET);
    expect(await verifyToken(tok, "some-other-secret")).toBeNull();
  });

  it("rejects an expired token and accepts an unexpired one", async () => {
    const tok = await mintToken({ t: "at", iat: 1, exp: 100 }, SECRET);
    expect(await verifyToken(tok, SECRET, 99)).not.toBeNull();
    expect(await verifyToken(tok, SECRET, 100)).toBeNull();
  });
});

describe("pkceMatches", () => {
  it("accepts the matching verifier", async () => {
    expect(await pkceMatches(VERIFIER, await challengeFor(VERIFIER))).toBe(true);
  });

  it("rejects a different verifier", async () => {
    const other = VERIFIER.replace(/^a/, "b");
    expect(await pkceMatches(other, await challengeFor(VERIFIER))).toBe(false);
  });

  it("rejects verifiers outside the RFC 7636 charset/length", async () => {
    expect(await pkceMatches("short", await challengeFor(VERIFIER))).toBe(false);
    expect(await pkceMatches("a".repeat(129), await challengeFor(VERIFIER))).toBe(false);
  });
});

describe("isAllowedRedirect", () => {
  it("accepts Claude's hosted callback", () => {
    expect(isAllowedRedirect(CALLBACK)).toBe(true);
    expect(isAllowedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
  });

  it("accepts loopback on any port and any path (native agents differ)", () => {
    expect(isAllowedRedirect("http://localhost:3118/callback")).toBe(true); // Claude Code
    expect(isAllowedRedirect("http://localhost:1455/auth/callback")).toBe(true); // Codex CLI
    expect(isAllowedRedirect("http://127.0.0.1:49152/anything")).toBe(true);
  });

  it("accepts operator-configured extras by exact match only", () => {
    const extra = ["https://chatgpt.com/connector_platform_oauth_redirect"];
    expect(isAllowedRedirect(extra[0]!, extra)).toBe(true);
    expect(isAllowedRedirect("https://chatgpt.com/other", extra)).toBe(false);
    expect(isAllowedRedirect(extra[0]!)).toBe(false); // not without config
  });

  it("rejects everything else", () => {
    expect(isAllowedRedirect("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirect("https://claude.ai/other/path")).toBe(false);
    expect(isAllowedRedirect("http://192.168.1.1/callback")).toBe(false); // non-loopback http
    expect(isAllowedRedirect("not a url")).toBe(false);
  });
});

describe("parseExtraRedirects", () => {
  it("splits on commas/whitespace and keeps only valid https URLs", () => {
    expect(
      parseExtraRedirects("https://a.example/cb, https://b.example/cb\n not-a-url http://c.example/cb"),
    ).toEqual(["https://a.example/cb", "https://b.example/cb"]);
  });

  it("returns empty for unset config", () => {
    expect(parseExtraRedirects(undefined)).toEqual([]);
    expect(parseExtraRedirects("")).toEqual([]);
  });
});

describe("discovery documents", () => {
  it("advertises what claude.ai requires", () => {
    const as = authServerMetadata("https://mcp.example");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.registration_endpoint).toBe("https://mcp.example/register");
    expect((as.scopes_supported as string[])).toContain("offline_access");
    const pr = protectedResourceMetadata("https://mcp.example");
    expect(pr.resource).toBe("https://mcp.example/mcp");
    expect(pr.authorization_servers).toEqual(["https://mcp.example"]);
  });

  it("401 carries the resource_metadata pointer", () => {
    const res = unauthorized("https://mcp.example");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
    );
  });
});

describe("register", () => {
  const reg = (body: unknown) =>
    handleRegister(
      new Request("https://x/register", { method: "POST", body: JSON.stringify(body) }),
      SECRET,
    );

  it("registers a client with Claude callbacks", async () => {
    const res = await reg({ redirect_uris: [CALLBACK] });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
    expect(j.token_endpoint_auth_method).toBe("none");
    expect((await verifyToken(j.client_id, SECRET))?.t).toBe("client");
  });

  it("rejects foreign redirect URIs", async () => {
    const res = await reg({ redirect_uris: ["https://evil.example/cb"] });
    expect(res.status).toBe(400);
  });
});

/** Drive the full flow: authorize (correct password) → token → call /mcp. */
async function authorize(challenge: string, password = SECRET): Promise<Response> {
  const form = new URLSearchParams({
    response_type: "code",
    client_id: "whatever",
    redirect_uri: CALLBACK,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mail offline_access",
    password,
  });
  return handleAuthorizePost(
    new Request("https://x/authorize", { method: "POST", body: form.toString() }),
    SECRET,
    compareSecret,
  );
}

describe("authorize + token flow", () => {
  it("wrong password re-renders the consent page, no redirect", async () => {
    const res = await authorize(await challengeFor(VERIFIER), "wrong");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("full happy path yields a working access token", async () => {
    const res = await authorize(await challengeFor(VERIFIER));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get("state")).toBe("st4te");
    const code = loc.searchParams.get("code")!;

    const tokenRes = await handleToken(
      new Request("https://x/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER,
          redirect_uri: CALLBACK,
          client_id: "whatever",
        }).toString(),
      }),
      SECRET,
    );
    expect(tokenRes.status).toBe(200);
    const t = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    expect(await verifyAccessToken(`Bearer ${t.access_token}`, SECRET)).toBe(true);
    // A refresh token must NOT pass as an access token.
    expect(await verifyAccessToken(`Bearer ${t.refresh_token}`, SECRET)).toBe(false);

    // And the refresh grant rotates to a fresh, working access token.
    const refreshed = await handleToken(
      new Request("https://x/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
        }).toString(),
      }),
      SECRET,
    );
    expect(refreshed.status).toBe(200);
    const t2 = (await refreshed.json()) as { access_token: string };
    expect(await verifyAccessToken(`Bearer ${t2.access_token}`, SECRET)).toBe(true);
  });

  it("token exchange fails with the wrong PKCE verifier", async () => {
    const res = await authorize(await challengeFor(VERIFIER));
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const bad = await handleToken(
      new Request("https://x/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER.replace(/^a/, "b"),
          redirect_uri: CALLBACK,
        }).toString(),
      }),
      SECRET,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects unknown grant types with the RFC error code", async () => {
    const res = await handleToken(
      new Request("https://x/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      }),
      SECRET,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });
});
