#!/usr/bin/env bun
import { createAppserver } from "../src/server.ts";

const appserver = createAppserver();
await appserver.start();
const stop = async () => { await appserver.stop(); process.exit(0); };
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise<void>(() => {});
