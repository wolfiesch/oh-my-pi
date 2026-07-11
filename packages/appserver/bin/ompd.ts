#!/usr/bin/env bun
import { createAppserver } from "../src/server.ts";
import { createAppserverAuthority, appserverLockCheck } from "@oh-my-pi/pi-coding-agent/session/appserver-authority";

const authority = createAppserverAuthority();
const appserver = createAppserver({ sessionAuthority: authority, discovery: authority, lockCheck: appserverLockCheck });
await appserver.start();
const stop = async () => { await appserver.stop(); process.exit(0); };
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise<void>(() => {});
