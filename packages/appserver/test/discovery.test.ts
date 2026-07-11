import { describe, expect, test } from "bun:test";
import { hostId, parseBounded } from "@oh-my-pi/app-wire";
import type { FileSystem } from "../src/types.ts";
import { FileSessionDiscovery } from "../src/discovery.ts";
import { SessionProjection } from "../src/projection.ts";

const stamp = "2026-07-11T00:00:00.000Z";
const host = hostId("discovery-test");

function fakeFs(files: Record<string, string>, directories: string[]): FileSystem {
  return {
    mkdir: async () => undefined,
    chmod: async () => undefined,
    unlink: async () => undefined,
    stat: async path => ({ isFile: () => path in files, isDirectory: () => directories.includes(path), mode: 0o600, mtimeMs: 1, size: files[path]?.length ?? 0 }),
    readdir: async path => [...Object.keys(files), ...directories].filter(child => child !== path && child.startsWith(`${path}/`) && !child.slice(path.length + 1).includes("/")),
    readFile: async path => files[path] ?? "",
  };
}

function line(value: Record<string, unknown>): string { return JSON.stringify(value); }
function transcript(entries: Record<string, unknown>[], title?: string): string {
  const prelude = title === undefined ? [] : [{ type: "title", v: 1, title, updatedAt: stamp, pad: "" }];
  return [...prelude, { type: "session", version: 3, id: "session-1", cwd: "/home/lycaon/project", timestamp: stamp }, ...entries].map(line).join("\n");
}

 describe("current OMP JSONL projection", () => {
  test("normalizes nested messages, tools, hidden entries, and runtime settings", async () => {
    const entries: Record<string, unknown>[] = [
      { type: "session_init", id: "init", parentId: null, timestamp: stamp, systemPrompt: "do not leak /home/lycaon/secret", task: "task", tools: ["read"] },
      { type: "model_change", id: "model", parentId: "init", timestamp: stamp, model: "openai/gpt-5.6" },
      { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: stamp, thinkingLevel: "high" },
      { type: "message", id: "u1", parentId: "thinking", timestamp: stamp, message: { role: "user", content: "Please inspect the project" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: stamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "I should inspect safely." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/home/lycaon/project/src/app.ts" } }] } },
      { type: "message", id: "r1", parentId: "a1", timestamp: stamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false } },
      { type: "custom_message", id: "hidden", parentId: "r1", timestamp: stamp, customType: "secret", content: "hidden", display: false },
      { type: "custom_message", id: "shown", parentId: "hidden", timestamp: stamp, customType: "notice", content: "Visible note", display: true, attribution: "agent" },
    ];
    const discovery = new FileSessionDiscovery("/root", fakeFs({ "/root/session.jsonl": transcript(entries, "  Fixed\nTitle  ") }, ["/root"]), host);
    const [session] = await discovery.list();
    expect(session?.title).toBe("Fixed Title");
    expect(session?.projectName).toBe("project");
    expect(session?.cwd).toBe("/home/lycaon/project");
    expect(session?.model).toBe("openai/gpt-5.6");
    expect(session?.thinking).toBe("high");
    expect(session?.entries.map(entry => entry.kind)).toEqual(["message", "message", "tool-use", "message"]);
    const message = session?.entries[0];
    expect(message?.data).toEqual({ role: "user", text: "Please inspect the project" });
    const tool = session?.entries[2];
    expect(tool?.data).toMatchObject({ tool: "read", title: "read", ok: true, result: { output: "file contents" } });
    expect(JSON.stringify(session?.entries)).not.toContain("systemPrompt");
    expect(JSON.stringify(session?.entries)).not.toContain("/home/lycaon");
    expect(session?.entries[1]?.data).toEqual({ role: "assistant", text: "", reasoning: "I should inspect safely." });
  });

  test("bounds non-ASCII titles and falls back to the first visible user text", async () => {
    const title = `${"界".repeat(400)}\n  `;
    const entries = [{ type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: "First visible request" } }];
    const discovery = new FileSessionDiscovery("/root", fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]), host);
    const [session] = await discovery.list();
    expect(session?.title).toBe("First visible request");
    const titledDiscovery = new FileSessionDiscovery("/root", fakeFs({ "/root/session.jsonl": transcript([], title) }, ["/root"]), host);
    const [titled] = await titledDiscovery.list();
    expect(titled?.title).toBeDefined();
    expect(new TextEncoder().encode(titled?.title ?? "").byteLength).toBeLessThanOrEqual(512);
  });

  test("limits snapshots to 1000 entries with an omission notice", async () => {
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < 1001; i++) entries.push({ type: "message", id: `m-${i}`, parentId: i === 0 ? null : `m-${i - 1}`, timestamp: stamp, message: { role: "user", content: `${"x".repeat(8192)} ${i}` } });
    const discovery = new FileSessionDiscovery("/root", fakeFs({ "/root/session.jsonl": transcript(entries) }, ["/root"]), host);
    const [session] = await discovery.list();
    expect(session?.entries.length).toBeLessThanOrEqual(1000);
    expect(session?.entries[0]?.kind).toBe("compaction");
    expect(session?.entries[0]?.data.summary).toContain("Older transcript entries were omitted");
    expect(new Set(session?.entries.map(entry => entry.id)).size).toBe(session?.entries.length);
    expect(session?.entries.every(entry => entry.parentId === null || session?.entries.some(parent => parent.id === entry.parentId))).toBe(true);
    if (!session) throw new Error("session not discovered");
    const snapshot = new SessionProjection(host, session, "epoch-test").snapshot();
    const snapshotText = JSON.stringify(snapshot);
    expect(new TextEncoder().encode(snapshotText).byteLength).toBeLessThan(1_048_576);
    expect(() => parseBounded(snapshotText)).not.toThrow();
  });
});
