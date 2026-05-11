const http = require("http");
const crypto = require("crypto");
const os = require("os");
const WebSocket = require("ws");
const RoomManager = require("./room-manager");
const logger = require("./utils/logger");

const PORT = Number(process.env.PORT || 4000);
const rooms = new RoomManager();

function localAddresses() {
  const interfaces = os.networkInterfaces();
  return Object.entries(interfaces)
    .flatMap(([name, addresses]) => {
      return (addresses || [])
        .filter((entry) => entry.family === "IPv4" && !entry.internal)
        .map((entry) => ({ name, address: entry.address }));
    })
    .sort((left, right) => {
      const leftVirtual = /virtual|vmware|loopback/i.test(left.name);
      const rightVirtual = /virtual|vmware|loopback/i.test(right.name);
      if (leftVirtual !== rightVirtual) return leftVirtual ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
}

const server = http.createServer((request, response) => {
  response.setHeader("access-control-allow-origin", "*");

  if (request.url === "/info") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ addresses: localAddresses() }));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("Collaborative editor WebSocket server is running.\n");
});

const wss = new WebSocket.Server({ server });

function parseConnectionUrl(request) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const roomId = url.searchParams.get("roomId") || "default-room";
  const sessionId = url.searchParams.get("sessionId") || crypto.randomUUID();
  return { roomId, sessionId };
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (error) {
    return null;
  }
}

wss.on("connection", (ws, request) => {
  const { roomId, sessionId } = parseConnectionUrl(request);
  const { room, isNewSession } = rooms.addClient(roomId, ws, sessionId);

  logger.info("Client connected", { roomId, sessionId, clients: room.clients.size });
  rooms.sendInit(ws);
  if (isNewSession) rooms.broadcastPeerJoin(room, ws);

  ws.on("message", (raw) => {
    const message = parseMessage(raw);
    if (!message || !message.type) {
      logger.warn("Ignored malformed message", { roomId, sessionId });
      return;
    }

    if (message.type === "op") {
      rooms.handleOp(ws, message.op);
      return;
    }

    if (message.type === "cursor") {
      rooms.broadcastCursor(ws, Number(message.position || 0));
      return;
    }

    if (message.type === "ping") {
      rooms.send(ws, { type: "pong" });
      return;
    }

    if (message.type === "resync") {
      rooms.sendInit(ws);
    }
  });

  ws.on("close", () => {
    const result = rooms.removeClient(ws);
    if (result?.shouldBroadcastLeave) {
      rooms.broadcastPeerLeave(result.room, sessionId);
    }
    logger.info("Client disconnected", { roomId, sessionId });
  });

  ws.on("error", (error) => {
    logger.warn("WebSocket error", { roomId, sessionId, error: error.message });
  });
});

server.listen(PORT, () => {
  logger.info(`WebSocket server listening on port ${PORT}`);
});
