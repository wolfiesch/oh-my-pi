import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type AppserverAction, type AppserverCommandArgs, runAppserverCommand } from "../cli/appserver-cli";

const ACTIONS: readonly AppserverAction[] = ["status", "drain-if-idle", "pair", "devices", "revoke"];

export default class Appserver extends Command {
	static description = "Administer the T4-owned local host";
	static args = {
		action: Args.string({ description: "Appserver action", required: false, options: ACTIONS }),
	};
	static flags = {
		json: Flags.boolean({ description: "Output machine-readable JSON" }),
		capability: Flags.string({ description: "Pair capability (repeatable)", multiple: true }),
		"ttl-seconds": Flags.integer({ description: "Pair ticket lifetime in seconds (default 120, max 120)" }),
		"expected-node-id": Flags.string({ description: "Restrict pairing to one Tailscale node" }),
		"expected-host-id": Flags.string({ description: "Expected owner host id for an atomic idle drain" }),
		"expected-epoch": Flags.string({ description: "Expected owner epoch for an atomic idle drain" }),
		"device-id": Flags.string({ description: "Device id to revoke" }),
	};
	static examples = [
		"# Fence an exactly identified idle appserver before maintenance\n  omp appserver drain-if-idle --expected-host-id HOST --expected-epoch EPOCH --json",
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
			if (
				action !== "pair" &&
				(parsed.flags.capability?.length ||
					parsed.flags["ttl-seconds"] !== undefined ||
					parsed.flags["expected-node-id"])
			)
				throw new Error("pair flags are only valid with `pair`");
			if (action !== "revoke" && parsed.flags["device-id"])
				throw new Error("--device-id is only valid with `revoke`");
			if (
				action !== "drain-if-idle" &&
				(parsed.flags["expected-host-id"] !== undefined || parsed.flags["expected-epoch"] !== undefined)
			)
				throw new Error("--expected-host-id and --expected-epoch are only valid with `drain-if-idle`");
			const command: AppserverCommandArgs = {
				action,
				flags: {
					json: parsed.flags.json,
					capabilities: parsed.flags.capability,
					ttlSeconds: parsed.flags["ttl-seconds"],
					expectedNodeId: parsed.flags["expected-node-id"],
					expectedHostId: parsed.flags["expected-host-id"],
					expectedEpoch: parsed.flags["expected-epoch"],
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
