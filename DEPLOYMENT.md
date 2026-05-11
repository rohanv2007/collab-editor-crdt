# Deployment Notes

## Vercel

This repository can deploy the static client to Vercel. `vercel.json` rewrites `/`, `/src/*`, and `/styles/*` to the files inside `client/`.

The collaborative editor needs a persistent WebSocket server for concurrent users. Vercel Functions do not support acting as a WebSocket server, so deploy `server/index.js` on a WebSocket-capable host and configure the client with either:

```text
?ws=wss://your-collab-server.example.com
```

or by setting `window.COLLAB_WS_URL` before `client/src/main.js` loads.

## Local Production-Like Run

```bash
npm install
npm run server
npx serve client -p 3000
```

Then open:

```text
http://localhost:3000/?room=my-room
```

For LAN sharing:

```text
http://YOUR_LAN_IP:3000/?room=my-room
```

Make sure ports `3000` and `4000` are reachable.
