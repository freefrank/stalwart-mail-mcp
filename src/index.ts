/**
 * Worker entry point. POST /mcp — Streamable HTTP, stateless (MCP 2026-07-28).
 *
 * Per-request wiring: a fresh McpServer + transport pair per request. The
 * 2026-07-28 protocol has no sessions or handshake, so nothing needs to
 * survive between requests (spec §5.2) — this is also why there are no
 * Durable Objects or KV bindings. The OAuth endpoints (src/oauth.ts) keep
 * that property: codes and tokens are self-contained signed blobs.
 *
 * /mcp accepts either credential:
 *   - the static MCP_BEARER_TOKEN (curl, MCP Inspector, Claude Code headers)
 *   - an OAuth access token minted by /token (claude.ai custom connector,
 *     which only speaks MCP-spec OAuth)
 *
 * Logging policy (spec §8.3): nothing here or downstream logs mail content,
 * recipient addresses, or tokens. Only method names + status codes.
 */
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "./mcp.js";
import { verifyBearer, compareSecret } from "./auth.js";
import {
  protectedResourceMetadata,
  authServerMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  verifyAccessToken,
  unauthorized,
} from "./oauth.js";

export interface Env {
  /** Stalwart JMAP origin, e.g. https://mail.example.com (wrangler.jsonc vars). */
  STALWART_ORIGIN: string;
  STALWART_USER: string;
  STALWART_PASS: string;
  MCP_BEARER_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));

// --- OAuth discovery + endpoints (claude.ai custom connector) --------------
// Origin is derived from the request so `npm run dev` discovery documents
// point at localhost instead of production.
const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;

// claude.ai probes the path-suffixed variant first (RFC 9728 §3.1).
app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json(protectedResourceMetadata(origin(c))),
);
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(protectedResourceMetadata(origin(c))),
);
app.get("/.well-known/oauth-authorization-server", (c) => c.json(authServerMetadata(origin(c))));

app.post("/register", (c) => handleRegister(c.req.raw, c.env.MCP_BEARER_TOKEN));
app.get("/authorize", (c) => handleAuthorizeGet(c.req.raw));
app.post("/authorize", (c) => handleAuthorizePost(c.req.raw, c.env.MCP_BEARER_TOKEN, compareSecret));
app.post("/token", (c) => handleToken(c.req.raw, c.env.MCP_BEARER_TOKEN));

// --- MCP endpoint ----------------------------------------------------------

app.all("/mcp", async (c) => {
  const auth = c.req.header("authorization");
  const ok =
    (await verifyBearer(auth, c.env.MCP_BEARER_TOKEN)) ||
    (await verifyAccessToken(auth, c.env.MCP_BEARER_TOKEN));
  if (!ok) return unauthorized(origin(c));
  const server = createMcpServer(c.env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default app;
