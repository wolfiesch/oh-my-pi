#!/usr/bin/env bun
import { runAppserverServe } from "./appserver-cli";
import { createAppserverAuthority, appserverLockCheck } from "../session/appserver-authority";
import { createAppserver } from "@oh-my-pi/appserver";

const authority = createAppserverAuthority();
await runAppserverServe({ createAppserver: () => createAppserver({ sessionAuthority: authority, discovery: authority, lockCheck: appserverLockCheck }) });
