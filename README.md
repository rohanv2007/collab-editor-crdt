# Real-Time Collaborative Code Editor

Vanilla JavaScript MVP of a collaborative code editor backed by a from-scratch RGA (Replicated Growable Array) CRDT. It uses raw WebSockets through `ws`; there is no Yjs, Automerge, ShareDB, Socket.io, React, Vue, Svelte, or CSS framework.

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app creates a room id in the URL. Use the Share button or open the same `?room=...` URL in another browser tab to collaborate.

The WebSocket server listens on port `4000`; the static client runs on port `3000`.

## How Another Person Joins

For another person on the same Wi-Fi or LAN, send them a URL using your computer's LAN IP address, not `localhost`.

Example:

```text
http://192.168.1.103:3000/?room=YOUR_ROOM_ID
```

They should open that URL in their browser while your server is running. The client will connect its WebSocket to the same host on port `4000`, so both ports `3000` and `4000` must be reachable through your firewall. If the Share button is clicked from a `localhost` page, it tries to copy a LAN-IP URL automatically.

For someone outside your network, use a tunnel or deploy the app. You need to expose both the client port (`3000`) and WebSocket port (`4000`), or put them behind one hosted reverse proxy.

## Architecture

- `client/src/crdt.js` implements the browser RGA.
- `server/crdt-server.js` implements the same deterministic RGA logic for server authority and late join state.
- `server/room-manager.js` stores `roomId -> { clients, crdt, history }`, sends initial state, broadcasts ops and cursors, and cleans empty rooms after five minutes.
- `client/src/network.js` owns reconnects, ping/pong heartbeat, queued messages, and resync.
- `client/src/renderer.js` renders a manual DOM editor with line numbers, per-character spans, line virtualization after 500 lines, caret mapping, and JavaScript token colors.
- `client/src/editor.js` intercepts keyboard and paste input and turns each edit into CRDT operations.
- `client/src/cursor.js` renders deterministic-color remote carets with labels and fade-out.

## How RGA Convergence Works

Every character is a node:

```js
{
  id: { sessionId, clock },
  value: "x",
  deleted: false,
  after: { sessionId, clock }
}
```

The `id` is unique because each client owns a `sessionId` and increments a Lamport-style clock for local inserts. Deletes never remove nodes from the array; they only mark nodes as tombstones.

For inserts, the node records the visible character that was immediately to its left at creation time in `after`. If two users insert at the same location at the same time, both new nodes point to the same `after`. All replicas sort those sibling nodes by `sessionId`, then by `clock`, so they choose the same order even if operations arrive in different orders.

Internally, the implementation treats `after` references as a small tree rooted at the document head. Children of the same parent are sorted deterministically, then the tree is flattened depth-first into the document array. Because every client and the server use the same ordering rule, the same set of operations converges to the same text.

## Reconnect Behavior

The client reconnects with exponential backoff from 1s up to 30s. On reconnect it requests a full state resync, reapplies its local sent operations idempotently, and resends them to the server. Duplicate inserts and deletes are ignored by node id, which makes replay safe.

## Known Limitations

- Selections are collapsed to a caret; range selection and multi-cursor editing are not implemented.
- Undo/redo is per-character and per-user. Undoing a delete creates a new CRDT node instead of resurrecting the tombstoned original node.
- Syntax highlighting is intentionally small and JavaScript-focused. It tokenizes per line and does not maintain multi-line parser state.
- The server keeps room state in memory only. Restarting the server clears documents.
- There is no authentication or persistence layer.
