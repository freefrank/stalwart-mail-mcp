# stalwart-mail-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/freefrank/stalwart-mail-mcp)

Connect AI agents — **claude.ai**, **Claude Code**, **Codex CLI**, **Cursor**,
and any other MCP client — to your self-hosted [Stalwart](https://stalw.art)
mail server. Runs on Cloudflare Workers, speaks JMAP to Stalwart, and ships
its own MCP-spec OAuth so hosted-agent connector dialogs work out of the box —
no gateway, no database, no state.

```
agent ──Streamable HTTP (OAuth or bearer)──▶ Cloudflare Worker ──HTTPS Basic (app password)──▶ Stalwart /jmap
```

## Tools

| Tool | What it does |
|---|---|
| `search_mail` | Full-text / sender / mailbox / date / attachment / unread filters, newest-first summaries (≤50) |
| `read_mail` | One full message — prefers `textBody`, converts HTML to text, truncates at 50k chars, attachments as metadata only |
| `list_mailboxes` | Mailbox tree with roles, totals, unread counts |
| `create_draft` | Writes a draft to Drafts and echoes it back for review — **never sends**. Optional `from` selects any of the account's sending identities (aliases) |
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

  ```sh
  curl -sI https://YOUR-MAIL-HOST/.well-known/jmap
  # expect: HTTP 307, location: /jmap/session
  ```

  ⚠️ On multi-service stacks the JMAP host is often **not** the webmail host —
  a `404` here usually means you probed the wrong hostname, not that JMAP is
  disabled.
- A Cloudflare account (free tier is fine).

## Step 1 — Create an app password in Stalwart

The connector authenticates as one mailbox account, using a Stalwart **app
password** — never the real account password. App passwords are revocable
independently, so killing the connector's access never touches your own login.

First find your JMAP account id:

```sh
curl -su 'me@example.com:REAL-PASSWORD' -L https://YOUR-MAIL-HOST/.well-known/jmap \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['primaryAccounts']['urn:ietf:params:jmap:mail'])"
```

Then create the app password (raw JMAP, authenticated as the account itself):

```sh
curl -su 'me@example.com:REAL-PASSWORD' -X POST https://YOUR-MAIL-HOST/jmap/ \
  -H 'content-type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
       "methodCalls":[["x:AppPassword/set",{"accountId":"ACCOUNT-ID",
         "create":{"mcp":{"description":"agent MCP connector"}}},"0"]]}'
```

The secret is in the response under `created.mcp.secret` (an `app_…` string).

> ⚠️ **The plaintext appears only in this one response.** Every later read —
> `AppPassword/get`, `stalwart-cli`, the webadmin — shows a `****` mask. If
> you lose it, destroy and recreate (`"destroy":["<id>"]` in the same call).

To revoke later: `x:AppPassword/set` with `"destroy":["<id>"]`, or delete it
in the Stalwart webadmin. The Worker fails closed on the next request.

## Step 2 — Generate the bearer token

`MCP_BEARER_TOKEN` is the connector's own credential — what agents present to
the Worker. It is also the OAuth consent password and the root of the OAuth
token signing key, so **rotating this one secret revokes everything at once**.

Generate a strong one (CSPRNG, ≥32 bytes):

```sh
openssl rand -base64 33
```

## Step 3 — Deploy the Worker

### Option A — Deploy button

Click the button at the top. Cloudflare clones the repo into your GitHub/GitLab
account and walks you through setup:

- **Variables**: set `STALWART_ORIGIN` to your Stalwart JMAP origin
  (e.g. `https://mail.example.com`)
- **Secrets**: the flow reads `.dev.vars.example` and prompts for
  `STALWART_USER` (the mailbox account), `STALWART_PASS` (the app password
  from Step 1), and `MCP_BEARER_TOKEN` (from Step 2)

Your MCP URL is then `https://stalwart-mail-mcp.<your-subdomain>.workers.dev/mcp`.

### Option B — wrangler CLI

```sh
git clone https://github.com/freefrank/stalwart-mail-mcp
cd stalwart-mail-mcp
npm install
npm run typecheck && npm test

# 1. Edit wrangler.jsonc → "vars" → STALWART_ORIGIN

# 2. Secrets (each command prompts for the value; nothing lands in the repo):
npx wrangler secret put STALWART_USER      # e.g. me@example.com
npx wrangler secret put STALWART_PASS      # the app_… password from Step 1
npx wrangler secret put MCP_BEARER_TOKEN   # the token from Step 2

npx wrangler deploy
```

For a custom domain, uncomment `routes` in `wrangler.jsonc` — wrangler manages
DNS and the certificate automatically if the zone is on the same account.

Smoke test either way:

```sh
curl https://YOUR-WORKER/healthz            # → ok
curl -X POST https://YOUR-WORKER/mcp        # → 401 (fail-closed, good)
```

Local development: `cp .dev.vars.example .dev.vars`, fill it in, `npm run dev`.

## Step 4 — Connect your agent

The Worker accepts **two credentials on the same `/mcp` endpoint**, so every
kind of MCP client works:

| Auth mode | Who needs it | How it works |
|---|---|---|
| **OAuth** | Hosted agents whose connector UI has no header field: claude.ai, ChatGPT connectors, … | Full MCP-spec OAuth (discovery, DCR, PKCE). The browser consent page asks for `MCP_BEARER_TOKEN` as the connector password. |
| **Static bearer** | Anything that can send headers: Claude Code, Codex CLI, Cursor, MCP Inspector, curl | `Authorization: Bearer <MCP_BEARER_TOKEN>` on every request. No OAuth involved. |

### claude.ai (OAuth)

Settings → Connectors → **Add custom connector**:

1. URL: `https://YOUR-WORKER/mcp`
2. Leave OAuth Client ID / Secret **empty** (dynamic client registration
   handles it)
3. Click Add — a consent page opens; paste your `MCP_BEARER_TOKEN`

### Claude Code (bearer)

```sh
claude mcp add --transport http stalwart-mail https://YOUR-WORKER/mcp \
  --header "Authorization: Bearer YOUR-MCP_BEARER_TOKEN"
```

### Codex CLI (bearer)

`~/.codex/config.toml`:

```toml
[mcp_servers.stalwart-mail]
url = "https://YOUR-WORKER/mcp"
http_headers = { "Authorization" = "Bearer YOUR-MCP_BEARER_TOKEN" }
```

### Other hosted agents (OAuth + allowlist)

OAuth callback URLs are allowlisted. Claude's callback and localhost loopback
(any port — Claude Code, Codex CLI, and friends differ in path) are built in.
For another hosted agent (e.g. ChatGPT connectors):

1. Try to connect once — the consent error page echoes the agent's exact
   callback URL
2. Add it to `wrangler.jsonc` → `vars` → `OAUTH_ALLOWED_REDIRECTS`
   (comma-separated, exact match) and redeploy

```jsonc
"OAUTH_ALLOWED_REDIRECTS": "https://chatgpt.com/connector_platform_oauth_redirect"
```

Only claude.ai has been verified end-to-end; other agents follow the same
standard OAuth profile (RFC 8414/9728/7591 + S256 PKCE + form-urlencoded
`/token`), so they are expected to work once allowlisted.

## Design notes

- **Fully stateless.** No Durable Objects, no KV. Each request builds a fresh
  MCP server + `WebStandardStreamableHTTPServerTransport`
  (`sessionIdGenerator: undefined`). OAuth codes/tokens are HMAC-SHA256-signed
  self-contained blobs; the signing key derives from `MCP_BEARER_TOKEN`.
- **Single-user trust model.** The OAuth consent password IS the bearer token:
  whoever holds it can call `/mcp` directly anyway, so the consent page adds
  no new trust boundary. Documented stateless tradeoffs: authorization codes
  live 2 minutes and are PKCE-bound but not single-use; refresh rotation
  issues a new token without revoking the old one (it ages out on its own).
- **Outbound host pinned.** Requests go only to `STALWART_ORIGIN`; a JMAP
  session advertising a foreign `apiUrl` is refused. Nothing from tool
  arguments ever becomes a host.
- **From is identity-constrained.** The optional `from` on `create_draft` must
  match one of the account's JMAP identities — aliases work, arbitrary
  spoofing does not. Rejections list the legal addresses.
- **Untrusted-content fencing.** Mail bodies and previews are wrapped in
  explicit fences marking them as external untrusted data.
- **Quiet logs.** No mail content, no recipient addresses, no tokens.
- Server-side clamps: search `limit` forced to 1–50, bodies truncated at 50k
  chars with an explicit `[…TRUNCATED…]` marker.

## Informed-consent note

Once connected, the agent's cloud (Anthropic, OpenAI, …) holds credentials
that can read the whole mailbox **and send mail as the account**, with
requests originating from their IPs, not yours. The two-step send flow is a
mitigation, not isolation. Scope the account (or its visibility in Stalwart)
accordingly.

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
one user account, remote hosted-agent connector, send guardrails. They
compose; neither replaces the other.

## License

MIT
