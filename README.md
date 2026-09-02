# Yandex Eats MCP

Single-user Streamable HTTP MCP server for ChatGPT. It talks directly to the private web API used by `https://eats.yandex.com`; no browser automation is used.

Current release:

- searches restaurants and matching items near one server-configured delivery point;
- verifies multi-query matches against current menus and produces diverse, explainable food recommendations;
- normalizes dish categories, proteins, cooking methods, cuisines, dietary signals, and heuristic heaviness in Russian and English;
- stores explicit likes, dislikes, ratings, and order counts in the private state volume;
- loads restaurant availability and complete menus;
- lists and reads server-side carts;
- monitors active orders with server-directed polling, a persistent event cursor, and optional Telegram delivery;
- can add, update, and remove restaurant cart items, including items marked adult, after an explicit feature flag is enabled;
- protects the public MCP endpoint with a persistent single-user OAuth 2.1 + PKCE flow;
- never exposes the Yandex cookie, Passport token, exact coordinates, phone, address, or payment data as MCP results.

Checkout, `place_order`, pickup, SKU/retail carts, and multiorder are deliberately not implemented. Adult products may be added to a restaurant cart, but the MCP does not bypass eligibility checks or perform age verification; those requirements remain enforced by Yandex Eats. A cart is not an order.

## Risk notice

This project depends on an undocumented private API. Endpoints and response shapes can change without notice, behavior may be controlled by A/B flags, and automated use may be restricted by Yandex terms or anti-bot controls. Never automate CAPTCHA or OTP. Use a dedicated account if possible and do not publish this service for other users without a separate legal and security review.

The copied Cookie header may grant access to more than Yandex Eats. Treat it like an account password.

## Architecture

```text
ChatGPT
   │ HTTPS + OAuth 2.1/PKCE
   ▼
Cloudflare hostname / Tunnel
   │ http://127.0.0.1:3000
   ▼
Docker: yandex-eats-mcp
   │ private Cookie + stable device/session IDs
   ▼
https://eats.yandex.com
```

The process-level `OrderMonitor` is independent of MCP request sessions. It polls Yandex's read-only order endpoints, writes sanitized state to `/app/state/order-monitor-state.json`, appends cursor-addressable events to `/app/state/order-events.jsonl`, and optionally sends a minimal Telegram message.

The recommendation layer is independent of the private-API mappers. It expands a natural-language request into a bounded, canonically deduplicated set of search intents, deduplicates restaurant candidates across searches and pagination, loads up to 12 current menus with concurrency limited to 3, and keeps only matching available items. Deterministic normalization and scoring run locally; no LLM or external recommendation service is called. Final selection combines constraint coverage, score, restaurant/category quotas, and an MMR-like similarity penalty. Multi-person requests such as `Маше X, мне Y, из одного ресторана` are split into intent groups and rank restaurants by group coverage before selecting one distinct dish per group.

Explicit food preferences are stored atomically in `/app/state/food-preferences.json`. Automatic order-history import is intentionally not enabled: Yandex can return historical order shells without stable menu-item metadata, so the server only records signals explicitly supplied through `record_food_feedback`.

An MCP server cannot initiate a message in a sleeping ChatGPT conversation. ChatGPT can call `get_order_events` periodically (for example from a Scheduled Task), while Telegram provides the near-real-time push channel.

The MCP endpoint is `/mcp`. OAuth discovery, client registration, authorization, token, and protected-resource metadata endpoints are served by the same container. OAuth clients and hashed access/refresh tokens are persisted in the `yandex-eats-state` Docker volume. The owner password is a Docker secret and is never persisted in OAuth state.

## Requirements

- Docker Engine with Compose;
- an existing Cloudflare Tunnel and a hostname you control;
- a logged-in `eats.yandex.com` browser session;
- delivery latitude/longitude for the desired address.

## Configure secrets

Create the ignored local files. The container runs as the unprivileged
`node` user with UID/GID `1000:1000`, so the secret files must be readable by
GID `1000` while remaining inaccessible to other host users:

```bash
mkdir -p secrets
chown root:1000 secrets
chmod 750 secrets
umask 077
openssl rand -base64 32 > secrets/mcp_oauth_password
```

