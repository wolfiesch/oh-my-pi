/**
 * `omp home` — launch OMP Home.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import type { HomeCommandArgs } from "../cli/home-cli";
import { runHomeCommand } from "../cli/home-cli";
import { initTheme } from "../modes/theme/theme";

export default class Home extends Command {
	static description = "Open OMP Home (hub, routing graph, settings)";

	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the OMP Home server", default: 4878 }),
		profile: Flags.string({
			description: "Initial profile id to select (defaults to the active profile)",
		}),
		open: Flags.boolean({ description: "Open the browser (default; use --no-open to skip)", default: true }),
		"no-open": Flags.boolean({ description: "Do not open the browser" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Home);

		const cmd: HomeCommandArgs = {
			port: flags.port,
			profile: flags.profile,
			open: flags.open && !flags["no-open"],
		};

		await initTheme();
		await runHomeCommand(cmd);
	}
}
