/**
 * Home CLI command handler.
 *
 * Launches OMP Home: builds the API handler (which imports the home services
 * bound to the selected profile) and starts the omp-home server chassis on
 * 127.0.0.1. Profile selection edits target the SELECTED profile's
 * config.yml/agent.db, never the launching process's.
 */

import { startServer } from "@oh-my-pi/omp-home";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { createHomeApiHandler } from "../home/api-router";
import { disposeAll } from "../home/launcher-service";
import { openPath } from "../utils/open";

export interface HomeCommandArgs {
	port: number;
	profile?: string;
	open: boolean;
}

function writeStdout(message: string): void {
	process.stdout.write(message);
}

export async function runHomeCommand(cmd: HomeCommandArgs): Promise<void> {
	const apiHandler = createHomeApiHandler({ cwd: process.cwd() });
	const server = await startServer({ port: cmd.port, apiHandler });
	const { port } = server;

	const url = `http://localhost:${port}`;
	writeStdout(`${chalk.green(`OMP Home available at: ${url}`)}\n`);
	if (cmd.profile) {
		writeStdout(`${chalk.dim(`Initial profile: ${cmd.profile} (select it in the top bar if different)`)}\n`);
	}
	if (cmd.open) {
		openPath(url);
	}
	writeStdout("Press Ctrl+C to stop\n\n");

	const { promise, resolve } = Promise.withResolvers<void>();
	let stopping = false;
	process.on("SIGINT", () => {
		if (stopping) return;
		stopping = true;
		writeStdout("\nShutting down...\n");
		server.stop();
		void disposeAll().then(resolve, resolve);
	});
	await promise;
}

export function printHomeHelp(): void {
	writeStdout(`${chalk.bold(`${APP_NAME} home`)} - OMP Home

${chalk.bold("Usage:")}
  ${APP_NAME} home [options]

${chalk.bold("Options:")}
  -p, --port <port>     Port for the server (default: 4878)
      --profile <id>    Initial profile id to select
      --no-open         Do not open the browser
  -h, --help            Show this help message

${chalk.bold("What it edits:")}
  - Roles & Ctrl+P cycle (modelRoles, cycleOrder, modelTags)
  - Task agents (agentModelOverrides, disabledAgents, fallbackChains)
  - Providers & auth (agent.db credentials; OAuth stays in /login)
  - General settings (compaction, context, tasks, mcp, …)

Changes persist to the SELECTED profile's config.yml (comments preserved) and
apply on that profile's next launch.
`);
}
