import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AgentStatus, MechAgent } from "./events.js";
import {
	arcPoints,
	circleGeometry,
	type FamilyKey,
	familyGeometry,
	familyKeyFromToken,
	nodeEdges,
	PLATONIC_ORDER,
	piGlyphGeometry,
	platonicEdges,
	tickGeometry,
} from "./geometry.js";
import { colour, lineMaterial, PALETTE } from "./theme.js";

// --- layout constants -------------------------------------------------------
const RING_RADII = [11, 19, 27, 35] as const; // recursion depths 0..3
const MAX_DEPTH = RING_RADII.length - 1;
const LANE_RADIUS = 45; // platonic solids orbit beyond the depth rings
const SOLID_MIN = 1.4;
const SOLID_RANGE = 3.2;
const NODE_RADIUS = 1.0;

const FLARE_COLOR = colour(PALETTE.flare);

const familyGeometries = new Map<FamilyKey, THREE.BufferGeometry>();

function geometryForFamily(family: FamilyKey): THREE.BufferGeometry {
	let geometry = familyGeometries.get(family);
	if (!geometry) {
		geometry = familyGeometry(family, NODE_RADIUS);
		familyGeometries.set(family, geometry);
	}
	return geometry;
}

interface AgentNode {
	id: string;
	depth: number; // clamped ring index 0..MAX_DEPTH
	parentId: string | null;
	model: string;
	family: FamilyKey;
	status: AgentStatus;
	group: THREE.Group;
	mesh: THREE.LineSegments;
	mat: THREE.LineBasicMaterial;
	slot: number; // current angular offset within the ring
	slotTarget: number;
	spin: number; // accumulated self-rotation
	pulse: number; // pulse phase
	base: THREE.Color; // steady colour for the current status
	cur: THREE.Color; // tweened colour actually shown
	intensity: number; // current brightness multiplier
	intensityTarget: number;
	flare: number; // 0..1 red mix, decays to 0
	spinRate: number;
	pulsing: boolean;
	collapse: number; // 0 = normal position, 1 = collapsed into parent
	collapseTarget: number; // tween target: 0 or 1
	compacting: number; // 0..1 compaction visual intensity, decays
	retrying: number; // 0..1 retry stutter intensity, decays
	noticeFlash: number; // 0..1 notice flash, decays
	noticeColor: number; // hex color for notice
}

interface Lane {
	model: string | null;
	cost: number;
	mesh: THREE.LineSegments;
	mat: THREE.LineBasicMaterial;
	group: THREE.Group;
	scale: number;
	scaleTarget: number;
	spinX: number;
	spinY: number;
}

interface Transient {
	obj: THREE.Object3D;
	age: number;
	life: number;
	update: (p: number, reduced: boolean) => void;
	dispose: () => void;
}

export interface HudInfo {
	agents: number;
	costUsd: number;
	tokens: number;
}

const STATUS_STYLE: Record<AgentStatus, { color: number; intensity: number; spin: number; pulse: boolean }> = {
	running: { color: PALETTE.accentBright, intensity: 1.0, spin: 1.6, pulse: true },
	idle: { color: PALETTE.accent, intensity: 0.55, spin: 0.35, pulse: false },
	parked: { color: PALETTE.dim, intensity: 0.35, spin: 0.0, pulse: false },
	aborted: { color: PALETTE.dim, intensity: 0.3, spin: 0.0, pulse: false },
};

export class Mechanism {
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly camera: THREE.PerspectiveCamera;
	private readonly composer: EffectComposer;
	private readonly bloom: UnrealBloomPass;
	private readonly controls: OrbitControls;
	private readonly raycaster = new THREE.Raycaster();
	private readonly pointer = new THREE.Vector2(10, 10);
	private readonly pickTargets: THREE.LineSegments[] = [];
	private hoverGroup: THREE.Group | null = null;
	private hoveredId: string | null = null;
	private readonly clock = new THREE.Clock();
	/** Scratch vectors reused per frame to avoid per-node allocations. */
	private readonly _scratchVec = new THREE.Vector3();
	private readonly _scratchColor = new THREE.Color();

