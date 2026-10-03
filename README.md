# Beatrice

A text-message interface to Corbyn, the project's LLM agent. Linq receives messages, Temporal keeps the conversation durable, and OpenRouter generates replies using the existing agent and tools.

## Run locally

Requires Node.js 24+, pnpm, Docker, an OpenRouter API key, and a Linq API account with a messaging line.

1. Install dependencies and start Temporal:

   ```sh
   pnpm install
   docker compose up -d
   ```

2. Add the following values to the root `.env`. Use `.env.example` as a reference; preserve any keys already configured locally.

   ```dotenv
   OPENROUTER_API_KEY=your-openrouter-key
   LINQ_API_KEY=your-linq-api-key
   LINQ_ALLOWED_NUMBERS=+15551234567
   ```

   `LINQ_ALLOWED_NUMBERS` is your **personal phone**, with country code. The local environment is already configured with the owner's requested personal number. `LINQ_PHONE_NUMBER` is the **separate assistant number** assigned to your Linq account. Do not use the same number for both. With multiple Linq lines, set `LINQ_PHONE_NUMBER` explicitly; setup selects the line automatically when the account has exactly one.

3. For local webhook testing, expose port 3001 through your own development HTTPS URL and register it using a separate Linq test account or subscription:

   ```sh
   pnpm linq:setup https://YOUR-DEVELOPMENT-HOST/webhooks/linq
   ```

   Setup checks your Linq lines, subscribes to `message.received`, pins webhook version `2026-02-03`, and saves the signing secret and subscription ID to the root `.env` without printing the secret. Running it again updates the saved subscription. An existing subscription requires its original signing secret.

   The production webhook uses `https://linq.ayukumar261.com/webhooks/linq`. Do not repoint its saved subscription when testing locally unless you intend to take production offline.

4. Start the worker (`apps/worker`) and the webhook gateway (`apps/gateway`):

   ```sh
   pnpm dev
   ```

5. Text the assistant number printed by setup from your allowed personal phone. The local account uses Linq's shared number **+1 205-503-0476**. Your phone must send the first message before the shared line can reply. Follow-up messages share conversation context. Send `/reset` to begin a fresh conversation.

The computer, worker, Temporal, and tunnel must remain running to receive replies locally. For continuous availability, run them on an always-on host with a stable HTTPS URL. Set `LINQ_HOST=0.0.0.0` when a container or reverse proxy needs to reach the webhook; the default is localhost. `LINQ_PORT` defaults to `3001`.

The worker requires `OPENROUTER_API_KEY` and `LINQ_API_KEY` to start. The gateway also requires the signing secret, assistant number, and allowed personal numbers.

## Deploy on Dokploy

Create a **Docker Compose** service with Git source `https://github.com/ayukumar261/beatrice.git`, branch `main`, and Compose Path `./docker-compose.dokploy.yml`.

In its Environment tab, set `POSTGRES_PASSWORD` to a random password and supply `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_PHONE_NUMBER`, `LINQ_ALLOWED_NUMBERS`, `OPENROUTER_API_KEY`, and `BRAINTRUST_API_KEY` from the existing local configuration. `BRAINTRUST_PROJECT` defaults to `platform`. Set `TUNNEL_CRED_CONTENTS` to the single-line JSON contents of the ignored `deploy/tunnel-credentials.json`, enclosed in single quotes. Keep these values in Dokploy; never commit them or include them in an image.

The deployment starts PostgreSQL, Temporal 1.29.1, the gateway, the worker, and a Cloudflare Tunnel connector. Database storage uses the persistent `postgres-data` Docker volume. No database, Temporal, or app ports are published on the host. The gateway also joins `dokploy-network` for Dokploy's optional internal domain route.

The explicit proxied CNAME `linq.ayukumar261.com` points to `a15e8ecc-f7ef-4414-b78a-2bc2d91e33a5.cfargotunnel.com` (the `beatrice-sms` tunnel). This overrides the domain's wildcard route and sends traffic straight to `gateway:3001` through the connector in this stack. Cloudflare provides public HTTPS and encrypts the connection to the server. The tunnel exposes only `/webhooks/linq` and `/healthz`; other paths return `404`. Stop any other connector for this tunnel before deploying against a separate database.

