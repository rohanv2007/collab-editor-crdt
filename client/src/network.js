export class Network {
  constructor({ roomId, sessionId, wsUrl = null, handlers = {} }) {
    this.roomId = roomId;
    this.sessionId = sessionId;
    this.wsUrl = wsUrl;
    this.handlers = handlers;
    this.ws = null;
    this.backoffMs = 1000;
    this.maxBackoffMs = 30000;
    this.messageQueue = [];
    this.sentOps = [];
    this.hasInit = false;
    this.closedByUser = false;
    this.lastPongAt = 0;
    this.heartbeatTimer = null;
  }

  setHandlers(handlers) {
    this.handlers = handlers;
  }

  connect() {
    this.closedByUser = false;
    this.setStatus(this.backoffMs === 1000 ? "connecting" : "reconnecting");

    const url = this.buildUrl();
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this.hasInit = false;
      this.lastPongAt = Date.now();
      this.backoffMs = 1000;
      this.startHeartbeat();
      this.sendRaw({ type: "resync" });
    });

    this.ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    this.ws.addEventListener("close", () => {
      this.hasInit = false;
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      this.setStatus("offline");
    });
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }

  sendOp(op) {
    this.sentOps.push({ op, timestamp: Date.now() });
    if (this.sentOps.length > 5000) this.sentOps.splice(0, this.sentOps.length - 5000);
    this.sendOrQueue({ type: "op", op });
  }

  sendCursor(position) {
    if (!this.isOpen() || !this.hasInit) return;
    this.sendRaw({ type: "cursor", sessionId: this.sessionId, position });
  }

  requestResync() {
    this.sendOrQueue({ type: "resync" });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }

    if (message.type === "init") {
      this.hasInit = true;
      this.setStatus("connected");
      this.handlers.onInit?.(
        message.state || [],
        message.peers || [],
        this.sentOps.map((entry) => entry.op),
      );
      this.replaySentOps();
      this.flushQueue();
      return;
    }

    if (message.type === "op") {
      this.handlers.onRemoteOp?.(message.op, message.from);
      return;
    }

    if (message.type === "cursor") {
      this.handlers.onCursor?.(message.sessionId, Number(message.position || 0));
      return;
    }

    if (message.type === "peer-join") {
      this.handlers.onPeerJoin?.(message.sessionId);
      return;
    }

    if (message.type === "peer-leave") {
      this.handlers.onPeerLeave?.(message.sessionId);
      return;
    }

    if (message.type === "pong") {
      this.lastPongAt = Date.now();
    }
  }

  sendOrQueue(message) {
    if (this.isOpen() && (this.hasInit || message.type === "ping" || message.type === "resync")) {
      this.sendRaw(message);
      return;
    }
    this.messageQueue.push(message);
  }

  sendRaw(message) {
    if (!this.isOpen()) {
      this.messageQueue.push(message);
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  flushQueue() {
    const queued = this.messageQueue;
    this.messageQueue = [];

    for (const message of queued) {
      if (message.type === "op") continue;
      this.sendRaw(message);
    }
  }

  replaySentOps() {
    for (const { op } of this.sentOps) {
      this.sendRaw({ type: "op", op });
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (!this.isOpen()) return;

      if (Date.now() - this.lastPongAt > 30000) {
        this.ws.close();
        return;
      }

      this.sendRaw({ type: "ping" });
    }, 20000);
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    window.setTimeout(() => this.connect(), delay);
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setStatus(status) {
    this.handlers.onStatus?.(status);
  }

  buildUrl() {
    if (this.wsUrl) {
      const url = new URL(this.wsUrl);
      url.searchParams.set("roomId", this.roomId);
      url.searchParams.set("sessionId", this.sessionId);
      return url.toString();
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname || "localhost";
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    const devStaticPort = window.location.port === "3000";
    const port = local || devStaticPort ? ":4000" : window.location.port ? `:${window.location.port}` : "";
    return `${protocol}://${host}${port}?roomId=${encodeURIComponent(this.roomId)}&sessionId=${encodeURIComponent(this.sessionId)}`;
  }
}
