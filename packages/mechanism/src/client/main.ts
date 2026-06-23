import type { MechEvent } from "./events.js";
import { type HudInfo, Mechanism } from "./scene.js";

// --- minimal HUD (one corner; quiet, no card grid, no hero tiles) -----------
const hud = document.createElement("div");
hud.id = "hud";
hud.innerHTML = `
	<div class="hud-line"><span class="hud-label">Profile</span><span class="hud-value" id="hud-profile">-</span></div>
	<div class="hud-line"><span class="hud-label">Agents</span><span class="hud-value" id="hud-agents">0</span></div>
	<div class="hud-line"><span class="hud-label">Session Cost</span><span class="hud-value" id="hud-cost">$0.00</span></div>
	<div class="hud-line"><span class="hud-label">Tokens</span><span class="hud-value" id="hud-tokens">0</span></div>
`;
document.body.appendChild(hud);
const legendToggle = document.createElement("div");
legendToggle.id = "legend-toggle";
legendToggle.tabIndex = 0;
legendToggle.setAttribute("role", "button");
legendToggle.setAttribute("aria-label", "What the visualization shows");
legendToggle.textContent = "i";
document.body.appendChild(legendToggle);

const legendPanel = document.createElement("div");
legendPanel.id = "legend-panel";
legendPanel.innerHTML = `
	<h2>Mechanism Key</h2>
	<ul>
		<li><b>Center wheel + π</b> — harness/session pulse; not an agent.</li>
		<li><b>Rings</b> — recursion depth 0→3: main → nested subagents.</li>
		<li><b>Orb shape</b> — model family: icosphere Anthropic, compass-rose OpenAI, starburst Google (Gemini/Gemma), armillary GLM/z.ai, spindle Kimi, jack other/unclassified including DeepSeek, Qwen, and xAI.</li>
		<li><b>Orb brightness/spin/pulse</b> — status: bright pulsing running, dim idle, fainter parked, red flare aborted.</li>
		<li><b>Rim Platonic solids</b> — model lanes; size is that model's share of session cost.</li>
		<li><b>Transients</b> — radial strike tool call, glowing arc IRC message, dim radial drop subagent spawn.</li>
		<li><b>Hover an orb</b> — lineage to the main agent plus a line to its model lane.</li>
		<li><b>Drag / scroll</b> — orbit and zoom the orrery.</li>
		<li><b>Collapse</b> — idle/parked agents leave the ring and shrink into their parent; reappear on wake.</li>
		<li><b>Spin speed</b> — thinking depth (faster spin = deeper reasoning).</li>
		<li><b>Flash</b> — notice (blue info · orange warning · red error).</li>
		<li><b>Squeeze</b> — context compaction. <b>Flicker</b> — retry. <b>Flare</b> — model fallback.</li>
	</ul>
`;
document.body.appendChild(legendPanel);

const canvasContainer = document.createElement("div");
canvasContainer.id = "canvas-container";
document.body.appendChild(canvasContainer);

const elProfile = document.getElementById("hud-profile") as HTMLElement;
const elAgents = document.getElementById("hud-agents") as HTMLElement;
const elCost = document.getElementById("hud-cost") as HTMLElement;
const elTokens = document.getElementById("hud-tokens") as HTMLElement;

// No server meta endpoint in V1: take the profile from `?profile=` if present.
elProfile.textContent = new URLSearchParams(location.search).get("profile") || "-";

const fmtCost = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n >= 0.01 ? 3 : 4)}`);
const fmtTokens = (n: number): string => {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
};

function onHud(info: HudInfo): void {
	elAgents.textContent = String(info.agents);
	elCost.textContent = fmtCost(info.costUsd);
	elTokens.textContent = fmtTokens(info.tokens);
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
			mech.applyUsage(ev.model, ev.costUsd, ev.tokensIn, ev.tokensOut);
			break;
		case "compaction":
			mech.applyCompaction(ev.id, ev.phase);
			break;
		case "retry":
			mech.applyRetry(ev.id, ev.phase, ev.attempt);
			break;
		case "fallback":
			mech.applyFallback(ev.id, ev.fromModel, ev.toModel);
			break;
		case "thinking":
			mech.applyThinking(ev.id, ev.level);
			break;
		case "notice":
			mech.applyNotice(ev.id, ev.level);
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
