export interface LoginScriptEditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const INDENT = "  ";

function selectedLineRange(value: string, selectionStart: number, selectionEnd: number) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
    ? selectionEnd - 1
    : selectionEnd;
  const nextLineBreak = value.indexOf("\n", effectiveEnd);
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
  return { lineStart, lineEnd };
}

function outdentLine(line: string): string {
  if (line.startsWith("\t")) return line.slice(1);
  if (line.startsWith(INDENT)) return line.slice(INDENT.length);
  if (line.startsWith(" ")) return line.slice(1);
  return line;
}

export function editLoginScriptIndent(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): LoginScriptEditResult {
  if (!outdent && selectionStart === selectionEnd) {
    return {
      value: `${value.slice(0, selectionStart)}${INDENT}${value.slice(selectionEnd)}`,
      selectionStart: selectionStart + INDENT.length,
      selectionEnd: selectionStart + INDENT.length,
    };
  }

  const { lineStart, lineEnd } = selectedLineRange(value, selectionStart, selectionEnd);
  const original = value.slice(lineStart, lineEnd);
  const edited = original
    .split("\n")
    .map((line) => outdent ? outdentLine(line) : `${INDENT}${line}`)
    .join("\n");

  if (selectionStart === selectionEnd) {
    const offsetInLine = selectionStart - lineStart;
    const delta = edited.length - original.length;
    const caret = Math.max(lineStart, lineStart + offsetInLine + delta);
    return {
      value: `${value.slice(0, lineStart)}${edited}${value.slice(lineEnd)}`,
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  return {
    value: `${value.slice(0, lineStart)}${edited}${value.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + edited.length,
  };
}
