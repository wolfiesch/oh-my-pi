import { statSync } from "node:fs";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { hostId, projectId, type DurableEntry } from "@oh-my-pi/app-wire";
import { FileSessionDiscovery, stableProjectId } from "@oh-my-pi/appserver";
import type { LockCheckHook, SessionAuthority, SessionAuthoritySession, SessionRecord } from "@oh-my-pi/appserver";
import { inspectSessionLock } from "./session-lock";
import { SessionManager } from "./session-manager";

export function createAppserverAuthority(): SessionAuthority {
  return {
    async create(cwd, title): Promise<SessionAuthoritySession> {
      const manager = SessionManager.create(cwd);
      try {
        if (title !== undefined) await manager.setSessionName(title, "user");
        await manager.ensureOnDisk();
        const path = manager.getSessionFile();
        if (!path) throw new Error("session file was not created");
        return { sessionId: manager.getSessionId() as SessionAuthoritySession["sessionId"], path, cwd: manager.getCwd(), title: manager.getSessionName(), entries: manager.getEntries() as unknown as DurableEntry[] };
      } finally {
        await manager.dispose();
      }
    },
    async list(): Promise<SessionRecord[]> {
      const discovery = new FileSessionDiscovery(getSessionsDir(), undefined, hostId("appserver-authority"));
      return discovery.list();
    },
  };
}

export const appserverLockCheck: LockCheckHook = session => {
  const inspection = inspectSessionLock(session.path);
  if (inspection.status === "live" || inspection.status === "suspect" || inspection.status === "malformed") throw new Error(`session lock is ${inspection.status}`);
};
