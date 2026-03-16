import type { BoxChars } from "./types";

import { visibleLength } from "../utils/terminal";

export function colorize(text: string, fgColor: string, reset: string): string {
  if (!fgColor) {
    return text;
  }
  return `${fgColor}${text}${reset}`;
}

export function padRight(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) {
    return text;
  }
  return text + " ".repeat(width - visible);
}

export function truncateAnsi(text: string, maxWidth: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= maxWidth) {
    return text;
  }

  let width = 0;
  let result = "";
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith("\x1b[")) {
      result += part;
      continue;
    }
    for (const char of part) {
      if (width >= maxWidth - 1) {
        result += "…";
        return result;
      }
      result += char;
      width++;
    }
  }
  return result;
}

export function contentRow(box: BoxChars, content: string, innerWidth: number): string {
  const padded = padRight(content, innerWidth - 2);
  return box.vertical + " " + padded + " " + box.vertical;
}

export function divider(box: BoxChars, innerWidth: number): string {
  return box.teeLeft + box.horizontal.repeat(innerWidth) + box.teeRight;
}

export function bottomBorder(box: BoxChars, innerWidth: number): string {
  return box.bottomLeft + box.horizontal.repeat(innerWidth) + box.bottomRight;
}

export function spreadEven(parts: string[], totalWidth: number): string {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] ?? "";
  }

  const totalContentWidth = parts.reduce((sum, p) => sum + visibleLength(p), 0);
  const totalGap = totalWidth - totalContentWidth;
  const gapPerSlot = Math.max(2, Math.floor(totalGap / (parts.length - 1)));

  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const remaining = totalWidth - visibleLength(result) - parts.slice(i).reduce((s, p) => s + visibleLength(p), 0) - (parts.length - 1 - i) * 2;
    const gap = Math.max(2, Math.min(gapPerSlot, remaining));
    result += " ".repeat(gap) + (parts[i] ?? "");
  }

  return result;
}

export function spreadTwo(left: string, right: string, totalWidth: number): string {
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }

  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  const gap = totalWidth - leftLen - rightLen;

  if (gap < 2) {
    return `${left}  ${right}`;
  }

  return left + " ".repeat(gap) + right;
}
