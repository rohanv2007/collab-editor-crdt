import { RGA } from "./crdt.js";
import { Renderer } from "./renderer.js";
import { Network } from "./network.js";
import { EditorController } from "./editor.js";
import { CursorManager } from "./cursor.js";

function nanoid(size = 10) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function getRoomId() {
  const url = new URL(window.location.href);
  let roomId = url.searchParams.get("room");
  if (!roomId) {
    roomId = nanoid(10);
    url.searchParams.set("room", roomId);
    window.history.replaceState({}, "", url);
  }
  return roomId;
}

function getSessionId() {
  const key = "collab-editor-session";
  let sessionId = window.sessionStorage.getItem(key);
  if (!sessionId) {
    sessionId = crypto.randomUUID ? crypto.randomUUID() : nanoid(24);
    window.sessionStorage.setItem(key, sessionId);
  }
  return sessionId;
}

function getWebSocketUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("ws") || window.COLLAB_WS_URL || null;
}

function cloneNode(node) {
  return {
    id: node.id ? { ...node.id } : null,
    value: node.value,
    deleted: Boolean(node.deleted),
    after: node.after ? { ...node.after } : null,
  };
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    // Fall through to the selection-based copy path for non-secure LAN origins.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.className = "clipboard-fallback";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  return copied;
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

async function buildShareUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);

  if (!isLocalHost(url.hostname)) return url.toString();

  try {
    const host = window.location.hostname.includes(":") ? `[${window.location.hostname}]` : window.location.hostname;
    const response = await fetch(`${window.location.protocol}//${host}:4000/info`);
    const info = await response.json();
    const address = info.addresses?.find((entry) => entry.address && !entry.name.match(/virtual|vmware|loopback/i));
    if (address?.address) {
      url.hostname = address.address;
    }
  } catch (error) {
    // If LAN discovery is blocked, keep the current URL.
  }

  return url.toString();
}

const roomId = getRoomId();
const sessionId = getSessionId();
const peers = new Set([sessionId]);

const roomIdEl = document.querySelector("#room-id");
const shareButton = document.querySelector("#share-button");
const peerCountEl = document.querySelector("#peer-count");
const peerDotsEl = document.querySelector("#peer-dots");
const peerListEl = document.querySelector("#peer-list");
const statusDotEl = document.querySelector("#status-dot");
const statusTextEl = document.querySelector("#status-text");
const editorEl = document.querySelector("#editor");

roomIdEl.textContent = roomId;

const crdt = new RGA(sessionId);
const renderer = new Renderer({
  editorEl,
  scrollEl: document.querySelector("#editor-scroll"),
  canvasEl: document.querySelector("#editor-canvas"),
  linesEl: document.querySelector("#editor-lines"),
  remoteCursorLayer: document.querySelector("#remote-cursor-layer"),
  localCaretEl: document.querySelector("#local-caret"),
});
renderer.setCRDT(crdt);
renderer.fullRender();

let cursorManager;
let editor;

const network = new Network({
  roomId,
  sessionId,
  wsUrl: getWebSocketUrl(),
});

cursorManager = new CursorManager({
  sessionId,
  renderer,
  layerEl: document.querySelector("#remote-cursor-layer"),
  network,
});

editor = new EditorController({
  crdt,
  renderer,
  network,
  cursorManager,
});

function setPeers(nextPeers) {
  peers.clear();
  peers.add(sessionId);
  for (const peer of nextPeers) peers.add(peer);
  cursorManager.setPeers([...peers]);
  renderPeers();
}

function addPeer(peer) {
  peers.add(peer);
  cursorManager.setPeers([...peers]);
  renderPeers();
}

function removePeer(peer) {
  if (peer !== sessionId) peers.delete(peer);
  cursorManager.setPeers([...peers]);
  renderPeers();
}

function renderPeers() {
  const sorted = [...peers].sort();
  peerCountEl.textContent = String(sorted.length);

  peerDotsEl.replaceChildren(
    ...sorted.map((peer) => {
      const dot = document.createElement("span");
      dot.className = "peer-dot";
      dot.title = peer === sessionId ? "You" : cursorManager.labelFor(peer);
      dot.style.background = CursorManager.colorFor(peer);
      return dot;
    }),
  );

  peerListEl.replaceChildren(
    ...sorted.map((peer) => {
      const item = document.createElement("span");
      item.className = "peer-list-item";

      const dot = document.createElement("span");
      dot.className = "peer-dot";
      dot.style.background = CursorManager.colorFor(peer);

      const label = document.createElement("span");
      label.textContent = peer === sessionId ? "You" : cursorManager.labelFor(peer);

      item.append(dot, label);
      return item;
    }),
  );
}

function setStatus(status) {
  const label =
    status === "connected"
      ? "Connected"
      : status === "offline"
        ? "Offline"
        : status === "connecting"
          ? "Connecting..."
          : "Reconnecting...";

  statusTextEl.textContent = label;
  statusDotEl.className = `status-dot is-${status}`;
}

function applyLocalReplay(ops) {
  for (const op of ops) {
    if (op.kind === "insert" && op.node) {
      crdt.integrateInsert(cloneNode(op.node));
    } else if (op.kind === "delete") {
      crdt.integrateDelete(op.nodeId || op.id || op.node?.id);
    }
  }
}

network.setHandlers({
  onInit(state, nextPeers, localOps) {
    crdt.fromJSON(state);
    applyLocalReplay(localOps);
    renderer.fullRender();
    editor.clampCaret();
    setPeers(nextPeers);
  },

  onRemoteOp(op, from) {
    if (!op || from === sessionId) return;

    if (op.kind === "insert" && op.node) {
      crdt.integrateInsert(op.node);
      renderer.applyOp(op.node);
      editor.handleRemoteInsert(op.node);
      return;
    }

    if (op.kind === "delete") {
      const nodeId = op.nodeId || op.id || op.node?.id;
      const previousIndex = crdt.getVisibleIndexOfId(nodeId);
      crdt.integrateDelete(nodeId);
      renderer.applyDelete(nodeId);
      editor.handleRemoteDelete(previousIndex);
    }
  },

  onCursor(peer, position) {
    cursorManager.updateRemote(peer, position);
  },

  onPeerJoin(peer) {
    addPeer(peer);
  },

  onPeerLeave(peer) {
    removePeer(peer);
  },

  onStatus(status) {
    setStatus(status);
  },
});

shareButton.addEventListener("click", async () => {
  const url = await buildShareUrl();
  const copied = await copyText(url);
  shareButton.textContent = copied ? "Copied" : "Copy failed";
  window.setTimeout(() => {
    shareButton.textContent = "Share";
  }, 1200);
});

window.addEventListener("online", () => network.requestResync());
window.addEventListener("offline", () => setStatus("offline"));

renderPeers();
setStatus("connecting");
network.connect();
