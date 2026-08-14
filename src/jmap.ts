/**
 * Minimal JMAP client for Stalwart (RFC 8620 core + RFC 8621 mail).
 *
 * Security invariants (spec §8):
 *  - Outbound requests go ONLY to STALWART_ORIGIN. The session-advertised
 *    apiUrl is validated against it; nothing from tool arguments ever
 *    becomes a host.
 *  - Errors are classified (auth / method-level / transient) — auth errors
 *    are never retried; transient errors retry at most twice with backoff.
 */

const SESSION_TTL_MS = 10 * 60 * 1000;

export const JMAP_CORE = "urn:ietf:params:jmap:core";
export const JMAP_MAIL = "urn:ietf:params:jmap:mail";
/** RFC 8621 §7 — required for Identity/* and EmailSubmission/* (sending). */
export const JMAP_SUBMISSION = "urn:ietf:params:jmap:submission";

export interface JmapEnv {
  /**
   * The Stalwart HTTP origin serving JMAP, e.g. `https://mail.example.com`.
   * Careful: this is the backend/JMAP host, which on multi-service setups is
   * often NOT the webmail host. Verify with
   * `curl -sI https://<host>/.well-known/jmap` → expect `307 → /jmap/session`.
   */
  STALWART_ORIGIN: string;
  STALWART_USER: string;
  STALWART_PASS: string;
}

/**
 * Validate and normalize the configured origin. Outbound requests go ONLY
 * here (spec §8) — a bad value must fail closed, not fall back anywhere.
 */
export function resolveOrigin(env: JmapEnv): string {
  const raw = (env.STALWART_ORIGIN ?? "").trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(
      "STALWART_ORIGIN is not configured — set it in wrangler.jsonc vars " +
        '(e.g. "https://mail.example.com").',
    );
  }
  if (u.protocol !== "https:" || u.origin !== raw) {
    throw new Error(
      `STALWART_ORIGIN must be a bare https origin with no path (got "${raw}").`,
    );
  }
  return u.origin;
}

export interface JmapSession {
  apiUrl: string;
  accountId: string;
  /** Login identity — usually the account's email address. */
  username: string;
}

/** Credentials invalid or insufficient rights. Never retried. */
export class JmapAuthError extends Error {
  constructor(status: number) {
    super(
      `Stalwart rejected the connector's credentials (HTTP ${status}). ` +
        `The STALWART_USER/STALWART_PASS secrets are invalid, expired, or lack access.`,
    );
    this.name = "JmapAuthError";
  }
}

/** JMAP method-level error (`error`-type method response). */
export class JmapMethodError extends Error {
  constructor(
    public readonly type: string,
    public readonly description?: string,
  ) {
    super(`JMAP method error "${type}"${description ? `: ${description}` : ""}`);
    this.name = "JmapMethodError";
  }
}

/** Network failure or 5xx after retries were exhausted. */
export class JmapTransientError extends Error {
  constructor(detail: string) {
    super(`Stalwart is unreachable or failing (${detail}).`);
    this.name = "JmapTransientError";
  }
}

type MethodCall = [string, Record<string, unknown>, string];

// Session cache lives for the isolate's lifetime — cheap, and a cold start
// simply re-discovers. Mail content is never cached (spec §7.1). The origin
// is stored alongside so a config change can never serve a stale session.
let cachedSession: { origin: string; session: JmapSession; fetchedAt: number } | null = null;

function basicAuth(env: JmapEnv): string {
  return "Basic " + btoa(`${env.STALWART_USER}:${env.STALWART_PASS}`);
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastDetail = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 4 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastDetail = `network error: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new JmapAuthError(res.status);
    if (res.status >= 500) {
      lastDetail = `HTTP ${res.status}`;
      continue;
    }
    return res;
  }
  throw new JmapTransientError(`${lastDetail}; retried twice without success`);
}

export async function getSession(env: JmapEnv): Promise<JmapSession> {
  const origin = resolveOrigin(env);
  if (
    cachedSession &&
    cachedSession.origin === origin &&
    Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS
  ) {
    return cachedSession.session;
  }
  const res = await fetchWithRetry(`${origin}/.well-known/jmap`, {
    headers: { authorization: basicAuth(env), accept: "application/json" },
  });
  if (!res.ok) {
    throw new JmapTransientError(
      `session discovery returned HTTP ${res.status} — is JMAP enabled on Stalwart, ` +
        `and does STALWART_ORIGIN point at the JMAP host (not the webmail host)?`,
    );
  }
  const body = (await res.json()) as {
    apiUrl?: string;
    username?: string;
    primaryAccounts?: Record<string, string>;
  };
  const apiUrl = new URL(body.apiUrl ?? "/jmap", origin);
  if (apiUrl.origin !== origin) {
    // Never follow a session that points off-host (spec §8.4).
    throw new Error(`JMAP session advertised a foreign apiUrl origin; refusing`);
  }
  const accountId = body.primaryAccounts?.[JMAP_MAIL];
  if (!accountId) {
    throw new Error("JMAP session has no primary mail account for this user");
  }
  const session: JmapSession = {
    apiUrl: apiUrl.toString(),
    accountId,
    username: body.username ?? env.STALWART_USER,
  };
  cachedSession = { origin, session, fetchedAt: Date.now() };
  return session;
}

/**
 * POST one JMAP request (possibly several back-referenced method calls) and
 * return `methodResponses`. Throws JmapMethodError if any response is an
 * `error` type.
 */
export async function jmapCall(
  env: JmapEnv,
  methodCalls: MethodCall[],
  extraCapabilities: string[] = [],
): Promise<Array<[string, Record<string, unknown>, string]>> {
  const session = await getSession(env);
  const using = [JMAP_CORE, JMAP_MAIL, ...extraCapabilities];
  const res = await fetchWithRetry(session.apiUrl, {
    method: "POST",
    headers: {
      authorization: basicAuth(env),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) {
    // Request-level JMAP error (RFC 8620 §3.6.1) or anything else non-2xx.
    let detail = `HTTP ${res.status}`;
    try {
      const problem = (await res.json()) as { type?: string; detail?: string };
      if (problem.type) detail += ` ${problem.type}${problem.detail ? `: ${problem.detail}` : ""}`;
    } catch {
      /* non-JSON body — keep status only */
    }
    throw new Error(`JMAP request rejected (${detail})`);
  }
  const body = (await res.json()) as {
    methodResponses: Array<[string, Record<string, unknown>, string]>;
  };
  for (const [name, args] of body.methodResponses) {
    if (name === "error") {
      const a = args as { type?: string; description?: string };
      throw new JmapMethodError(a.type ?? "unknown", a.description);
    }
  }
  return body.methodResponses;
}

/** Find a method response by name + call id; throws if absent. */
export function pickResponse<T>(
  responses: Array<[string, Record<string, unknown>, string]>,
  method: string,
  callId: string,
): T {
  const hit = responses.find(([name, , id]) => name === method && id === callId);
  if (!hit) throw new Error(`JMAP response missing ${method}#${callId}`);
  return hit[1] as T;
}

/** Test hook — reset the module-level session cache. */
export function _resetSessionCache(): void {
  cachedSession = null;
}
