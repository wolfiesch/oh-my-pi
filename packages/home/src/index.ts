#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { startServer } from "./server";

export type * from "./api-types";
export { type ApiHandler, startServer } from "./server";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string", short: "p", default: "4878" },
			open: { type: "boolean", default: true },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(
			`omp-home - OMP Home\n\nUsage:\n  omp-home [options]\n\nOptions:\n  -p, --port <port>  Port (default 4878)\n      --no-open      Do not open the browser\n  -h, --help         Show this help message\n`,
		);
		return;
	}
	const port = parseInt(values.port || "4878", 10);
	const { port: actualPort } = await startServer({ port });
	console.log(`OMP Home available at: http://localhost:${actualPort}`);
	console.log("Press Ctrl+C to stop\n");
	process.on("SIGINT", () => process.exit(0));
}

if (import.meta.main) {
	main();
}