For `secrets/yandex_eats_cookie`:

1. Sign in to `https://eats.yandex.com` in Chrome.
2. Open DevTools → Network and reload the page.
3. Select an authenticated request and copy only the value of its complete `Cookie` request header.
4. Put that single-line value into `secrets/yandex_eats_cookie`. Do not include the `Cookie:` prefix.
5. Give the container's group read-only access to both secrets:

   ```bash
   chown root:1000 secrets/yandex_eats_cookie secrets/mcp_oauth_password
   chmod 640 secrets/yandex_eats_cookie secrets/mcp_oauth_password
   ```

Docker Compose implements file-backed secrets as read-only bind mounts, so a
host file owned by `root:root` with mode `0600` cannot be read by this
unprivileged container and causes an `EACCES` startup failure.

Do not paste either secret into ChatGPT, shell command arguments, logs, issues, or commits.

For Telegram notifications, create a bot with BotFather, determine the destination chat ID, and put the two raw values in separate ignored files:

```bash
printf '%s\n' '<bot token>' > secrets/order_notify_telegram_token
printf '%s\n' '<chat id>' > secrets/order_notify_telegram_chat_id
chown root:1000 secrets/order_notify_telegram_token secrets/order_notify_telegram_chat_id
chmod 640 secrets/order_notify_telegram_token secrets/order_notify_telegram_chat_id
```

Do not include quotes or variable names in either file. The bot must be able to message the selected chat.

## Configure the service

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
PUBLIC_BASE_URL=https://eats-mcp.example.com
YANDEX_EATS_LATITUDE=40.000000
YANDEX_EATS_LONGITUDE=44.000000
YANDEX_EATS_CITY=Yerevan
YANDEX_EATS_ADDRESS_LABEL=home
YANDEX_EATS_ENABLE_MUTATIONS=false
YANDEX_EATS_ENABLE_ORDER_MONITORING=true
ORDER_NOTIFY_PROVIDER=telegram
```

`YANDEX_EATS_ADDRESS_LABEL` is safe text returned to the model. Exact coordinates stay inside the client and are never included in MCP responses.

Start the server:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/healthz
```

The Compose port is bound to `127.0.0.1`, not all host interfaces.

## Cloudflare Tunnel

Create a published application route from your chosen hostname to:

```text
http://127.0.0.1:3000
```

That service address is correct when `cloudflared` runs on the host. If `cloudflared` runs in another container, put it on the same Docker network and route to `http://mcp:3000` instead of the host loopback address.

Important Cloudflare settings:

