export class CursorManager {
  constructor({ sessionId, renderer, layerEl, network }) {
    this.sessionId = sessionId;
    this.renderer = renderer;
    this.layerEl = layerEl;
    this.network = network;
    this.remoteCursors = new Map();
    this.peers = [];
    this.lastSentAt = 0;
    this.pendingSendTimer = null;

    document.addEventListener("selectionchange", () => this.notifyLocalSelection());
    this.renderer.onViewportChange(() => this.renderAll());
  }

  setNetwork(network) {
    this.network = network;
  }

  setPeers(peers) {
    this.peers = [...new Set(peers)].sort();
    for (const sessionId of this.peers) {
      if (sessionId !== this.sessionId) this.ensureCursor(sessionId);
    }
    for (const sessionId of [...this.remoteCursors.keys()]) {
      if (!this.peers.includes(sessionId)) this.removeRemote(sessionId);
    }
    this.renderAll();
  }

  updateRemote(sessionId, position) {
    if (!sessionId || sessionId === this.sessionId) return;
    const cursor = this.ensureCursor(sessionId);
    cursor.position = position;
    cursor.element.classList.remove("is-stale");
    this.renderCursor(sessionId);

    clearTimeout(cursor.fadeTimer);
    cursor.fadeTimer = window.setTimeout(() => {
      cursor.element.classList.add("is-stale");
    }, 5000);
  }

  removeRemote(sessionId) {
    const cursor = this.remoteCursors.get(sessionId);
    if (!cursor) return;
    clearTimeout(cursor.fadeTimer);
    cursor.element.remove();
    this.remoteCursors.delete(sessionId);
  }

  notifyLocalSelection() {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    if (elapsed >= 50) {
      this.sendLocalCursor();
      return;
    }

    clearTimeout(this.pendingSendTimer);
    this.pendingSendTimer = window.setTimeout(() => this.sendLocalCursor(), 50 - elapsed);
  }

  sendLocalCursor() {
    this.lastSentAt = Date.now();
    this.network?.sendCursor(this.renderer.getCaretIndex());
  }

  renderAll() {
    for (const sessionId of this.remoteCursors.keys()) {
      this.renderCursor(sessionId);
    }
  }

  renderCursor(sessionId) {
    const cursor = this.remoteCursors.get(sessionId);
    if (!cursor) return;

    const coordinates = this.renderer.getCaretCoordinates(cursor.position);
    if (!coordinates) {
      cursor.element.style.display = "none";
      return;
    }

    cursor.element.style.display = "block";
    cursor.element.style.transform = `translate(${coordinates.left}px, ${coordinates.top}px)`;
    cursor.element.style.height = `${coordinates.height}px`;
  }

  ensureCursor(sessionId) {
    if (this.remoteCursors.has(sessionId)) return this.remoteCursors.get(sessionId);

    const element = document.createElement("span");
    element.className = "remote-cursor";
    element.style.setProperty("--cursor-color", CursorManager.colorFor(sessionId));

    const label = document.createElement("span");
    label.className = "remote-cursor-label";
    label.textContent = this.labelFor(sessionId);
    element.appendChild(label);

    this.layerEl.appendChild(element);

    const cursor = {
      element,
      label,
      position: 0,
      fadeTimer: null,
    };
    this.remoteCursors.set(sessionId, cursor);
    return cursor;
  }

  labelFor(sessionId) {
    const sorted = [...new Set([...this.peers, sessionId])].sort();
    const index = sorted.filter((peer) => peer !== this.sessionId).indexOf(sessionId);
    return `User #${index + 1}`;
  }

  static colorFor(sessionId) {
    let hash = 0;
    for (let index = 0; index < sessionId.length; index += 1) {
      hash = (hash * 31 + sessionId.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 72% 58%)`;
  }
}
