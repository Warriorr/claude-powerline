import { execSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
} from "node:fs";
import { WriteStream } from "node:tty";

const ESC = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const VALID_TTY_PATTERN = /^[a-zA-Z0-9/]+$/;

const MAX_PROC_HOPS = 10;
const PTY_MAJOR_MIN = 136;
const PTY_MAJOR_MAX = 143;
const PTY_MINORS_PER_MAJOR = 256;
const CONSOLE_MAJOR = 4;
const SERIAL_MINOR_BASE = 64;

export interface ProcStat {
  ppid: number;
  ttyNr: number;
}

/**
 * @info Parses a /proc/<pid>/stat line. The comm field is parenthesized and may
 * itself contain spaces and parentheses, so the split happens at the last ")".
 * After it, field 1 is state, field 2 is ppid and field 5 is tty_nr.
 */
export function parseProcStat(text: string): ProcStat | null {
  const commEnd = text.lastIndexOf(")");
  if (commEnd === -1) return null;

  const fields = text
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const ppid = parseInt(fields[1] ?? "", 10);
  const ttyNr = parseInt(fields[4] ?? "", 10);
  if (isNaN(ppid) || isNaN(ttyNr)) return null;

  return { ppid, ttyNr };
}

/**
 * @info Decodes a Linux tty_nr device number into a device path. 0 means the
 * process has no controlling terminal.
 */
export function ttyPathFromTtyNr(ttyNr: number): string | null {
  if (!Number.isInteger(ttyNr) || ttyNr <= 0) return null;

  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);

  if (major >= PTY_MAJOR_MIN && major <= PTY_MAJOR_MAX) {
    const index = minor + (major - PTY_MAJOR_MIN) * PTY_MINORS_PER_MAJOR;
    return `/dev/pts/${index}`;
  }

  if (major === CONSOLE_MAJOR) {
    return minor < SERIAL_MINOR_BASE
      ? `/dev/tty${minor}`
      : `/dev/ttyS${minor - SERIAL_MINOR_BASE}`;
  }

  return null;
}

function readProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
}

/**
 * @info Walks the process tree via /proc to find the nearest controlling
 * terminal, with no subprocess at all.
 */
export function findParentTtyFromProc(
  startPid: number,
  readStat: (pid: number) => string | null = readProcStat,
): string | null {
  let pid = startPid;

  for (let i = 0; i < MAX_PROC_HOPS; i++) {
    const text = readStat(pid);
    if (!text) return null;

    const stat = parseProcStat(text);
    if (!stat) return null;

    const ttyPath = ttyPathFromTtyNr(stat.ttyNr);
    if (ttyPath) return ttyPath;

    if (stat.ppid === 0 || stat.ppid === 1) return null;
    pid = stat.ppid;
  }

  return null;
}

/**
 * @info Reads the column count of a tty via the TIOCGWINSZ ioctl libuv performs
 * when a WriteStream wraps the fd. O_NOCTTY keeps this process from acquiring a
 * controlling terminal.
 */
function readTtyColumns(ttyPath: string): number | null {
  let fd: number | null = null;

  try {
    fd = openSync(
      ttyPath,
      fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK,
    );
    const stream = new WriteStream(fd);
    const columns = stream.columns;
    stream.destroy();
    fd = null;

    return typeof columns === "number" && columns > 0 ? columns : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function getProcTerminalWidth(): number | null {
  if (process.platform !== "linux") return null;

  const ttyPath = findParentTtyFromProc(process.pid);
  if (!ttyPath) return null;

  return readTtyColumns(ttyPath);
}

function findParentTty(): string | null {
  if (process.platform === "win32") return null;

  let pid = process.pid.toString();

  for (let i = 0; i < 10; i++) {
    try {
      const info = execSync(`ps -o ppid=,tty= -p ${pid}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      const parts = info.split(/\s+/);
      const ppid = parts[0];
      const tty = parts[1];

      if (tty && tty !== "?" && tty !== "??" && VALID_TTY_PATTERN.test(tty)) {
        return tty;
      }

      if (!ppid || ppid === "1" || ppid === "0") break;
      pid = ppid;
    } catch {
      break;
    }
  }

  return null;
}

function getWindowsTerminalWidth(): number | null {
  try {
    const output = execSync("mode con", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const match = output.match(/Columns:\s*(\d+)/i);
    if (match?.[1]) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {}
  return null;
}

function getUnixTerminalWidth(): number | null {
  const procWidth = getProcTerminalWidth();
  if (procWidth) return procWidth;

  const tty = findParentTty();
  if (tty) {
    try {
      const size = execSync(`stty size < /dev/${tty}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        shell: "/bin/sh",
      }).trim();
      const width = size.split(" ")[1];
      if (width) {
        const parsed = parseInt(width, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    } catch {}
  }

  try {
    const width = execSync("tput cols 2>/dev/null", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    const parsed = parseInt(width, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  } catch {}

  return null;
}

/**
 * @info Returns 70% of terminal width to reserve space for Claude Code's
 * right-side UI messages (e.g., "ctrl-g to edit prompt in Nvim", "Thinking off")
 */
export function getTerminalWidth(): number | null {
  const applyReserve = (w: number) => Math.floor(w * 0.7);

  const envColumns = process.env.COLUMNS;
  if (envColumns) {
    const parsed = parseInt(envColumns, 10);
    if (!isNaN(parsed) && parsed > 0) return applyReserve(parsed);
  }

  if (process.stdout.columns && process.stdout.columns > 0) {
    return applyReserve(process.stdout.columns);
  }

  if (process.platform === "win32") {
    const width = getWindowsTerminalWidth();
    if (width) return applyReserve(width);
  }

  const width = getUnixTerminalWidth();
  return width ? applyReserve(width) : null;
}

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}
