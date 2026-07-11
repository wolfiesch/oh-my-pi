import { describe, expect, test } from "bun:test";
import {
  AppWireError, MAX_INPUT_BYTES, decodeClientFrame, decodeEntry, decodeGap, decodeHello,
  decodeServerFrame, isServerFrame, sameSession,
} from "../src/index.ts";
import type { ServerFrame } from "../src/envelope.ts";

const root = new URL("../fixtures/v1/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(new URL(name, root)).text()) as unknown;
}

describe("v1 golden frames", () => {
  test("all goldens decode through their exported guard", async () => {
    const server = ["welcome", "sessions", "snapshot", "event", "agent", "terminal", "files", "review", "audit", "response", "gap", "error", "pairing", "restart"];
    for (const name of server) expect(isServerFrame(await fixture(`${name}.json`))).toBe(true);
    decodeClientFrame(await fixture("hello.json"));
    decodeClientFrame(await fixture("command.json"));
    decodeClientFrame(await fixture("confirmation.json"));
    decodeEntry(await fixture("entry.json"));
  });

  test("semantic decode keeps additive fields and unknown leaf event subtype", async () => {
    const raw = await fixture("event.json") as Record<string, unknown>;
    raw.addedByFuture = { safe: true };
    (raw.event as Record<string, unknown>).type = "future.event.v99";
    const decoded = decodeServerFrame(raw) as ServerFrame & Record<string, unknown>;
    expect(decoded.addedByFuture).toEqual({ safe: true });
    expect((decoded.event as Record<string, unknown>).type).toBe("future.event.v99");
    expect(JSON.parse(JSON.stringify(decoded))).toEqual(raw);
  });

  test("same raw session ID is distinct across hosts", async () => {
    const sessions = await fixture("sessions.json") as { sessions: Array<{ hostId: string; sessionId: string }> };
    expect(sameSession(sessions.sessions[0], sessions.sessions[1])).toBe(false);
  });

  test("restart golden requires and carries a changed epoch", async () => {
    const restart = await fixture("restart.json") as { epoch: number };
    const welcome = await fixture("welcome.json") as { epoch: number };
    expect(restart.epoch).not.toBe(welcome.epoch);
  });
});

describe("bounded boundary failures", () => {
  test("unknown top-level families are rejected", () => {
    expect(() => decodeClientFrame({ v: "omp-app/1", type: "future" })).toThrow(AppWireError);
    expect(() => decodeServerFrame({ v: "omp-app/1", type: "future" })).toThrow(AppWireError);
  });
  test("missing version and unsafe sequence are typed errors", () => {
    expect(() => decodeServerFrame({ type: "welcome" })).toThrow(AppWireError);
    expect(() => decodeServerFrame({ v: "omp-app/1", type: "sessions", cursor: { epoch: 1, seq: Number.MAX_SAFE_INTEGER + 1 }, sessions: [] })).toThrow(AppWireError);
  });
  test("epoch is required in cursor and gap", () => {
    expect(() => decodeHello({ v: "omp-app/1", type: "hello", client: "x", capabilities: { client: [] }, resume: { seq: 1 } })).toThrow(AppWireError);
    expect(() => decodeGap({ v: "omp-app/1", type: "gap", hostId: "h", sessionId: "s", from: { seq: 1 }, to: { epoch: 1, seq: 2 }, reason: "x" })).toThrow(AppWireError);
  });
  test("oversized and malformed JSON fail before decode", () => {
    expect(() => decodeServerFrame("{" + "x".repeat(MAX_INPUT_BYTES))).toThrow(AppWireError);
    expect(() => decodeServerFrame("{bad" )).toThrow(AppWireError);
  });
});
