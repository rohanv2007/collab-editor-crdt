const { ServerCRDT } = require("./crdt-server");
const logger = require("./utils/logger");

const OPEN = 1;

class RoomManager {
  constructor({ cleanupMs = 5 * 60 * 1000 } = {}) {
    this.rooms = new Map();
    this.cleanupMs = cleanupMs;
  }

  ensureRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        clients: new Set(),
        crdt: new ServerCRDT(`server:${roomId}`),
        history: [],
        cleanupTimer: null,
      });
    }

    const room = this.rooms.get(roomId);
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
    return room;
  }

  addClient(roomId, ws, sessionId) {
    const room = this.ensureRoom(roomId);
    const wasPresent = this.getPeers(room).includes(sessionId);

    ws.roomId = roomId;
    ws.sessionId = sessionId;
    room.clients.add(ws);

    return { room, isNewSession: !wasPresent };
  }

  removeClient(ws) {
    const { roomId, sessionId } = ws;
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.clients.delete(ws);
    const stillPresent = [...room.clients].some((client) => client.sessionId === sessionId);

    if (room.clients.size === 0) {
      room.cleanupTimer = setTimeout(() => {
        const current = this.rooms.get(roomId);
        if (current && current.clients.size === 0) {
          this.rooms.delete(roomId);
          logger.info("Cleaned up empty room", { roomId });
        }
      }, this.cleanupMs);
    }

    return { room, shouldBroadcastLeave: !stillPresent && room.clients.size > 0 };
  }

  sendInit(ws) {
    const room = this.rooms.get(ws.roomId);
    if (!room) return;
    this.send(ws, {
      type: "init",
      state: room.crdt.toJSON(),
      peers: this.getPeers(room),
    });
  }

  handleOp(ws, op) {
    const room = this.rooms.get(ws.roomId);
    if (!room) return false;

    const applied = room.crdt.applyOp(op);
    if (!applied) return false;

    room.history.push({
      op,
      from: ws.sessionId,
      at: Date.now(),
    });

    this.broadcast(
      room,
      {
        type: "op",
        op,
        from: ws.sessionId,
      },
      { except: ws },
    );
    return true;
  }

  broadcastCursor(ws, position) {
    const room = this.rooms.get(ws.roomId);
    if (!room) return;
    this.broadcast(
      room,
      {
        type: "cursor",
        sessionId: ws.sessionId,
        position,
      },
      { except: ws },
    );
  }

  broadcastPeerJoin(room, ws) {
    this.broadcast(
      room,
      {
        type: "peer-join",
        sessionId: ws.sessionId,
      },
      { except: ws },
    );
  }

  broadcastPeerLeave(room, sessionId) {
    this.broadcast(room, {
      type: "peer-leave",
      sessionId,
    });
  }

  broadcast(room, message, options = {}) {
    for (const client of room.clients) {
      if (options.except && client === options.except) continue;
      this.send(client, message);
    }
  }

  send(ws, message) {
    if (ws.readyState !== OPEN) return;
    ws.send(JSON.stringify(message));
  }

  getPeers(room) {
    return [...new Set([...room.clients].map((client) => client.sessionId))].sort();
  }
}

module.exports = RoomManager;
