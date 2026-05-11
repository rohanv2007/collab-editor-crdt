import { idKey } from "./crdt.js";

const LINE_HEIGHT = 22;
const VIRTUALIZE_AFTER_LINES = 500;
const VIEWPORT_BUFFER_LINES = 50;

const KEYWORD_PATTERN =
  /^(const|let|var|function|return|if|else|for|while|class|import|export|default|new|this|typeof|null|undefined|true|false)\b/;

const TOKEN_PATTERNS = [
  ["string", /^"([^"\\]|\\.)*"/],
  ["string", /^'([^'\\]|\\.)*'/],
  ["string", /^`([^`\\]|\\.)*`/],
  ["comment", /^\/\/.*$/],
  ["comment", /^\/\*[\s\S]*?\*\//],
  ["keyword", KEYWORD_PATTERN],
  ["number", /^\b\d+(\.\d+)?\b/],
  ["operator", /^[+\-*\/=<>!&|?:;,.{}()[\]]/],
  ["identifier", /^[A-Za-z_$][\w$]*/],
];

export function tokenizeLine(line) {
  const tokens = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    let match = null;

    for (const [type, pattern] of TOKEN_PATTERNS) {
      const result = rest.match(pattern);
      if (result?.[0]) {
        match = { type, value: result[0] };
        break;
      }
    }

    if (!match) {
      match = { type: "default", value: rest[0] };
    }

    tokens.push({
      type: match.type,
      start: index,
      end: index + match.value.length,
    });
    index += match.value.length;
  }

  return tokens;
}

function tokenTypeAt(tokens, offset) {
  const token = tokens.find((candidate) => offset >= candidate.start && offset < candidate.end);
  return token ? token.type : "default";
}

export class Renderer {
  constructor({ editorEl, scrollEl, canvasEl, linesEl, remoteCursorLayer, localCaretEl }) {
    this.editorEl = editorEl;
    this.scrollEl = scrollEl;
    this.canvasEl = canvasEl;
    this.linesEl = linesEl;
    this.remoteCursorLayer = remoteCursorLayer;
    this.localCaretEl = localCaretEl;
    this.crdt = null;
    this.lines = [];
    this.lineCache = new Map();
    this.caretIndex = 0;
    this.renderedRange = { start: 0, end: -1 };
    this.viewportCallbacks = new Set();

    this.scrollEl.addEventListener("scroll", () => {
      if (this.lines.length > VIRTUALIZE_AFTER_LINES) this.render();
      this.positionLocalCaret();
      this.notifyViewportChange();
    });
  }

  setCRDT(crdt) {
    this.crdt = crdt;
  }

  onViewportChange(callback) {
    this.viewportCallbacks.add(callback);
  }

  notifyViewportChange() {
    for (const callback of this.viewportCallbacks) callback();
  }

  fullRender() {
    this.lineCache.clear();
    this.render(true);
  }

  applyOp() {
    this.render();
  }

  applyDelete() {
    this.render();
  }

  render(force = false) {
    if (!this.crdt) return;

    this.lines = this.buildLines();
    const range = this.getRenderRange();
    this.renderedRange = range;

    const fragment = document.createDocumentFragment();
    const topSpacer = this.createSpacer(range.start * LINE_HEIGHT);
    const bottomSpacer = this.createSpacer((this.lines.length - range.end - 1) * LINE_HEIGHT);

    if (topSpacer) fragment.appendChild(topSpacer);

    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      const line = this.lines[lineNumber];
      const signature = this.lineSignature(line);
      const cached = this.lineCache.get(lineNumber);

      if (!force && cached?.signature === signature) {
        fragment.appendChild(cached.element);
        continue;
      }

      const element = this.createLineElement(line, lineNumber);
      this.lineCache.set(lineNumber, { signature, element });
      fragment.appendChild(element);
    }

    if (bottomSpacer) fragment.appendChild(bottomSpacer);

    this.linesEl.replaceChildren(fragment);
    const contentHeight = Math.max(this.lines.length * LINE_HEIGHT, this.scrollEl.clientHeight);
    this.canvasEl.style.minHeight = `${contentHeight}px`;
    this.remoteCursorLayer.style.height = `${contentHeight}px`;
    this.positionLocalCaret();
    this.notifyViewportChange();
  }

  buildLines() {
    const visibleNodes = this.crdt.getVisibleNodes();
    const lines = [];
    let currentNodes = [];
    let currentText = "";
    let lineStartIndex = 0;

    visibleNodes.forEach((node, visibleIndex) => {
      if (node.value === "\n") {
        lines.push({
          startIndex: lineStartIndex,
          endIndex: visibleIndex,
          breakIndex: visibleIndex,
          nodes: currentNodes,
          text: currentText,
        });
        currentNodes = [];
        currentText = "";
        lineStartIndex = visibleIndex + 1;
        return;
      }

      currentNodes.push({ node, index: visibleIndex });
      currentText += node.value;
    });

    lines.push({
      startIndex: lineStartIndex,
      endIndex: visibleNodes.length,
      breakIndex: null,
      nodes: currentNodes,
      text: currentText,
    });

    return lines;
  }

  getRenderRange() {
    const lineCount = this.lines.length;
    if (lineCount === 0) return { start: 0, end: -1 };
    if (lineCount <= VIRTUALIZE_AFTER_LINES) return { start: 0, end: lineCount - 1 };

    const firstVisible = Math.floor(this.scrollEl.scrollTop / LINE_HEIGHT);
    const visibleCount = Math.ceil(this.scrollEl.clientHeight / LINE_HEIGHT);
    const start = Math.max(0, firstVisible - VIEWPORT_BUFFER_LINES);
    const end = Math.min(lineCount - 1, firstVisible + visibleCount + VIEWPORT_BUFFER_LINES);
    return { start, end };
  }

  createSpacer(height) {
    if (height <= 0) return null;
    const spacer = document.createElement("div");
    spacer.className = "line-spacer";
    spacer.style.height = `${height}px`;
    return spacer;
  }

  createLineElement(line, lineNumber) {
    const lineEl = document.createElement("div");
    lineEl.className = "editor-line";
    lineEl.dataset.line = String(lineNumber);
    lineEl.style.height = `${LINE_HEIGHT}px`;

    const numberEl = document.createElement("span");
    numberEl.className = "line-number";
    numberEl.textContent = String(lineNumber + 1);

    const codeEl = document.createElement("span");
    codeEl.className = "line-code";
    codeEl.dataset.line = String(lineNumber);

    const tokens = tokenizeLine(line.text);
    line.nodes.forEach(({ node, index }, offset) => {
      const charEl = document.createElement("span");
      charEl.className = `char token-${tokenTypeAt(tokens, offset)}`;
      charEl.dataset.nodeId = idKey(node.id);
      charEl.dataset.visibleIndex = String(index);
      charEl.textContent = node.value;
      codeEl.appendChild(charEl);
    });

    if (line.nodes.length === 0) {
      const emptyEl = document.createElement("span");
      emptyEl.className = "empty-line";
      emptyEl.textContent = "\u00a0";
      codeEl.appendChild(emptyEl);
    }

    lineEl.append(numberEl, codeEl);
    return lineEl;
  }

  lineSignature(line) {
    const ids = line.nodes.map(({ node }) => `${idKey(node.id)}=${node.value}`).join("|");
    return `${line.startIndex}:${line.endIndex}:${line.breakIndex ?? "n"}:${ids}`;
  }

  restoreCaret(index, options = {}) {
    const shouldFocus = options.focus !== false;
    this.caretIndex = this.clampIndex(index);

    if (shouldFocus) this.editorEl.focus({ preventScroll: true });
    this.ensureCaretVisible();

    const anchor = this.getCaretAnchor(this.caretIndex);
    if (anchor) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(anchor.node, anchor.offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    this.positionLocalCaret();
  }

  getCaretIndex() {
    return this.caretIndex;
  }

  clampIndex(index) {
    const max = this.crdt ? this.crdt.getVisibleLength() : 0;
    if (!Number.isFinite(index)) return max;
    return Math.max(0, Math.min(index, max));
  }

  ensureCaretVisible() {
    const lineInfo = this.getLineForIndex(this.caretIndex);
    if (!lineInfo) return;

    const top = lineInfo.lineNumber * LINE_HEIGHT;
    const bottom = top + LINE_HEIGHT;
    if (top < this.scrollEl.scrollTop) {
      this.scrollEl.scrollTop = top;
      this.render();
    } else if (bottom > this.scrollEl.scrollTop + this.scrollEl.clientHeight) {
      this.scrollEl.scrollTop = bottom - this.scrollEl.clientHeight;
      this.render();
    }
  }

  getCaretAnchor(index) {
    const lineInfo = this.getLineForIndex(index);
    if (!lineInfo) return null;

    const { line, lineNumber } = lineInfo;
    if (lineNumber < this.renderedRange.start || lineNumber > this.renderedRange.end) {
      this.render();
    }

    const lineEl = this.linesEl.querySelector(`[data-line="${lineNumber}"]`);
    const codeEl = lineEl?.querySelector(".line-code");
    if (!codeEl) return null;

    const column = Math.max(0, Math.min(index - line.startIndex, line.nodes.length));
    if (column < line.nodes.length) {
      const nextId = idKey(line.nodes[column].node.id);
      const next = codeEl.querySelector(`[data-node-id="${CSS.escape(nextId)}"]`);
      return next?.firstChild ? { node: next.firstChild, offset: 0 } : { node: codeEl, offset: 0 };
    }

    if (line.nodes.length > 0) {
      const previousId = idKey(line.nodes[line.nodes.length - 1].node.id);
      const previous = codeEl.querySelector(`[data-node-id="${CSS.escape(previousId)}"]`);
      if (previous?.firstChild) {
        return { node: previous.firstChild, offset: previous.firstChild.textContent.length };
      }
    }

    return { node: codeEl, offset: 0 };
  }

  positionLocalCaret() {
    if (!this.localCaretEl) return;
    const coordinates = this.getCaretCoordinates(this.caretIndex);
    if (!coordinates) {
      this.localCaretEl.style.display = "none";
      return;
    }

    this.localCaretEl.style.display = "block";
    this.localCaretEl.style.transform = `translate(${coordinates.left}px, ${coordinates.top}px)`;
    this.localCaretEl.style.height = `${coordinates.height}px`;
  }

  getCaretCoordinates(index) {
    const lineInfo = this.getLineForIndex(index);
    if (!lineInfo) return null;

    const { line, lineNumber } = lineInfo;
    if (lineNumber < this.renderedRange.start || lineNumber > this.renderedRange.end) return null;

    const lineEl = this.linesEl.querySelector(`[data-line="${lineNumber}"]`);
    const codeEl = lineEl?.querySelector(".line-code");
    if (!lineEl || !codeEl) return null;

    const canvasRect = this.canvasEl.getBoundingClientRect();
    const codeRect = codeEl.getBoundingClientRect();
    const column = Math.max(0, Math.min(index - line.startIndex, line.nodes.length));
    let left = codeRect.left - canvasRect.left;

    if (column > 0 && line.nodes[column - 1]) {
      const previousId = idKey(line.nodes[column - 1].node.id);
      const previous = codeEl.querySelector(`[data-node-id="${CSS.escape(previousId)}"]`);
      if (previous) left = previous.getBoundingClientRect().right - canvasRect.left;
    } else if (column < line.nodes.length && line.nodes[column]) {
      const nextId = idKey(line.nodes[column].node.id);
      const next = codeEl.querySelector(`[data-node-id="${CSS.escape(nextId)}"]`);
      if (next) left = next.getBoundingClientRect().left - canvasRect.left;
    }

    return {
      left,
      top: lineEl.getBoundingClientRect().top - canvasRect.top,
      height: LINE_HEIGHT,
    };
  }

  getIndexFromPoint(clientX, clientY) {
    const lineElements = [...this.linesEl.querySelectorAll(".editor-line")];
    if (lineElements.length === 0) return 0;

    let lineEl = lineElements.find((element) => {
      const rect = element.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });

    if (!lineEl) {
      const first = lineElements[0];
      const last = lineElements[lineElements.length - 1];
      lineEl = clientY < first.getBoundingClientRect().top ? first : last;
    }

    const lineNumber = Number(lineEl.dataset.line);
    const line = this.lines[lineNumber];
    if (!line) return this.crdt.getVisibleLength();

    const codeEl = lineEl.querySelector(".line-code");
    const codeRect = codeEl.getBoundingClientRect();
    if (clientX <= codeRect.left || line.nodes.length === 0) return line.startIndex;

    for (const { node, index } of line.nodes) {
      const charEl = codeEl.querySelector(`[data-node-id="${CSS.escape(idKey(node.id))}"]`);
      if (!charEl) continue;
      const rect = charEl.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }

    return line.startIndex + line.nodes.length;
  }

  getLineForIndex(index) {
    if (this.lines.length === 0) return null;
    const target = this.clampIndex(index);
    const foundIndex = this.lines.findIndex((line) => target >= line.startIndex && target <= line.endIndex);
    const lineNumber = foundIndex === -1 ? this.lines.length - 1 : foundIndex;
    return { line: this.lines[lineNumber], lineNumber };
  }

  getLineColumnForIndex(index) {
    const lineInfo = this.getLineForIndex(index);
    if (!lineInfo) return { lineNumber: 0, column: 0 };
    return {
      lineNumber: lineInfo.lineNumber,
      column: Math.max(0, Math.min(index - lineInfo.line.startIndex, lineInfo.line.nodes.length)),
    };
  }

  indexFromLineColumn(lineNumber, column) {
    const line = this.lines[Math.max(0, Math.min(lineNumber, this.lines.length - 1))];
    if (!line) return 0;
    return line.startIndex + Math.max(0, Math.min(column, line.nodes.length));
  }

  moveVertical(direction) {
    const { lineNumber, column } = this.getLineColumnForIndex(this.caretIndex);
    return this.indexFromLineColumn(lineNumber + direction, column);
  }
}
