#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { startServer } from "./server";

export * from "./api";
export * from "./oauth-sessions";
export * from "./server";

const DEFAULT_PORT = 3849;
const DEFAULT_BROKER_BIND = "127.0.0.1:8765";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string", short: "p", default: String(DEFAULT_PORT) },
			"broker-bind": { type: "string", default: DEFAULT_BROKER_BIND },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
	});

	if (values.help) {
		console.log(
			`omp-auther - OMP Auther — auth-broker control plane\n\n` +
				`Usage:\n  omp-auther [options]\n\n` +
				`Options:\n` +
				`  -p, --port <port>          Dashboard port (default ${DEFAULT_PORT})\n` +
				`      --broker-bind <addr>   Auth-broker bind address (default ${DEFAULT_BROKER_BIND})\n` +
				`  -h, --help                 Show this help message\n`,
		);
		return;
	}

	const rawPort = typeof values.port === "string" ? values.port : String(DEFAULT_PORT);
	const port = Number(rawPort);
	if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid --port value: ${rawPort}`);
	}
	const brokerBind = typeof values["broker-bind"] === "string" ? values["broker-bind"] : DEFAULT_BROKER_BIND;

	const handle = await startServer({ port, brokerBind });
	console.log(`OMP Auther dashboard at: http://127.0.0.1:${handle.port}`);
	console.log(`Auth-broker bind:        ${handle.brokerUrl}`);
	console.log("Press Ctrl+C to stop\n");
	const shutdown = () => {
		handle.stop();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

if (import.meta.main) {
	main();
}