Dokploy's optional domain entry uses service `gateway`, port `3001`, and path `/` with its HTTPS toggle off; public HTTPS is handled by Cloudflare. Deploy, then register the production webhook:

```sh
pnpm linq:setup https://linq.ayukumar261.com/webhooks/linq
```

Local database contents are not migrated automatically. After deploying, verify that PostgreSQL, Temporal, and the gateway are healthy, the worker logs show it polling the task queue, and `GET https://linq.ayukumar261.com/healthz` returns `200`. An unsigned webhook POST must return `401`. No local tunnel or computer process is needed for production.

Pushes to `main` automatically deploy through the repository's GitHub push webhook, with Autodeploy enabled in Dokploy. Other branches do not trigger this deployment. PostgreSQL data survives ordinary redeployments; configure volume backups in Dokploy before relying on the server for irreplaceable conversation history. The Temporal dashboard is deliberately not exposed publicly.

## Message flow

```text
Your phone → Linq → POST /webhooks/linq → Temporal → Corbyn/OpenRouter
Your phone ← Linq ← reply activity     ← Temporal ← LLM response
```

- The official Linq SDK verifies signatures and rejects stale requests. Unsigned requests receive `401`.
- Only direct inbound messages from `LINQ_ALLOWED_NUMBERS` to `LINQ_PHONE_NUMBER` are accepted. Group chats, outgoing events, opt-outs, and reconciled historical messages are ignored.
- The server returns `200` after Temporal stores the message, without waiting for the LLM. Queue failures return `503` so Linq can retry.
- Each Linq chat has one conversation workflow. It processes messages serially, remembers the latest 20 complete LLM turns, and deduplicates recent event/message IDs. The last 2,000 messages' IDs survive workflow rollover and worker restarts.
- Outgoing replies have a stable Linq idempotency key. Temporary send errors retry for up to five minutes; permanent failures are logged without blocking later turns.
- Text and links are supported. Media-only messages receive a request for a text description. Attachments are not downloaded or sent to the model.
- Linq chooses the available messaging transport, including SMS, iMessage, and RCS. Replies go to the same chat.

`GET /healthz` checks that the HTTP listener is alive. It does not probe Linq, OpenRouter, or Temporal. Temporal's local UI is available at [localhost:8080](http://localhost:8080).

The agent's existing Braintrust tracing is retained. `.env.braintrust` is loaded if present. `/reset` clears the context used for future replies; it does not erase stored Temporal history or traces.

## Web search and conversation memory

Web search is always enabled through OpenRouter using Parallel's `fast` mode and the existing OpenRouter key. The model searches for explicit lookups and information that needs current verification. Each search retrieves at most three results with up to 1,500 characters per result. Each conversation turn allows up to 50 searches shared across model calls, with a fresh allowance for the next turn; failed activity retries may repeat searches. Missing or inconsistent search usage consumes the remaining allowance conservatively. Sources are retained as plain URLs in replies, and usage and cost are included in Braintrust traces.

Parallel Fast is currently $0.001 per search, plus model tokens. See [OpenRouter's current search pricing](https://openrouter.ai/docs/guides/features/server-tools/web-search#pricing).

SMS conversations have no inactivity timeout. The next message continues the same chat, using the latest 20 complete LLM turns. Worker restarts preserve that state in Temporal. After 100 processed messages, the workflow starts a new run carrying the conversation state; this does not reset your chat. Send `/reset` to clear the context used for future replies.

A model request has a 100-second deadline, within a two-minute Temporal activity timeout. Heartbeats run every five seconds during searches and streaming. These request timeouts do not clear conversation memory.

## Validation

```sh
pnpm check-types
pnpm lint
pnpm test
# Requires the local Temporal service (docker compose up -d).
pnpm test:integration
```

Unit tests cover webhook authentication, sender/line filtering, malformed requests, body limits, configuration, and outbound API requests. The integration test uses real Temporal with mocked Linq and LLM activities, so it sends no real texts and makes no model API calls.

## References

- [Linq webhook authentication and delivery](https://docs.linqapp.com/channel/imessage/guides/webhooks/)
- [Linq message event format](https://docs.linqapp.com/channel/imessage/guides/webhooks/events/)
- [Send a message to an existing Linq chat](https://docs.linqapp.com/channel/imessage/api/resources/chats/subresources/messages/methods/send/)
- [Linq dashboard](https://dashboard.linqapp.com/)
