# Blackjack Signaling

Signaling backend for Blackjack P2P multiplayer, built with Cloudflare Workers, Durable Objects, WebSockets and WebRTC.

This service only coordinates the initial peer connection. Blackjack gameplay traffic is sent directly between browsers over a WebRTC `RTCDataChannel` after negotiation succeeds.

## Architecture

- **Cloudflare Worker** — HTTP/WebSocket entrypoint.
- **Durable Object (`RoomDO`)** — isolates each room by room code and keeps at most two signaling peers connected.
- **WebSocket signaling** — exchanges WebRTC SDP offers, answers and ICE candidates.
- **Host / guest roles** — one host and one guest per room.
- **Gameplay isolation** — non-signaling traffic is rejected by the Worker.

## Project structure

```text
src/
├── index.ts
├── room-do.ts
└── types.ts
wrangler.jsonc
tsconfig.json
package.json
```

## Development

```bash
npm install
npm run typecheck
npm run dev
```

Health endpoint:

```text
GET /health
```

Expected response:

```json
{"status":"ok","service":"blackjack-signaling"}
```

## Cloudflare deployment

The Worker is configured through the root `wrangler.jsonc`.

For Cloudflare Git integration:

- **Root directory:** repository root
- **Build command:** `npm run typecheck`
- **Deploy command:** `npx wrangler deploy`

The `RoomDO` Durable Object uses SQLite-backed storage and is provisioned from the Wrangler configuration.

After deployment, configure the Blackjack frontend with the Worker WebSocket URL:

```text
VITE_SIGNALING_URL=wss://blackjack-signaling.<your-subdomain>.workers.dev
```

## Security boundary

The signaling service accepts only signaling messages required to establish WebRTC. It validates room identifiers, limits rooms to two peers, validates signaling message shape and role direction, and does not relay Blackjack gameplay state.

## License

Apache License 2.0.
