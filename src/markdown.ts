/** Lightweight markdown -> ANSI renderer for terminal output. Streams line-by-line. */

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
};

function renderInline(line: string): string {
  // protect inline code first
  const codes: string[] = [];
  let s = line.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, `${A.bold}$1${A.reset}`)
    .replace(/__([^_\n]+)__/g, `${A.bold}$1${A.reset}`)
    .replace(/(^|\W)\*([^*\n]+)\*/g, `$1${A.italic}$2${A.reset}`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `$1 ${A.dim}($2)${A.reset}`)
    .replace(/~~([^~\n]+)~~/g, `${A.dim}$1${A.reset}`);
  s = s.replace(/\x00(\d+)\x00/g, (_m, i) => `${A.cyan}\`${codes[Number(i)]}\`${A.reset}`);
  return s;
}

function renderLine(line: string): string {
  const t = line.trim();
  if (!t) return "";
  if (/^#{1,6}\s/.test(t)) {
    const level = t.match(/^#+/)![0].length;
    const text = t.replace(/^#{1,6}\s*/, "");
    const color = level <= 2 ? A.cyan : level === 3 ? A.green : A.dim;
    return `${A.bold}${color}${text}${A.reset}`;
  }
  if (/^[-*_]{3,}\s*$/.test(t)) return `${A.dim}${"─".repeat(Math.min(60, line.length))}${A.reset}`;
  if (/^>\s?/.test(t)) return `${A.dim}${t}${A.reset}`;
  if (/^\s*\|.*\|\s*$/.test(t)) {
    // table row: dim the separator rows, keep cells readable
    if (/^\s*\|[\s\-:|]+\|\s*$/.test(t)) return `${A.dim}${line}${A.reset}`;
    return renderInline(line);
  }
  if (/^\s*[-*+]\s/.test(t)) return renderInline(line.replace(/^(\s*[-*+])\s/, `$1 ${A.dim}•${A.reset} `));
  if (/^\s*\d+[.)]\s/.test(t)) return renderInline(line);
  return renderInline(line);
}

export class MarkdownRenderer {
  private pending = "";
  private inFence = false;
  private fenceBuf: string[] = [];

  /** Feed a text delta; returns ANSI text safe to print now. */
  push(delta: string): string {
    this.pending += delta;
    return this.drain(false);
  }

  /** Flush remaining buffered text at end of turn. */
  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0) break;
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      out += this.emitLine(line) + "\n";
    }
    if (final && this.pending) {
      out += this.emitLine(this.pending) + (this.pending.endsWith("\n") ? "" : "\n");
      this.pending = "";
    }
    return out;
  }

  private emitLine(line: string): string {
    if (line.trimStart().startsWith("```")) {
      if (!this.inFence) {
        this.inFence = true;
        const lang = line.trim().slice(3).trim();
        return `${A.dim}\`\`\`${lang}${A.reset}`;
      }
      this.inFence = false;
      return `${A.dim}\`\`\`${A.reset}`;
    }
    if (this.inFence) return line; // code content verbatim
    return renderLine(line);
  }
}
