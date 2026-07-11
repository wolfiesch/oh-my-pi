import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { runAppserverCommand, type AppserverAction, type AppserverCommandArgs } from "../cli/appserver-cli";

const ACTIONS: readonly AppserverAction[] = ["serve", "status"];

export default class Appserver extends Command {
	static description = "Run the local appserver";

	static args = {
		action: Args.string({
			description: "Appserver action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output status as JSON" }),
	};

	static examples = ["# Run the local appserver in the foreground\n  omp appserver serve", "# Check local appserver health\n  omp appserver status", "# Machine-readable health check\n  omp appserver status --json"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Appserver);
		if (!args.action) {
			renderCommandHelp("omp", "appserver", Appserver);
			return;
		}
		const action = args.action as AppserverAction;
		if (action === "serve" && flags.json) throw new Error("--json is only supported by `omp appserver status`");
		const command: AppserverCommandArgs = { action, flags: { json: flags.json } };
		try {
			await runAppserverCommand(command);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`appserver ${action} failed: ${message}\n`);
			process.exitCode = 1;
		}
	}
}