- do not cache `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, `/oauth/*`, or `/.well-known/*`;
- preserve streaming responses and the public `Host` header;
- WAF and rate-limit rules are fine, but do not place an interactive Cloudflare Access login in front of these paths—ChatGPT must reach MCP OAuth discovery and callbacks directly;
- keep `PUBLIC_BASE_URL` identical to the external HTTPS origin, without `/mcp` or a trailing path.

Cloudflare Tunnel makes the origin reachable; the MCP OAuth flow is still the application-level authorization boundary.

## Connect from ChatGPT

1. Confirm `https://your-domain.example/healthz` returns `{"status":"ok"}`.
2. In ChatGPT developer mode, add a custom MCP/plugin endpoint:

   ```text
   https://your-domain.example/mcp
   ```

3. ChatGPT should discover the OAuth metadata and open the Yandex Eats MCP authorization page.
4. Enter the value from `secrets/mcp_oauth_password`. This is the MCP owner password, not a Yandex password.
5. Review the tool list. `remove_cart_item` is destructive; checkout and order placement should not appear.

The OAuth owner page explicitly states that it grants search, recommendation, preference, order-status, and cart access. Checkout and order placement remain disabled.

## Tools

| Tool | State change | Notes |
| --- | ---: | --- |
| `auth_status` | No | Sanitized cookie-session status only |
| `get_delivery_context` | No | City/label only, never exact coordinates |
| `search` | No | Full-text search with opaque cursor |
| `get_place` | No | Availability and ETA |
| `search_items` | No | Multi-query, multi-page item search verified against current menus |
| `recommend_food` | No | Explainable scoring plus restaurant/category diversification |
| `record_food_feedback` | Yes, local preference state | Explicit likes, dislikes, ratings, and order counts only |
| `get_food_preferences` | No | Reads locally persisted preference signals |
| `get_menu` | No | Optional local query/category filtering |
| `get_cart` | No | Lists carts or loads one fresh cart |
| `get_active_orders` | No | Sanitized cached active orders and monitor health |
| `get_order_status` | No | Cached status or explicit read-only refresh |
| `get_order_events` | No | Persistent events after an exclusive sequence cursor |
| `add_to_cart` | Yes | Validates current menu, required options, and availability; adult-marked items are supported |
| `update_cart_item` | Yes | Explicit user request only |
| `remove_cart_item` | Yes, destructive | Never an automatic optimization |
| `server_capabilities` | No | Reports enabled safety boundaries |

Every mutation accepts an optional UUID `operationId`; repeating the same operation within ten minutes returns the same in-process result instead of repeating the upstream mutation. Reusing the ID with different arguments is rejected. Unsafe upstream requests are never automatically retried. If the response is lost or times out, the tool returns `MUTATION_STATUS_UNKNOWN`; call `get_cart` to reconcile.

After any successful mutation, the MCP reloads and returns the server cart. Budget checks must use that fresh total and its violated constraints, not a local sum.

## Food recommendations

`recommend_food` accepts a natural-language `query` together with optional structured constraints:

```json
{
  "query": "light lunch, fish / salad / seafood / soup, give me 10 varied options",
  "categories": ["fish", "salad", "seafood", "soup"],
  "prefer": ["grilled", "vegetables"],
  "avoid": ["deep fried", "creamy"],
  "maxPrice": 5000,
  "maxHeaviness": 0.65,
  "maxPerRestaurant": 2,
  "maxPerCategory": 2,
  "exploration": 0.6,
  "sameRestaurant": false,
  "limit": 10
}
```

Each result includes restaurant metadata, item ID/name/description/price/weight, an optional translated `searchName` from Yandex's search projection, normalized food attributes, `matchedTerms`, `intentCoverage`, `matchedIntent`, per-query `intentMatches`, a 0..1 score, and concise `scoreReasons`. Each intent match separates `requiredTerms` from `modifierTerms`: for example, `легкий суп` requires `soup`, while `light` only refines a dish that already satisfies that required concept. Natural-language lists such as `рыба, морепродукты, салат или суп`, slash-separated lists, and `либо` are parsed as alternatives; shared modifiers such as `light` are applied to every branch. `matchedIntents` contains only fully covered intents; a search hit or a modifier by itself is not treated as a match. Search item IDs are joined back to full-menu item IDs, so a translated search hit can verify a menu item even when the restaurant publishes its full menu in another language. Search-item ranking includes exact menu/translated-name matching, required-concept confidence, heaviness and stated-weight fit, rating, ETA, and a small restaurant/category diversity penalty. `heaviness` is an inspectable recommendation heuristic based on dish wording, preparation, compound-dish rules, sauce, category, and stated weight. It is not nutritional or medical data. Missing Armenian-market currency metadata is normalized to `AMD`, including the `֏` sign.

For an explicit multi-query search without preference-aware ranking, use:

```json
{
  "queries": ["fish", "seafood", "soup", "salad", "poke"],
  "maxPlaces": 12,
  "maxItems": 50,
  "maxPagesPerQuery": 2,
  "deduplicate": true
}
```

The ordinary `search` tool remains backward-compatible and exposes Yandex's fast search projection. Use `search_items` or `recommend_food` when a menu-level match is required. Recommendation calls are slower and consume more upstream requests because they verify full menus. Ratings, delivery fees, rating counts, and similar fields are returned only when the relevant Yandex response actually exposes them.

## Order monitoring and Telegram

Monitoring is independent of cart mutations and uses only read-like requests. Enable it with:

```dotenv
YANDEX_EATS_ENABLE_ORDER_MONITORING=true
ORDER_NOTIFY_PROVIDER=telegram
```

The list and tracking intervals are supplied by Yandex and clamped by `YANDEX_EATS_ORDER_POLL_MIN_MS` / `YANDEX_EATS_ORDER_POLL_MAX_MS`. Network, 429, and 5xx failures use bounded backoff. A 401/403 creates one `monitor.auth_expired` event; after the cookie is replaced, `SIGHUP` wakes the monitor immediately and recovery produces `monitor.recovered`.

The first successful snapshot is a baseline, so deploying the monitor does not notify about historical orders. Later discoveries and fingerprint changes create monotonically sequenced events. Telegram messages mask the order number and omit address, coordinates, phone, payment, map payload, and courier identity.

To poll from ChatGPT, retain `nextSequence` from `get_order_events` and pass it back as `afterSequence`. The cursor is exclusive and reading does not acknowledge events for other clients.

## Enabling cart mutations

Leave this disabled through initial deployment:

```dotenv
YANDEX_EATS_ENABLE_MUTATIONS=false
```

First verify `auth_status`, `search`, `get_menu`, and `get_cart`. Then prepare one disposable restaurant item with no required modifiers, enable the flag, and perform a controlled `add_to_cart` followed by `get_cart` and removal of only the newly created `cartItemId`.

```dotenv
YANDEX_EATS_ENABLE_MUTATIONS=true
```

Restart the container after changing the flag. Never use clear-cart as a test; it is intentionally not exposed.

## Cookie refresh

If `auth_status` reports `AUTH_EXPIRED` or `needsRefresh: true`, replace `secrets/yandex_eats_cookie` with a fresh single-line Cookie value and recreate the Docker secret mount:

```bash
chown root:1000 secrets/yandex_eats_cookie
chmod 640 secrets/yandex_eats_cookie
docker compose up -d --force-recreate mcp
```

Inside a non-Compose deployment where the mounted secret updates in place, `SIGHUP` reloads the cookie:

```bash
docker compose kill -s HUP mcp
```

No automatic Passport login, OTP, CAPTCHA handling, or token harvesting is implemented.

## Development and tests

```bash
npm install
npm run check
docker compose config
docker compose build
```

The normal test suite uses sanitized fixtures and mocked upstream responses. It verifies mapper tolerance, exact request wiring, recommendation normalization/scoring/deduplication/diversification, preference persistence, no retry for ambiguous mutations, mutation serialization/idempotency, auth persistence, and MCP tool annotations.

Read-only live contract tests are opt-in and require your local cookie and coordinates:

```bash
export YANDEX_EATS_COOKIE_FILE="$PWD/secrets/yandex_eats_cookie"
export YANDEX_EATS_LATITUDE="40.000000"
export YANDEX_EATS_LONGITUDE="44.000000"
npm run test:live:readonly
npm run test:live:orders:readonly
```

No live test in this repository creates an order. Normal tests never contact Yandex.

## Operational notes

- State under `/app/state` includes sensitive cookie-jar and OAuth data; back it up and protect the Docker host accordingly.
- `/readyz` reports monitor health without making an upstream request or exposing order IDs.
- Logs include endpoint, status, duration, and Yandex correlation IDs. Request/response bodies, cookies, authorization headers, session IDs, phone, address, and payment fields are redacted or not logged.
- `AUTH_NOT_CONFIGURED`: cookie secret is missing or unreadable.
- `AUTH_EXPIRED`: copy a fresh browser Cookie header.
- `DELIVERY_LOCATION_NOT_CONFIGURED`: configure both latitude and longitude.
- `MUTATIONS_DISABLED`: expected until the feature flag is deliberately enabled.
- `REQUIRES_CONFIGURATION`: inspect `get_menu` and ask the user to choose required options.
- `UNSUPPORTED_CART_MODE`: current release refuses unsupported SKU/pickup cart flows.
- `MUTATION_STATUS_UNKNOWN`: do not retry blindly; reconcile with `get_cart`.

[![M8ven Score](https://m8ven.ai/badge/mcp/sptmru-yandex-eats-mcp-4a62fs?v=6de9d4a3f48e8403cd283fb768e7655b)](https://m8ven.ai/mcp/sptmru-yandex-eats-mcp-4a62fs)
