// Notepad++-style code folding: boxed ⊟/⊞ markers, a line under folded blocks, folding by
// brackets in every language, and fold/unfold by level.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import {
  codeFolding, foldGutter, foldService, foldable, foldedRanges, foldEffect, unfoldEffect,
  matchBrackets, foldAll, unfoldAll, foldCode, unfoldCode,
} from "@codemirror/language";

// A line that ends with an unclosed ( [ or { folds up to its matching bracket, like
// `client = OpenAI(` ... `)`. Lines without one fall back to the language's own folding.
const bracketFolding = foldService.of((state, lineStart, lineEnd) => {
  const text = state.doc.sliceString(lineStart, lineEnd).replace(/\s+$/, "");
  const last = text[text.length - 1];
  if (!last || !"([{".includes(last)) return null;
  const pos = lineStart + text.length - 1;
  const match = matchBrackets(state, pos, 1);
  if (!match || !match.matched || !match.end) return null;
  const close = match.end.from;
  if (state.doc.lineAt(close).number === state.doc.lineAt(pos).number) return null;
  return { from: pos + 1, to: close };
});

const foldMarker = (open) => {
  const box = document.createElement("span");
  box.className = "cm-fold-box";
  box.textContent = open ? "−" : "+";
  box.title = open ? "Fold" : "Unfold";
  return box;
};

// Draws a line under each folded line, as Notepad++ does.
const foldedLineMark = Decoration.line({ class: "cm-folded-line" });
const foldedLines = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view.state);
    }
    update(u) {
      if (u.docChanged || foldedRanges(u.state) !== foldedRanges(u.startState)) this.decorations = this.build(u.state);
    }
    build(state) {
      const b = new RangeSetBuilder();
      let lastLine = -1;
      foldedRanges(state).between(0, state.doc.length, (from) => {
        const line = state.doc.lineAt(from);
        if (line.number !== lastLine) b.add(line.from, line.from, foldedLineMark);
        lastLine = line.number;
      });
      return b.finish();
    }
  },
  { decorations: (p) => p.decorations }
);

export const folding = [
  bracketFolding,
  codeFolding({ placeholderText: "⋯" }),
  foldGutter({ markerDOM: foldMarker }),
  foldedLines,
];

// Every foldable block in the document, with how deeply it is nested (0 = outermost).
function foldBlocks(state) {
  const blocks = [];
  const lines = Math.min(state.doc.lines, 50000);
  for (let n = 1; n <= lines; n++) {
    const line = state.doc.line(n);
    const r = foldable(state, line.from, line.to);
    if (r) blocks.push(r);
  }
  const open = [];
  for (const b of blocks) {
    while (open.length && open[open.length - 1].to < b.to) open.pop();
    b.depth = open.length;
    open.push(b);
  }
  return blocks;
}

function isFolded(state, b) {
  let found = false;
  foldedRanges(state).between(b.from, b.from, (from, to) => {
    if (from === b.from && to === b.to) found = true;
  });
  return found;
}

export function foldLevel(view, level) {
  const effects = foldBlocks(view.state)
    .filter((b) => b.depth === level - 1 && !isFolded(view.state, b))
    .map((b) => foldEffect.of({ from: b.from, to: b.to }));
  if (effects.length) view.dispatch({ effects });
}

export function unfoldLevel(view, level) {
  const effects = foldBlocks(view.state)
    .filter((b) => b.depth === level - 1 && isFolded(view.state, b))
    .map((b) => unfoldEffect.of({ from: b.from, to: b.to }));
  if (effects.length) view.dispatch({ effects });
}

export { foldAll, unfoldAll, foldCode as foldCurrent, unfoldCode as unfoldCurrent };
