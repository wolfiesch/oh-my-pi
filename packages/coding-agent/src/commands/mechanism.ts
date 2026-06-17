/**
 * View live harness mechanism visualization dashboard.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import type { MechanismCommandArgs } from "../cli/mechanism-cli";
import { runMechanismCommand } from "../cli/mechanism-cli";
import { initTheme } from "../modes/theme/theme";

export default class Mechanism extends Command {
	static description = "View live running harness mechanism visualization";

	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the mechanism server", default: 3848 }),
		session: Flags.string({ char: "s", description: "Pin a specific session JSONL file (default: newest active)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Mechanism);

		const cmd: MechanismCommandArgs = {
			port: flags.port,
			sessionFile: flags.session,
		};

		await initTheme();
		await runMechanismCommand(cmd);
	}
}
