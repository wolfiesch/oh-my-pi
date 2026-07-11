import { hostId, sessionId, terminalId, type HostId, type SessionId, type TerminalId } from "./ids.ts";
import { boundedMap, object, string } from "./guards.ts";

export interface UserTerminal {
  terminalId: TerminalId;
  hostId: HostId;
  sessionId: SessionId;
  shell: string;
  cwd?: string;
  env?: Record<string, string>;
}
export function decodeUserTerminal(value: unknown, path = "terminal"): UserTerminal {
  const terminal = object(value, path);
  terminalId(terminal.terminalId, `${path}.terminalId`); hostId(terminal.hostId, `${path}.hostId`); sessionId(terminal.sessionId, `${path}.sessionId`);
  string(terminal.shell, `${path}.shell`, 256);
  if (terminal.cwd !== undefined) string(terminal.cwd, `${path}.cwd`, 4096);
  if (terminal.env !== undefined) {
    const env = boundedMap(terminal.env, `${path}.env`);
    for (const [key, entry] of Object.entries(env)) string(entry, `${path}.env.${key}`, 8192);
  }
  return terminal as unknown as UserTerminal;
}
