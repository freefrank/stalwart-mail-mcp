# stalwart-mail-mcp

Connect [claude.ai](https://claude.ai) to your self-hosted
[Stalwart](https://stalw.art) mail server as a **custom connector**. Runs on
Cloudflare Workers, speaks JMAP to Stalwart, and ships its own MCP-spec OAuth
so the claude.ai connector dialog works out of the box — no gateway, no
database, no state.

```
claude.ai ──Streamable HTTP + OAuth──▶ Cloudflare Worker ──HTTPS Basic (app password)──▶ Stalwart /jmap
```

## Tools

| Tool | What it does |
|---|---|
| `search_mail` | Full-text / sender / mailbox / date / attachment / unread filters, newest-first summaries (≤50) |
| `read_mail` | One full message — prefers `textBody`, converts HTML to text, truncates at 50k chars, attachments as metadata only |
| `list_mailboxes` | Mailbox tree with roles, totals, unread counts |
| `create_draft` | Writes a draft to Drafts and echoes it back for review — **never sends** |
| `send_draft` | Sends a draft **by id** via JMAP `EmailSubmission`, then files it Drafts → Sent |

### Why sending is two steps

There is deliberately no one-shot `send_mail(to, subject, body)`. `read_mail`
returns untrusted external content; with a one-shot sender, a hostile email
could be a single tool call away from sending mail as you (prompt injection).
Instead the model must `create_draft` (which returns the full draft for human
review) and then explicitly `send_draft` that id. `send_draft` also refuses
any id that is not a draft, so it can never re-send or forward existing mail.

## Requirements

- A Stalwart server (0.16+) with JMAP enabled. Verify:
  `curl -sI https://YOUR-HOST/.well-known/jmap` → expect `307` to
  `/jmap/session`. Careful: on multi-service stacks the JMAP host is often
  **not** the webmail host.
- An **app password** for the account to expose (Stalwart supports these as
  first-class credentials — revocable independently of the account password).
  The connector reads/sends as this one account; From is always its identity.
- A Cloudflare account with `wrangler` logged in.

## Deploy

```sh
npm install
npm run typecheck && npm test

# Point at your Stalwart (edit wrangler.jsonc "vars"):
#   "STALWART_ORIGIN": "https://mail.example.com"

npx wrangler secret put STALWART_USER      # the account, e.g. me@example.com
npx wrangler secret put STALWART_PASS      # its app password — never the real password
npx wrangler secret put MCP_BEARER_TOKEN   # CSPRNG ≥32 bytes: openssl rand -base64 33

npx wrangler deploy
```

Local dev: copy `.dev.vars.example` to `.dev.vars`, fill it in, `npm run dev`.

### Creating an app password

The plaintext is returned **only once, at creation** — later reads return a
mask. Via raw JMAP (as the account, against your Stalwart):

```sh
curl -u 'me@example.com:REAL-PASSWORD' -X POST https://mail.example.com/jmap/ \
  -H 'content-type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
       "methodCalls":[["x:AppPassword/set",{"accountId":"YOUR-ACCOUNT-ID",
         "create":{"mcp":{"description":"claude.ai MCP connector"}}},"0"]]}'
```

Read the `created` object in the response for the secret. (The account id is
in your JMAP session: `curl -u user:pass https://HOST/.well-known/jmap -L`.)

## Connect claude.ai

Settings → Connectors → **Add custom connector**:

1. URL: `https://YOUR-WORKER/mcp`
2. Leave OAuth Client ID / Secret **empty** (dynamic client registration
   handles it)
3. Click Add — a browser consent page opens; paste your `MCP_BEARER_TOKEN`
   as the connector password

The Worker implements the OAuth profile the hosted Claude surfaces require
(RFC 9728/8414 discovery, RFC 7591 DCR, S256 PKCE, form-urlencoded `/token`,
refresh tokens). Claude Code and MCP Inspector can skip OAuth and send
`Authorization: Bearer <MCP_BEARER_TOKEN>` directly — both paths stay live.

## Design notes

- **Fully stateless.** No Durable Objects, no KV. Each request builds a fresh
  MCP server + `WebStandardStreamableHTTPServerTransport`
  (`sessionIdGenerator: undefined`). OAuth codes/tokens are HMAC-SHA256-signed
  self-contained blobs; the signing key derives from `MCP_BEARER_TOKEN`, so
  **rotating that one secret revokes every OAuth session** — the single-user
  revocation lever.
- **Single-user trust model.** The OAuth consent password IS the bearer token:
  whoever holds it can call `/mcp` directly anyway, so the consent page adds
  no new trust boundary. Documented stateless tradeoffs: authorization codes
  live 2 minutes and are PKCE-bound but not single-use; refresh rotation
  issues a new token without revoking the old one (it ages out on its own).
- **Outbound host pinned.** Requests go only to `STALWART_ORIGIN`; a JMAP
  session advertising a foreign `apiUrl` is refused. Nothing from tool
  arguments ever becomes a host.
- **Redirect allowlist hardcoded** to Claude's callbacks
  (`claude.ai`/`claude.com` `/api/mcp/auth_callback`) and Claude Code's
  localhost loopback (any port), regardless of what a client registers.
- **Untrusted-content fencing.** Mail bodies and previews are wrapped in
  explicit fences marking them as external untrusted data.
- **Quiet logs.** No mail content, no recipient addresses, no tokens.
- Server-side clamps: search `limit` forced to 1–50, bodies truncated at 50k
  chars with an explicit `[…TRUNCATED…]` marker.

## Informed-consent note

Once connected, Anthropic's cloud holds credentials that can read the whole
mailbox **and send mail as the account**, with requests originating from
Anthropic IPs. The two-step send flow is a mitigation, not isolation. Scope
the account (or its visibility in Stalwart) accordingly.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest — pure-function units + full OAuth flow
npm run dev         # wrangler dev with .dev.vars
```

MCP SDK is v2 (`@modelcontextprotocol/server`, spec 2026-07-28). Cloudflare's
`McpAgent` template is deliberately not used — it depends on Durable Objects.

## Related projects

[`nikitatsym/stalwart-mcp`](https://github.com/nikitatsym/stalwart-mcp) is the
other Stalwart MCP server — a different tool for a different job: it drives
Stalwart's **admin REST API** (principals, queues, DKIM, reindex) as a local
stdio server with an admin token. This project is the **mailbox side**: JMAP,
one user account, remote claude.ai connector, send guardrails. They compose;
neither replaces the other.

## License

MIT
