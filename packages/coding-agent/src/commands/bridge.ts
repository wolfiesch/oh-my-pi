import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runOmpAuthorityBridge } from "../cli/appserver-bridge-cli";

export default class Bridge extends Command {
	static description = "Expose the private OMP authority bridge used by T4 Code";
	static flags = {
		stdio: Flags.boolean({ description: "Use the versioned JSON-lines standard I/O transport" }),
	};
	async run(): Promise<void> {
		const parsed = await this.parse(Bridge);
		if (parsed.argv.length !== 0) throw new Error("bridge accepts no positional arguments");
		if (parsed.flags.stdio !== true) throw new Error("bridge requires --stdio");
		await runOmpAuthorityBridge();
	}
}
