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

export function idKey(id) {
  return id ? `${id.sessionId}:${id.clock}` : HEAD_KEY;
}

export function idsEqual(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.sessionId === right.sessionId && Number(left.clock) === Number(right.clock);
}

export function compareIds(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  const sessionCompare = String(left.sessionId).localeCompare(String(right.sessionId));
  if (sessionCompare !== 0) return sessionCompare;
  return Number(left.clock) - Number(right.clock);
}

export class RGA {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.clock = 0;
    this.nodes = [];
    this.pendingInserts = new Map();
  }

  localInsert(index, char) {
    const visibleIndex = this.clampVisibleIndex(index);
    const afterNode = visibleIndex > 0 ? this.getNodeAtVisibleIndex(visibleIndex - 1) : null;

    this.clock += 1;
    const node = {
      id: { sessionId: this.sessionId, clock: this.clock },
      value: char,
      deleted: false,
      after: afterNode ? cloneId(afterNode.id) : null,
    };

    this.integrateInsert(node);
    return cloneNode(node);
  }

  localDelete(index) {
    const node = this.getNodeAtVisibleIndex(index);
    if (!node) return null;
    node.deleted = true;
    return cloneId(node.id);
  }

  localDeleteById(nodeId) {
    const node = this.getNodeById(nodeId);
    if (!node || node.deleted) return null;
    node.deleted = true;
    return cloneId(node.id);
  }

  integrateInsert(incomingNode) {
    if (!incomingNode || !incomingNode.id) return null;

    const node = cloneNode(incomingNode);
    this.clock = Math.max(this.clock, this.sessionClock(node.id));

    const existing = this.getNodeById(node.id);
    if (existing) {
      existing.deleted = existing.deleted || node.deleted;
      return null;
    }

    if (node.after && !this.getNodeById(node.after)) {
      this.queuePendingInsert(node);
      return null;
    }

    this.nodes.push(node);
    this.linearize();
    this.drainPendingInserts();
    return cloneNode(node);
  }

  integrateDelete(nodeId) {
    const id = nodeId?.id ? nodeId.id : nodeId;
    const node = this.getNodeById(id);
    if (!node || node.deleted) return false;
    node.deleted = true;
    return true;
  }

  getVisibleText() {
    return this.nodes
      .filter((node) => !node.deleted)
      .map((node) => node.value)
      .join("");
  }

  getVisibleNodes() {
    return this.nodes.filter((node) => !node.deleted);
  }

  getVisibleLength() {
    return this.getVisibleNodes().length;
  }

  getVisibleIndex(arrayIndex) {
    let visible = 0;
    const end = Math.max(0, Math.min(arrayIndex, this.nodes.length));
    for (let index = 0; index < end; index += 1) {
      if (!this.nodes[index].deleted) visible += 1;
    }
    return visible;
  }

  getRawIndex(visibleIndex) {
    if (visibleIndex <= 0) return 0;

    let visible = 0;
    for (let index = 0; index < this.nodes.length; index += 1) {
      if (this.nodes[index].deleted) continue;
      if (visible === visibleIndex) return index;
      visible += 1;
    }

    return this.nodes.length;
  }

  getVisibleIndexOfId(nodeId) {
    let visible = 0;
    for (const node of this.nodes) {
      if (idsEqual(node.id, nodeId)) return node.deleted ? visible : visible;
      if (!node.deleted) visible += 1;
    }
    return -1;
  }

  getNodeAtVisibleIndex(visibleIndex) {
    if (visibleIndex < 0) return null;

    let visible = 0;
    for (const node of this.nodes) {
      if (node.deleted) continue;
      if (visible === visibleIndex) return node;
      visible += 1;
    }

    return null;
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
    this.clock = this.nodes.reduce((clock, node) => {
      return Math.max(clock, this.sessionClock(node.id));
    }, this.clock);
    this.linearize();
  }

  clampVisibleIndex(index) {
    const length = this.getVisibleLength();
    if (!Number.isFinite(index)) return length;
    return Math.max(0, Math.min(index, length));
  }

  sessionClock(id) {
    return id?.sessionId === this.sessionId ? Number(id.clock) : 0;
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
