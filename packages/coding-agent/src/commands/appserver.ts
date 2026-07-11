import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { runAppserverCommand, type AppserverAction, type AppserverCommandArgs } from "../cli/appserver-cli";

const ACTIONS: readonly AppserverAction[] = ["serve", "status", "pair", "devices", "revoke"];

export default class Appserver extends Command {
	static description = "Run and administer the local or paired Tailscale appserver";
	static args = {
		action: Args.string({ description: "Appserver action", required: false, options: ACTIONS }),
	};
	static flags = {
		json: Flags.boolean({ description: "Output machine-readable JSON" }),
		"remote-mode": Flags.string({ description: "Remote listener mode", options: ["direct", "serve"] }),
		"remote-address": Flags.string({ description: "Explicit tailnet or loopback bind address" }),
		"remote-port": Flags.integer({ description: "Remote listener port (default 8787)" }),
		"remote-origin": Flags.string({ description: "Allowed WebSocket origin (repeatable)", multiple: true }),
		"remote-state-dir": Flags.string({ description: "Absolute remote state directory" }),
		"trusted-serve-proxy": Flags.boolean({ description: "Trust Tailscale Serve identity headers" }),
		capability: Flags.string({ description: "Pair capability (repeatable)", multiple: true }),
		"ttl-seconds": Flags.integer({ description: "Pair ticket lifetime in seconds (default 120, max 120)" }),
		"expected-node-id": Flags.string({ description: "Restrict pairing to one Tailscale node" }),
		"device-id": Flags.string({ description: "Device id to revoke" }),
	};
	static examples = [
		"# Run the local appserver in the foreground\n  omp appserver serve",
		"# Run a direct paired listener\n  omp appserver serve --remote-mode direct --remote-address 100.64.0.10 --remote-port 8787",
		"# Mint a six-digit pairing code through the owner UDS\n  omp appserver pair --capability sessions.read",
		"# List redacted devices\n  omp appserver devices --json",
		"# Revoke a device\n  omp appserver revoke --device-id DEVICE_ID",
	];
	async run(): Promise<void> {
		try {
			const parsed = await this.parse(Appserver);
			if (parsed.argv.length > 1) throw new Error("expected exactly one action and no trailing positionals");
			if (!parsed.args.action) {
				renderCommandHelp("omp", "appserver", Appserver);
				return;
			}
			const action = parsed.args.action as AppserverAction;
			if (action === "serve" && parsed.flags.json) throw new Error("--json is not supported by `omp appserver serve`");
			if (action !== "serve" && (parsed.flags["remote-mode"] || parsed.flags["remote-address"] || parsed.flags["remote-port"] || parsed.flags["remote-origin"]?.length || parsed.flags["remote-state-dir"] || parsed.flags["trusted-serve-proxy"]))
				throw new Error("remote listener flags are only valid with `serve`");
			if (action !== "pair" && (parsed.flags.capability?.length || parsed.flags["ttl-seconds"] !== undefined || parsed.flags["expected-node-id"]))
				throw new Error("pair flags are only valid with `pair`");
			if (action !== "revoke" && parsed.flags["device-id"]) throw new Error("--device-id is only valid with `revoke`");
			const command: AppserverCommandArgs = {
				action,
				flags: {
					json: parsed.flags.json,
					serve: action === "serve" ? {
						remoteMode: parsed.flags["remote-mode"] as "direct" | "serve" | undefined,
						remoteAddress: parsed.flags["remote-address"],
						remotePort: parsed.flags["remote-port"],
						remoteOrigins: parsed.flags["remote-origin"],
						remoteStateDir: parsed.flags["remote-state-dir"],
						trustedServeProxy: parsed.flags["trusted-serve-proxy"],
					} : undefined,
					capabilities: parsed.flags.capability,
					ttlSeconds: parsed.flags["ttl-seconds"],
					expectedNodeId: parsed.flags["expected-node-id"],
					deviceId: parsed.flags["device-id"],
				},
			};
			await runAppserverCommand(command);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`appserver usage/error: ${message}\n`);
			process.exitCode = 1;
		}
	}
}
