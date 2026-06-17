/**
 * Mechanism CLI command handlers.
 *
 * Handles `omp mechanism` subcommand for viewing harness live running state.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { openPath } from "../utils/open";

export interface MechanismCommandArgs {
	port: number;
	sessionFile?: string;
}

export function parseMechanismArgs(args: string[]): MechanismCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "mechanism") {
		return undefined;
	}

	const result: MechanismCommandArgs = {
		port: 3848,
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
			result.port = parseInt(args[++i], 10);
		} else if (arg.startsWith("--port=")) {
			result.port = parseInt(arg.split("=")[1], 10);
		} else if ((arg === "--session" || arg === "-s") && i + 1 < args.length) {
			result.sessionFile = args[++i];
		} else if (arg.startsWith("--session=")) {
			result.sessionFile = arg.split("=").slice(1).join("=");
		}
	}

	return result;
}

export async function runMechanismCommand(cmd: MechanismCommandArgs): Promise<void> {
	// Dynamic import to avoid loading Three.js and starting server modules during bare CLI initialization
	const { startServer } = await import("@oh-my-pi/omp-mechanism");

	// Start the mechanism server
	const { port, stop } = await startServer(cmd.port, { sessionFile: cmd.sessionFile });
	console.log(chalk.green(`Mechanism visualization available at: http://localhost:${port}`));

	// Open browser
	const url = `http://localhost:${port}`;
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down mechanism server...");
		stop();
		process.exit(0);
	});

	// Keep the process alive
	const { promise } = Promise.withResolvers<void>();
	await promise;
}

export function printMechanismHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} mechanism`)} - OMP Live Harness Visualization Orrery
Base port is 3848.
`);
}
