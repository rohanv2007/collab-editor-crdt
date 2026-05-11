const HEAD_KEY = "__HEAD__";

function cloneId(id) {
  if (!id) return null;
  return {
    sessionId: String(id.sessionId),
    clock: Number(id.clock),
  };
}

function cloneNode(node) {
  return {
    id: cloneId(node.id),
    value: String(node.value),
    deleted: Boolean(node.deleted),
    after: cloneId(node.after),
  };
}

function idKey(id) {
  return id ? `${id.sessionId}:${id.clock}` : HEAD_KEY;
}

function idsEqual(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.sessionId === right.sessionId && Number(left.clock) === Number(right.clock);
}

function compareIds(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  const sessionCompare = String(left.sessionId).localeCompare(String(right.sessionId));
  if (sessionCompare !== 0) return sessionCompare;
  return Number(left.clock) - Number(right.clock);
}

class ServerCRDT {
  constructor(sessionId = "server") {
    this.sessionId = sessionId;
    this.clock = 0;
    this.nodes = [];
    this.pendingInserts = new Map();
  }

  integrateInsert(incomingNode) {
    if (!incomingNode || !incomingNode.id) return false;

    const node = cloneNode(incomingNode);
    const existing = this.getNodeById(node.id);
    if (existing) {
      const changed = node.deleted && !existing.deleted;
      existing.deleted = existing.deleted || node.deleted;
      return changed;
    }

    if (node.after && !this.getNodeById(node.after)) {
      this.queuePendingInsert(node);
      return false;
    }

    this.nodes.push(node);
    this.linearize();
    this.drainPendingInserts();
    return true;
  }

  integrateDelete(nodeId) {
    const id = nodeId?.id ? nodeId.id : nodeId;
    const node = this.getNodeById(id);
    if (!node || node.deleted) return false;
    node.deleted = true;
    return true;
  }

  applyOp(op) {
    if (!op || !op.kind) return false;
    if (op.kind === "insert") return this.integrateInsert(op.node);
    if (op.kind === "delete") return this.integrateDelete(op.nodeId || op.id || op.node?.id);
    return false;
  }

  getVisibleText() {
    return this.nodes
      .filter((node) => !node.deleted)
      .map((node) => node.value)
      .join("");
  }

  getNodeById(nodeId) {
    if (!nodeId) return null;
    return this.nodes.find((node) => idsEqual(node.id, nodeId)) || null;
  }

  toJSON() {
    return this.nodes.map(cloneNode);
  }

  fromJSON(data) {
    const nodes = Array.isArray(data) ? data : [];
    this.nodes = nodes.filter((node) => node && node.id).map(cloneNode);
    this.pendingInserts.clear();
    this.linearize();
  }

  queuePendingInsert(node) {
    const key = idKey(node.after);
    const pending = this.pendingInserts.get(key) || [];
    if (!pending.some((queued) => idsEqual(queued.id, node.id))) {
      pending.push(node);
      this.pendingInserts.set(key, pending);
    }
  }

  drainPendingInserts() {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [afterKey, pending] of [...this.pendingInserts.entries()]) {
        if (afterKey !== HEAD_KEY && !this.nodes.some((node) => idKey(node.id) === afterKey)) {
          continue;
        }

        this.pendingInserts.delete(afterKey);
        for (const node of pending) {
          if (!this.getNodeById(node.id)) {
            this.nodes.push(node);
            moved = true;
          }
        }
      }
      if (moved) this.linearize();
    }
  }

  linearize() {
    const children = new Map();
    const byId = new Map();

    for (const node of this.nodes) {
      byId.set(idKey(node.id), node);
    }

    for (const node of this.nodes) {
      const parentKey = node.after && byId.has(idKey(node.after)) ? idKey(node.after) : HEAD_KEY;
      const siblings = children.get(parentKey) || [];
      siblings.push(node);
      children.set(parentKey, siblings);
    }

    for (const siblings of children.values()) {
      siblings.sort((left, right) => compareIds(left.id, right.id));
    }

    const ordered = [];
    const visited = new Set();

    const visit = (parentKey) => {
      const siblings = children.get(parentKey) || [];
      for (const node of siblings) {
        const key = idKey(node.id);
        if (visited.has(key)) continue;
        visited.add(key);
        ordered.push(node);
        visit(key);
      }
    };

    visit(HEAD_KEY);

    if (ordered.length !== this.nodes.length) {
      const remainder = this.nodes
        .filter((node) => !visited.has(idKey(node.id)))
        .sort((left, right) => compareIds(left.id, right.id));
      ordered.push(...remainder);
    }

    this.nodes = ordered;
  }
}

module.exports = {
  ServerCRDT,
  idKey,
  idsEqual,
  compareIds,
};