	private readonly wheel = new THREE.Group();
	private wheelSpeed = 0.05;
	private wheelSpeedTarget = 0.05;

	private readonly ringPhase = [0, 0, 0, 0];
	private readonly ringSpeed = [0.12, -0.09, 0.07, -0.05];

	private readonly nodes = new Map<string, AgentNode>();
	private readonly buckets: string[][] = [[], [], [], []];
	private readonly lanes: Lane[] = [];
	private readonly laneByModel = new Map<string, number>();
	private totalCost = 0;

	private totalTokens = 0;
	private readonly transients: Transient[] = [];
	private reduced = false;
	private running = true;
	private readonly onHud: (info: HudInfo) => void;
	private readonly mq: MediaQueryList;

	constructor(container: HTMLElement, onHud: (info: HudInfo) => void) {
		this.onHud = onHud;

		this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.setClearColor(PALETTE.background, 1);
		container.appendChild(this.renderer.domElement);

		this.installDebugHook();

		this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 600);
		this.camera.position.set(0, 46, 64);
		this.camera.lookAt(0, 0, 0);

		this.mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		this.reduced = this.mq.matches;

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enablePan = false;
		this.controls.minDistance = 36;
		this.controls.maxDistance = 140;
		this.controls.minPolarAngle = 0.15;
		this.controls.maxPolarAngle = 1.05;
		this.controls.target.set(0, 0, 0);
		this.controls.dampingFactor = 0.08;
		this.controls.autoRotateSpeed = 0.3;
		this.configureControlsForMotion();
		this.controls.addEventListener("start", () => {
			this.controls.autoRotate = false;
		});
		this.raycaster.params.Line = { threshold: 0.6 };

		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		this.bloom = new UnrealBloomPass(
			new THREE.Vector2(window.innerWidth, window.innerHeight),
			0.85, // strength
			0.6, // radius
			0.12, // threshold
		);
		this.composer.addPass(this.bloom);
		this.composer.addPass(new OutputPass());

		this.scene.add(this.wheel);
		this.buildStructure();

