export class EditorController {
  constructor({ crdt, renderer, network, cursorManager }) {
    this.crdt = crdt;
    this.renderer = renderer;
    this.network = network;
    this.cursorManager = cursorManager;
    this.caretIndex = 0;
    this.undoStack = [];
    this.redoStack = [];

    this.bindEvents();
    this.renderer.restoreCaret(0, { focus: false });
  }

  bindEvents() {
    const editor = this.renderer.editorEl;

    editor.addEventListener("keydown", (event) => this.handleKeyDown(event));
    editor.addEventListener("beforeinput", (event) => event.preventDefault());
    editor.addEventListener("input", (event) => event.preventDefault());
    editor.addEventListener("paste", (event) => this.handlePaste(event));
    editor.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const index = this.renderer.getIndexFromPoint(event.clientX, event.clientY);
      this.setCaret(index);
    });
  }

  handleKeyDown(event) {
    const key = event.key;
    const control = event.ctrlKey || event.metaKey;

    if (control && key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }

    if (control || event.altKey) return;

    if (key === "Backspace") {
      event.preventDefault();
      this.backspace();
      return;
    }

    if (key === "Delete") {
      event.preventDefault();
      this.deleteForward();
      return;
    }

    if (key === "Enter") {
      event.preventDefault();
      this.insertText("\n");
      return;
    }

    if (key === "Tab") {
      event.preventDefault();
      this.insertText("  ");
      return;
    }

    if (key === "ArrowLeft") {
      event.preventDefault();
      this.setCaret(this.caretIndex - 1);
      return;
    }

    if (key === "ArrowRight") {
      event.preventDefault();
      this.setCaret(this.caretIndex + 1);
      return;
    }

    if (key === "ArrowUp") {
      event.preventDefault();
      this.setCaret(this.renderer.moveVertical(-1));
      return;
    }

    if (key === "ArrowDown") {
      event.preventDefault();
      this.setCaret(this.renderer.moveVertical(1));
      return;
    }

    if (key === "Home") {
      event.preventDefault();
      const { lineNumber } = this.renderer.getLineColumnForIndex(this.caretIndex);
      this.setCaret(this.renderer.indexFromLineColumn(lineNumber, 0));
      return;
    }

    if (key === "End") {
      event.preventDefault();
      const { lineNumber } = this.renderer.getLineColumnForIndex(this.caretIndex);
      const line = this.renderer.lines[lineNumber];
      this.setCaret(this.renderer.indexFromLineColumn(lineNumber, line?.nodes.length || 0));
      return;
    }

    if (key.length === 1) {
      event.preventDefault();
      this.insertText(key);
    }
  }

  handlePaste(event) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text) this.insertText(text.replace(/\r\n/g, "\n"));
  }

  insertText(text) {
    for (const char of Array.from(text)) {
      const index = this.caretIndex;
      const node = this.crdt.localInsert(index, char);
      this.renderer.applyOp(node);
      this.network.sendOp({ kind: "insert", node });
      this.undoStack.push({ kind: "insert", node, index });
      this.redoStack = [];
      this.setCaret(index + 1, { skipRender: true });
    }
  }

  backspace() {
    if (this.caretIndex <= 0) return;
    this.deleteAt(this.caretIndex - 1, true);
  }

  deleteForward() {
    if (this.caretIndex >= this.crdt.getVisibleLength()) return;
    this.deleteAt(this.caretIndex, false);
  }

  deleteAt(index, moveBack) {
    const node = this.crdt.getNodeAtVisibleIndex(index);
    if (!node) return;

    const snapshot = {
      id: { ...node.id },
      value: node.value,
      deleted: node.deleted,
      after: node.after ? { ...node.after } : null,
    };
    const nodeId = this.crdt.localDelete(index);
    if (!nodeId) return;

    this.renderer.applyDelete(nodeId);
    this.network.sendOp({ kind: "delete", nodeId });
    this.undoStack.push({ kind: "delete", node: snapshot, index });
    this.redoStack = [];
    this.setCaret(moveBack ? index : this.caretIndex, { skipRender: true });
  }

  undo() {
    const action = this.undoStack.pop();
    if (!action) return;

    if (action.kind === "insert") {
      const visibleIndex = this.crdt.getVisibleIndexOfId(action.node.id);
      const nodeId = this.crdt.localDeleteById(action.node.id);
      if (!nodeId) return;

      this.renderer.applyDelete(nodeId);
      this.network.sendOp({ kind: "delete", nodeId });
      this.redoStack.push({ kind: "insert", value: action.node.value, index: Math.max(0, visibleIndex) });
      this.setCaret(Math.max(0, visibleIndex), { skipRender: true });
      return;
    }

    if (action.kind === "delete") {
      const insertIndex = Math.min(action.index, this.crdt.getVisibleLength());
      const node = this.crdt.localInsert(insertIndex, action.node.value);
      this.renderer.applyOp(node);
      this.network.sendOp({ kind: "insert", node });
      this.redoStack.push({ kind: "delete", node, index: insertIndex });
      this.setCaret(insertIndex + 1, { skipRender: true });
    }
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) return;

    if (action.kind === "insert") {
      const insertIndex = Math.min(action.index, this.crdt.getVisibleLength());
      const node = this.crdt.localInsert(insertIndex, action.value);
      this.renderer.applyOp(node);
      this.network.sendOp({ kind: "insert", node });
      this.undoStack.push({ kind: "insert", node, index: insertIndex });
      this.setCaret(insertIndex + 1, { skipRender: true });
      return;
    }

    if (action.kind === "delete") {
      const visibleIndex = this.crdt.getVisibleIndexOfId(action.node.id);
      const nodeId = this.crdt.localDeleteById(action.node.id);
      if (!nodeId) return;

      this.renderer.applyDelete(nodeId);
      this.network.sendOp({ kind: "delete", nodeId });
      this.undoStack.push({ kind: "delete", node: action.node, index: Math.max(0, visibleIndex) });
      this.setCaret(Math.max(0, visibleIndex), { skipRender: true });
    }
  }

  handleRemoteInsert(node) {
    const visibleIndex = this.crdt.getVisibleIndexOfId(node.id);
    if (visibleIndex !== -1 && visibleIndex <= this.caretIndex) {
      this.caretIndex += 1;
    }
    this.clampCaret();
  }

  handleRemoteDelete(previousVisibleIndex) {
    if (previousVisibleIndex !== -1 && previousVisibleIndex < this.caretIndex) {
      this.caretIndex -= 1;
    }
    this.clampCaret();
  }

  clampCaret() {
    this.setCaret(this.caretIndex);
  }

  setCaret(index, options = {}) {
    this.caretIndex = this.renderer.clampIndex(index);
    this.renderer.restoreCaret(this.caretIndex, { focus: options.focus });
    this.cursorManager?.notifyLocalSelection();
  }
}
