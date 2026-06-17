import type { MechEvent } from "./events.js";
import { type HudInfo, Mechanism } from "./scene.js";

// --- minimal HUD (one corner; quiet, no card grid, no hero tiles) -----------
const hud = document.createElement("div");
hud.id = "hud";
hud.innerHTML = `
	<div class="hud-line"><span class="hud-label">Profile</span><span class="hud-value" id="hud-profile">-</span></div>
	<div class="hud-line"><span class="hud-label">Agents</span><span class="hud-value" id="hud-agents">0</span></div>
	<div class="hud-line"><span class="hud-label">Session Cost</span><span class="hud-value" id="hud-cost">$0.00</span></div>
`;
document.body.appendChild(hud);

const canvasContainer = document.createElement("div");
canvasContainer.id = "canvas-container";
document.body.appendChild(canvasContainer);

const elProfile = document.getElementById("hud-profile") as HTMLElement;
const elAgents = document.getElementById("hud-agents") as HTMLElement;
const elCost = document.getElementById("hud-cost") as HTMLElement;

// No server meta endpoint in V1: take the profile from `?profile=` if present.
elProfile.textContent = new URLSearchParams(location.search).get("profile") || "-";

const fmtCost = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n >= 0.01 ? 3 : 4)}`);

function onHud(info: HudInfo): void {
	elAgents.textContent = String(info.agents);
	elCost.textContent = fmtCost(info.costUsd);
}

// --- scene ------------------------------------------------------------------
const mech = new Mechanism(canvasContainer, onHud);

// --- live feed --------------------------------------------------------------
function apply(ev: MechEvent): void {
	switch (ev.t) {
		case "roster":
			mech.applyRoster(ev.agents);
			break;
		case "spawn":
			mech.applySpawn(ev.agent);
			break;
		case "status":
			mech.applyStatus(ev.id, ev.status);
			break;
		case "tool":
			mech.applyTool(ev.id, ev.tool, ev.phase);
			break;
		case "irc":
			mech.applyIrc(ev.from, ev.to);
			break;
		case "usage":
			mech.applyUsage(ev.model, ev.costUsd);
			break;
	}
}

const events = new EventSource("/events");
events.onmessage = msg => {
	try {
		apply(JSON.parse(msg.data) as MechEvent);
	} catch (err) {
		console.error("bad MechEvent", err, msg.data);
	}
};
events.onerror = () => {
	// EventSource auto-reconnects; the scene stays visible meanwhile.
	console.warn("SSE disconnected; awaiting reconnect");
};
