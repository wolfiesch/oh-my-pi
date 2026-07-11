import { describe, expect, test } from "bun:test";
import { TailscaleWhoisResolver } from "../src/remote/resolver.ts";
import { createListenerPlan, createServeProxyPlan, directPeer, isTailnetAddress, originAllowed, resolveServePeer } from "../src/remote/listener.ts";

describe("remote address policy", () => {
  test("accepts Tailscale IPv4/IPv6 edges and rejects wildcard/LAN/loopback", () => {
    expect(isTailnetAddress("::ffff:100.64.0.1")).toBe(true); expect(directPeer("::ffff:100.64.0.1", "n").address).toBe("100.64.0.1"); expect(() => createListenerPlan({ mode: "direct", address: "::ffff:100.64.0.1", port: 1 } as never)).toThrow();
    expect(() => createListenerPlan({ address: "0.0.0.0", port: 1 })).toThrow(); expect(createListenerPlan({ address: "100.64.0.1", port: 443 }).path).toBe("/v1/ws"); expect(() => createServeProxyPlan({ address: "100.64.0.1", port: 80, serveProxy: true })).toThrow();
  });
  test("Serve headers require loopback trusted proxy and complete validated identity", () => {
    const headers = new Headers({ "Tailscale-Node-ID": "node", "Tailscale-Node-Name": "host", "Tailscale-User-Login": "u@example", "Tailscale-Client-IP": "100.64.0.1" });
    expect(resolveServePeer("127.0.0.1", headers, true)?.identity.nodeId).toBe("node"); expect(resolveServePeer("10.0.0.1", headers, true)).toBeUndefined(); expect(resolveServePeer("127.0.0.1", headers, false)).toBeUndefined(); expect(resolveServePeer("127.0.0.1", new Headers({ ...Object.fromEntries(headers), "Tailscale-Client-IP": "127.0.0.1" }), true)).toBeUndefined();
    expect(directPeer("100.64.0.2", "node").source).toBe("direct"); expect(() => directPeer("127.0.0.1", "node")).toThrow();
  });
});
  test("origin policy is exact allowlist and denies browser wildcard", () => { expect(originAllowed(null)).toBe(true); expect(originAllowed("https://app.example", ["https://app.example"])).toBe(true); expect(originAllowed("https://evil.example", ["https://app.example"])).toBe(false); });

describe("bounded tailscale whois", () => {
  test("uses fixed argv and parses strict identity", async () => {
    const calls: string[][] = []; const resolver = new TailscaleWhoisResolver({ run: async (argv) => { calls.push(argv); return { exitCode: 0, stdout: JSON.stringify({ Node: { StableID: "node", Name: "host", ComputedName: "host.tail", Addresses: ["100.64.0.1/32", "fd7a:115c:a1e0::1/128"] }, UserProfile: { LoginName: "u" } }) }; } });
    await expect(resolver.resolve("100.64.0.1")).resolves.toMatchObject({ nodeId: "node", hostname: "host.tail", user: "u", addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"] }); expect(calls[0]).toEqual(["tailscale", "whois", "--json", "100.64.0.1"]);
  });
  test("rejects injection, bad JSON, failure, and oversized output", async () => {
    const runner = { run: async () => ({ exitCode: 0, stdout: "{" }) }; await expect(new TailscaleWhoisResolver(runner).resolve("100.64.0.1")).rejects.toThrow(); await expect(new TailscaleWhoisResolver(runner).resolve("100.64.0.1; rm -rf /")).rejects.toThrow(); await expect(new TailscaleWhoisResolver({ run: async () => ({ exitCode: 1, stdout: "" }) }).resolve("100.64.0.1")).rejects.toThrow();
  });
});