		this.mq.addEventListener("change", e => {
			this.reduced = e.matches;
			this.configureControlsForMotion();
		});
		this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
		this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
		window.addEventListener("resize", this.onResize);
		this.clock.start();
		requestAnimationFrame(this.loop);
	}

	private configureControlsForMotion(): void {
		this.controls.enabled = !this.reduced;
		this.controls.enableDamping = !this.reduced;
		this.controls.autoRotate = !this.reduced;
	}

	private installDebugHook(): void {
		(
			window as Window & {
				__mechDebug?: {
					agents: () => { id: string; family: FamilyKey; vertices: number }[];
				};
			}
		).__mechDebug = {
			agents: () =>
				[...this.nodes.values()].map(n => ({
					id: n.id,
					family: n.family,
					vertices: n.mesh.geometry.getAttribute("position").count,
				})),
		};
	}

	// --- static structure ---------------------------------------------------
	private buildStructure(): void {
		// Central great wheel: concentric engraved circles + graduations + π glyph.
		for (const r of [3.1, 5.0, 6.8]) {
			const c = new THREE.LineLoop(circleGeometry(r), lineMaterial(PALETTE.structureBright, 0.7));
			this.wheel.add(c);
		}
		this.wheel.add(new THREE.LineSegments(tickGeometry(6.8, 48, 0.9), lineMaterial(PALETTE.structure, 0.6)));
		this.wheel.add(new THREE.LineSegments(piGlyphGeometry(2.0), lineMaterial(PALETTE.accentBright, 1.0)));

		// Depth rings: quiet concentric orbits, brighter the closer to the core.
		for (let d = 0; d <= MAX_DEPTH; d++) {
			const op = 0.5 - d * 0.08;
			const ring = new THREE.LineLoop(circleGeometry(RING_RADII[d]), lineMaterial(PALETTE.structure, op));
			this.scene.add(ring);
			this.scene.add(
				new THREE.LineSegments(tickGeometry(RING_RADII[d], 36, 0.5), lineMaterial(PALETTE.structure, op * 0.7)),
			);
		}

		// Five platonic-solid model lanes orbiting at the rim.
		for (let i = 0; i < PLATONIC_ORDER.length; i++) {
			const a = (i / PLATONIC_ORDER.length) * Math.PI * 2;
			const group = new THREE.Group();
			group.position.set(Math.cos(a) * LANE_RADIUS, 0, Math.sin(a) * LANE_RADIUS);
			const mat = lineMaterial(PALETTE.structureBright, 0.6);
			const mesh = new THREE.LineSegments(platonicEdges(PLATONIC_ORDER[i], 1), mat);
			mesh.scale.setScalar(SOLID_MIN);
			group.add(mesh);
			this.scene.add(group);
			this.lanes.push({
				model: null,
				cost: 0,
				mesh,
				mat,
				group,
				scale: SOLID_MIN,
				scaleTarget: SOLID_MIN,
				spinX: 0.15 + i * 0.04,
				spinY: 0.2 - i * 0.03,
			});
		}
	}

	// --- event bindings -----------------------------------------------------
	applyRoster(agents: MechAgent[]): void {
		const present = new Set<string>();
		for (const agent of agents) {
			present.add(agent.id);
			const existing = this.nodes.get(agent.id);
			if (existing) this.updateAgent(existing, agent);
			else this.addAgent(agent);
		}
		for (const id of [...this.nodes.keys()]) {
			if (!present.has(id)) this.removeAgent(id);
		}
		this.emitHud();
	}

	applySpawn(agent: MechAgent): void {
		this.addAgent(agent);
		const parent = agent.parentId ? this.nodes.get(agent.parentId) : null;
		const child = this.nodes.get(agent.id);
		if (parent && child) this.spawnUmbilical(parent.group.position.clone(), child.group.position.clone());
		this.emitHud();
	}

	applyStatus(id: string, status: AgentStatus): void {
		const n = this.nodes.get(id);
		if (!n) return;
		this.setStatus(n, status);
	}

	applyTool(id: string, _tool: string, phase: "start" | "update" | "end"): void {
		if (phase === "end") return; // strike on the construction's opening stroke
		const n = this.nodes.get(id);
		if (!n) return;
		this.spawnToolStrike(n.group.position.clone());
	}

	applyIrc(from: string, to: string): void {
		const a = this.nodes.get(from);
		const b = this.nodes.get(to);
		if (!a || !b) return;
		this.spawnArc(a.group.position.clone(), b.group.position.clone());
	}

	applyUsage(model: string, costUsd: number, tokensIn: number, tokensOut: number): void {
		const lane = this.ensureLane(model);
		if (lane) lane.cost += Math.max(0, costUsd);
		this.totalCost += Math.max(0, costUsd);
		this.totalTokens += Math.max(0, tokensIn) + Math.max(0, tokensOut);
		this.recomputeShares();
		this.emitHud();
	}

	applyCompaction(id: string, phase: "start" | "end"): void {
		const n = this.nodes.get(id);
		if (!n) return;
		n.compacting = phase === "start" ? 1.0 : 0.5; // start = full, end = brief pulse
	}

	applyRetry(id: string, phase: "start" | "end", _attempt?: number): void {
		const n = this.nodes.get(id);
		if (!n) return;
		n.retrying = phase === "start" ? 1.0 : 0;
	}

	applyFallback(id: string, _fromModel: string, _toModel: string): void {
		const n = this.nodes.get(id);
		if (!n) return;
		// The model/family change will come through applyRoster; just flash
		n.flare = 0.8;
	}

	applyThinking(id: string, level: string): void {
		const n = this.nodes.get(id);
		if (!n) return;
		// Map thinking levels to spin speed multipliers
		const levels: Record<string, number> = {
			off: 0.2,
			none: 0.2,
			minimal: 0.5,
			low: 0.8,
			medium: 1.6,
			high: 2.4,
			xhigh: 3.2,
		};
		n.spinRate = levels[level] ?? 1.6;
	}

	applyNotice(id: string, level: "info" | "warning" | "error"): void {
		const n = this.nodes.get(id);
		if (!n) return;
		const colors: Record<string, number> = { info: PALETTE.accentBright, warning: 0xffa500, error: PALETTE.flare };
		n.noticeColor = colors[level] ?? PALETTE.flare;
		n.noticeFlash = 1.0;
	}

	// --- agents -------------------------------------------------------------
	private addAgent(agent: MechAgent): void {
		if (this.nodes.has(agent.id)) {
			this.setStatus(this.nodes.get(agent.id)!, agent.status);
			return;
		}
		const depth = Math.max(0, Math.min(MAX_DEPTH, agent.depth));
		const group = new THREE.Group();
		const mat = lineMaterial(PALETTE.accent, 1);
		const family = familyKeyFromToken(agent.family);
		const mesh = new THREE.LineSegments(geometryForFamily(family), mat);
		group.add(mesh);
		this.scene.add(group);
		mesh.userData.agentId = agent.id;

		const node: AgentNode = {
			id: agent.id,
			parentId: agent.parentId,
			model: agent.model,
			family,
			depth,
			status: agent.status,
			group,
			mesh,
			mat,
			slot: 0,
			slotTarget: 0,
			spin: Math.random() * Math.PI * 2,
			pulse: Math.random() * Math.PI * 2,
			base: colour(PALETTE.accent),
			cur: colour(PALETTE.accent),
			intensity: 0.55,
			intensityTarget: 0.55,
			flare: 0,
			spinRate: 0.35,
			pulsing: false,
			collapse: 0,
			collapseTarget: 0,
			compacting: 0,
			retrying: 0,
			noticeFlash: 0,
			noticeColor: 0,
		};
		this.nodes.set(agent.id, node);
		this.buckets[depth].push(agent.id);
		this.pickTargets.push(mesh);
		this.reflow(depth);
		this.setStatus(node, agent.status);
		// New body accretes in: start dim, let the colour/intensity tween bring it up.
		node.cur.setHex(PALETTE.dim);
		this.placeNode(node, node.slotTarget);
		node.intensity = 0.1;
	}

	private updateAgent(node: AgentNode, agent: MechAgent): void {
		const nextDepth = Math.max(0, Math.min(MAX_DEPTH, agent.depth));
		if (node.depth !== nextDepth) {
			const previousBucket = this.buckets[node.depth];
			const previousIndex = previousBucket.indexOf(node.id);
			if (previousIndex >= 0) previousBucket.splice(previousIndex, 1);
			const previousDepth = node.depth;
			node.depth = nextDepth;
			this.buckets[nextDepth].push(node.id);
			this.reflow(previousDepth);
			this.reflow(nextDepth);
		}

		const nextFamily = familyKeyFromToken(agent.family);
		if (node.family !== nextFamily) {
			node.family = nextFamily;
			node.mesh.geometry = geometryForFamily(nextFamily);
		}

		node.parentId = agent.parentId;
		node.model = agent.model;
		this.setStatus(node, agent.status);
	}

	private removeAgent(id: string): void {
		const n = this.nodes.get(id);
		if (!n) return;
		this.scene.remove(n.group);
		n.mat.dispose();
		this.nodes.delete(id);
		const bucket = this.buckets[n.depth];
		const i = bucket.indexOf(id);
		const targetIndex = this.pickTargets.indexOf(n.mesh);
		this.clearHoverGroup();
		if (targetIndex >= 0) this.pickTargets.splice(targetIndex, 1);
		if (this.hoveredId === id) this.hoveredId = null;
		if (i >= 0) bucket.splice(i, 1);
		this.reflow(n.depth);
	}

	private reflow(depth: number): void {
		const bucket = this.buckets[depth];
		const active = bucket.filter(id => {
			const n = this.nodes.get(id);
			return n && n.status !== "idle" && n.status !== "parked";
		});
		const count = active.length || 1;
		for (let i = 0; i < active.length; i++) {
			const n = this.nodes.get(active[i]);
			if (n) n.slotTarget = (i / count) * Math.PI * 2;
		}
	}

	private placeNode(n: AgentNode, slot: number): void {
		const angle = this.ringPhase[n.depth] + slot;
		const r = RING_RADII[n.depth];
		n.group.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
	}

	private setStatus(n: AgentNode, status: AgentStatus): void {
		n.status = status;
		const s = STATUS_STYLE[status];
		n.base.setHex(s.color);
		n.intensityTarget = s.intensity;
		n.spinRate = s.spin;
		n.pulsing = s.pulse;
		if (n.id !== "Main") {
			n.collapseTarget = status === "idle" || status === "parked" ? 1 : 0;
		}
		this.reflow(n.depth);
		if (status === "aborted") n.flare = 1; // flare red, then heal toward dim base
	}

	// --- HUD ----------------------------------------------------------------
	private emitHud(): void {
		this.onHud({ agents: this.nodes.size, costUsd: this.totalCost, tokens: this.totalTokens });
	}

	// --- transients ---------------------------------------------------------
	private spawnToolStrike(origin: THREE.Vector3): void {
		const dir = origin.lengthSq() > 1e-3 ? origin.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
		const len = 2.4;
		const far = origin.clone().add(dir.clone().multiplyScalar(len));

		const lineMat = lineMaterial(PALETTE.accentBright, 1);
		const lineGeo = new THREE.BufferGeometry().setFromPoints([origin.clone(), origin.clone()]);
		const line = new THREE.Line(lineGeo, lineMat);

		const compassMat = lineMaterial(PALETTE.accent, 1);
		const compass = new THREE.LineLoop(circleGeometry(0.7, 40), compassMat);
		compass.position.copy(far);

		const group = new THREE.Group();
		group.add(line, compass);
		this.scene.add(group);

		const pos = lineGeo.getAttribute("position") as THREE.BufferAttribute;
		this.transients.push({
			obj: group,
			age: 0,
			life: 0.7,
			update: (p, reduced) => {
				const draw = reduced ? 1 : Math.min(1, p / 0.45);
				const tip = origin.clone().lerp(far, draw);
				pos.setXYZ(1, tip.x, tip.y, tip.z);
				pos.needsUpdate = true;
				const fade = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
				lineMat.opacity = fade;
				compassMat.opacity = draw * fade;
				compass.scale.setScalar(0.2 + draw * 0.8);
			},
			dispose: () => {
				lineGeo.dispose();
				lineMat.dispose();
				compass.geometry.dispose();
				compassMat.dispose();
			},
		});
	}

	private spawnUmbilical(from: THREE.Vector3, to: THREE.Vector3): void {
		const mat = lineMaterial(PALETTE.structureBright, 1);
		const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), from.clone()]);
		const line = new THREE.Line(geo, mat);
		this.scene.add(line);
		const pos = geo.getAttribute("position") as THREE.BufferAttribute;

		this.transients.push({
			obj: line,
			age: 0,
			life: 0.7,
			update: (p, reduced) => {
				const draw = reduced ? 1 : Math.min(1, p / 0.35);
				const tip = from.clone().lerp(to, draw);
				pos.setXYZ(1, tip.x, tip.y, tip.z);
				pos.needsUpdate = true;
				mat.opacity = 1 - p;
			},
			dispose: () => {
				geo.dispose();
				mat.dispose();
			},
		});
	}

	private spawnArc(from: THREE.Vector3, to: THREE.Vector3): void {
		const pts = arcPoints(from, to, 2.5, 56);
		const n = pts.length;
		const trailMat = lineMaterial(PALETTE.pulse, 0.5);
		const trailGeo = new THREE.BufferGeometry().setFromPoints(pts);
		const trail = new THREE.Line(trailGeo, trailMat);
		trail.geometry.setDrawRange(0, 2);

		const beadMat = lineMaterial(PALETTE.pulse, 1);
		const bead = new THREE.LineSegments(nodeEdges(0.55), beadMat);
		bead.position.copy(pts[0]);

		const group = new THREE.Group();
		group.add(trail, bead);
		this.scene.add(group);

		this.transients.push({
			obj: group,
			age: 0,
			life: 0.85,
			update: (p, reduced) => {
				if (reduced) {
					trail.geometry.setDrawRange(0, n);
					bead.position.copy(pts[n - 1]);
					beadMat.opacity = 1 - p;
					trailMat.opacity = 0.5 * (1 - p);
					return;
				}
				const idx = Math.min(n - 1, Math.floor(p * (n - 1)));
				trail.geometry.setDrawRange(0, idx + 1);
				bead.position.copy(pts[idx]);
				beadMat.opacity = 1 - p * 0.4;
				trailMat.opacity = 0.5 * (1 - p);
			},
			dispose: () => {
				trailGeo.dispose();
				trailMat.dispose();
				bead.geometry.dispose();
				beadMat.dispose();
			},
		});
	}

	private makeHoverLine(from: THREE.Vector3, to: THREE.Vector3, color: number, opacity: number): THREE.Line {
		return new THREE.Line(
			new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]),
			lineMaterial(color, opacity),
		);
	}

	private clearHoverGroup(): void {
		if (!this.hoverGroup) return;
		this.scene.remove(this.hoverGroup);
		for (const child of this.hoverGroup.children) {
			if (child instanceof THREE.Line) {
				child.geometry.dispose();
				if (Array.isArray(child.material)) for (const mat of child.material) mat.dispose();
				else child.material.dispose();
			}
		}
		this.hoverGroup = null;
	}

	private renderHoverTethers(): void {
		this.clearHoverGroup();
		if (!this.hoveredId) return;
		const hovered = this.nodes.get(this.hoveredId);
		if (!hovered) return;
		const group = new THREE.Group();
		let child = hovered;
		while (child.parentId) {
			const parent = this.nodes.get(child.parentId);
			if (!parent) break;
			group.add(this.makeHoverLine(child.group.position, parent.group.position, PALETTE.structureBright, 0.75));
			child = parent;
		}
		const laneIndex = this.laneByModel.get(hovered.model);
		if (laneIndex !== undefined) {
			group.add(this.makeHoverLine(hovered.group.position, this.lanes[laneIndex].group.position, PALETTE.dim, 0.65));
		}
		if (group.children.length === 0) return;
		this.hoverGroup = group;
		this.scene.add(group);
	}

	// --- model lanes --------------------------------------------------------
	private ensureLane(model: string): Lane | null {
		const existing = this.laneByModel.get(model);
		if (existing !== undefined) return this.lanes[existing];
		// Bind to the next free solid; if all bound, fold onto an existing slot.
		let idx = this.lanes.findIndex(l => l.model === null);
		if (idx < 0) idx = this.laneByModel.size % this.lanes.length;
		this.lanes[idx].model = model;
		this.laneByModel.set(model, idx);
		return this.lanes[idx];
	}

	private recomputeShares(): void {
		const total = this.totalCost || 1;
		for (const lane of this.lanes) {
			const share = lane.cost / total;
			lane.scaleTarget = SOLID_MIN + share * SOLID_RANGE;
		}
	}

	// --- frame loop ---------------------------------------------------------
	private loop = (): void => {
		if (!this.running) return;
		requestAnimationFrame(this.loop);
		const dt = Math.min(0.05, this.clock.getDelta());
		const t = this.clock.elapsedTime;
		const reduced = this.reduced;
		const ease = reduced ? 1 : 1 - Math.exp(-dt * 4);

		// Great wheel quickens when any agent is running.
		const active = [...this.nodes.values()].some(n => n.status === "running");
		this.wheelSpeedTarget = active ? 0.28 : 0.05;
		this.wheelSpeed += (this.wheelSpeedTarget - this.wheelSpeed) * ease;
		if (!reduced) this.wheel.rotation.y += this.wheelSpeed * dt;

		// Depth rings drift.
		if (!reduced) for (let d = 0; d <= MAX_DEPTH; d++) this.ringPhase[d] += this.ringSpeed[d] * dt;

		// Agents.
		for (const n of this.nodes.values()) {
			n.slot += (n.slotTarget - n.slot) * ease;
			n.collapse += (n.collapseTarget - n.collapse) * ease * 0.5; // slower tween

			if (n.collapse > 0.01 && n.parentId) {
				const parent = this.nodes.get(n.parentId);
				if (parent) {
					const angle = this.ringPhase[n.depth] + n.slot;
					const r = RING_RADII[n.depth];
					this._scratchVec.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
					n.group.position.lerpVectors(this._scratchVec, parent.group.position, n.collapse);
				} else {
					this.placeNode(n, n.slot);
				}
			} else {
				this.placeNode(n, n.slot);
			}

			if (!reduced) {
				n.spin += n.spinRate * dt;
				n.mesh.rotation.set(n.spin * 0.6, n.spin, 0);
				if (n.pulsing) {
					n.pulse += dt * 4;
					n.mesh.scale.setScalar(1 + Math.sin(n.pulse) * 0.12);
				} else {
					n.mesh.scale.setScalar(1);
				}
			} else {
				n.mesh.scale.setScalar(1);
			}

			const collapseScale = 1 - n.collapse * 0.98; // shrink to 2% at full collapse
			n.mesh.scale.multiplyScalar(collapseScale);

			n.cur.lerp(n.base, ease);
			n.intensity += (n.intensityTarget - n.intensity) * ease;
			if (n.flare > 0) n.flare = Math.max(0, n.flare - dt / 1.4);
			if (n.compacting > 0) {
				n.compacting = Math.max(0, n.compacting - dt / 1.2);
				// Scale squeeze effect
				n.mesh.scale.multiplyScalar(1 - n.compacting * 0.3);
			}
			if (n.noticeFlash > 0) {
				n.noticeFlash = Math.max(0, n.noticeFlash - dt / 0.8);
				n.cur.lerp(this._scratchColor.setHex(n.noticeColor), n.noticeFlash * 0.6);
			}
			this._scratchColor.copy(n.cur).multiplyScalar(n.intensity).lerp(FLARE_COLOR, n.flare);
			n.mat.color.copy(this._scratchColor);
			n.mat.opacity = (0.35 + n.intensity * 0.65 + n.flare * 0.5) * (1 - n.collapse * 0.95);
			if (n.retrying > 0) {
				n.retrying = Math.max(0, n.retrying - dt / 2.0);
				// Rapid flicker
				const flicker = Math.sin(t * 30) * 0.5 + 0.5;
				n.mat.opacity *= 0.5 + flicker * 0.5;
			}
		}

		// Lanes.
		for (const lane of this.lanes) {
			lane.scale += (lane.scaleTarget - lane.scale) * ease;
			lane.mesh.scale.setScalar(lane.scale);
			if (!reduced) {
				lane.mesh.rotation.x += lane.spinX * dt;
				lane.mesh.rotation.y += lane.spinY * dt;
				const a = t * 0.02 + this.lanes.indexOf(lane) * ((Math.PI * 2) / this.lanes.length);
				lane.group.position.set(Math.cos(a) * LANE_RADIUS, 0, Math.sin(a) * LANE_RADIUS);
			}
			lane.mat.color.setHex(lane.model ? PALETTE.accent : PALETTE.structureBright);
		}

		// Transients.
		for (let i = this.transients.length - 1; i >= 0; i--) {
			const tr = this.transients[i];
			tr.age += dt;
			const p = Math.min(1, tr.age / tr.life);
			tr.update(p, reduced);
			if (tr.age >= tr.life) {
				this.scene.remove(tr.obj);
				tr.dispose();
				this.transients.splice(i, 1);
			}
		}

		if (!reduced) {
			this.controls.update();
		} else {
			this.camera.position.set(0, 46, 64);
			this.camera.lookAt(0, 0, 0);
		}
		this.updateHovered();
		this.renderHoverTethers();

		this.composer.render();
	};

	private updateHovered(): void {
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const hit = this.raycaster.intersectObjects(this.pickTargets, false)[0];
		this.hoveredId = typeof hit?.object.userData.agentId === "string" ? hit.object.userData.agentId : null;
	}

	private onPointerMove = (ev: PointerEvent): void => {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
	};

	private onPointerLeave = (): void => {
		this.pointer.set(10, 10);
	};

	private onResize = (): void => {
		const w = window.innerWidth;
		const h = window.innerHeight;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h);
		this.composer.setSize(w, h);
		this.bloom.setSize(w, h);
	};

	dispose(): void {
		this.running = false;
		window.removeEventListener("resize", this.onResize);
		this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
		this.renderer.domElement.removeEventListener("pointerleave", this.onPointerLeave);
		this.clearHoverGroup();
		this.controls.dispose();
		this.renderer.dispose();
	}
}
