import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AgentStatus, MechAgent } from "./events.js";
import {
	arcPoints,
	circleGeometry,
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

interface AgentNode {
	id: string;
	depth: number; // clamped ring index 0..MAX_DEPTH
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
	private readonly clock = new THREE.Clock();

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

		this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 600);
		this.camera.position.set(0, 46, 64);
		this.camera.lookAt(0, 0, 0);

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

		this.mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		this.reduced = this.mq.matches;
		this.mq.addEventListener("change", e => {
			this.reduced = e.matches;
		});

		window.addEventListener("resize", this.onResize);
		this.clock.start();
		requestAnimationFrame(this.loop);
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
		for (const id of [...this.nodes.keys()]) this.removeAgent(id);
		for (const a of agents) this.addAgent(a);
		this.emitHud();
	}

	applySpawn(agent: MechAgent): void {
		this.addAgent(agent);
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

	applyUsage(model: string, costUsd: number): void {
		const lane = this.ensureLane(model);
		if (lane) lane.cost += Math.max(0, costUsd);
		this.totalCost += Math.max(0, costUsd);
		this.recomputeShares();
		this.emitHud();
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
		const mesh = new THREE.LineSegments(nodeEdges(NODE_RADIUS), mat);
		group.add(mesh);
		this.scene.add(group);

		const node: AgentNode = {
			id: agent.id,
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
		};
		this.nodes.set(agent.id, node);
		this.buckets[depth].push(agent.id);
		this.reflow(depth);
		this.setStatus(node, agent.status);
		// New body accretes in: start dim, let the colour/intensity tween bring it up.
		node.cur.setHex(PALETTE.dim);
		node.intensity = 0.1;
	}

	private removeAgent(id: string): void {
		const n = this.nodes.get(id);
		if (!n) return;
		this.scene.remove(n.group);
		n.mesh.geometry.dispose();
		n.mat.dispose();
		this.nodes.delete(id);
		const bucket = this.buckets[n.depth];
		const i = bucket.indexOf(id);
		if (i >= 0) bucket.splice(i, 1);
		this.reflow(n.depth);
	}

	private reflow(depth: number): void {
		const bucket = this.buckets[depth];
		const count = bucket.length || 1;
		for (let i = 0; i < bucket.length; i++) {
			const n = this.nodes.get(bucket[i]);
			if (n) n.slotTarget = (i / count) * Math.PI * 2;
		}
	}

	private setStatus(n: AgentNode, status: AgentStatus): void {
		n.status = status;
		const s = STATUS_STYLE[status];
		n.base.setHex(s.color);
		n.intensityTarget = s.intensity;
		n.spinRate = s.spin;
		n.pulsing = s.pulse;
		if (status === "aborted") n.flare = 1; // flare red, then heal toward dim base
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

	// --- HUD ----------------------------------------------------------------
	private emitHud(): void {
		this.onHud({ agents: this.nodes.size, costUsd: this.totalCost });
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
			const angle = this.ringPhase[n.depth] + n.slot;
			const r = RING_RADII[n.depth];
			n.group.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);

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

			n.cur.lerp(n.base, ease);
			n.intensity += (n.intensityTarget - n.intensity) * ease;
			if (n.flare > 0) n.flare = Math.max(0, n.flare - dt / 1.4);
			const shown = n.cur.clone().multiplyScalar(n.intensity).lerp(FLARE_COLOR, n.flare);
			n.mat.color.copy(shown);
			n.mat.opacity = 0.35 + n.intensity * 0.65 + n.flare * 0.5;
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

		// Subtle camera breath (disabled under reduced motion).
		if (!reduced) {
			this.camera.position.x = Math.sin(t * 0.05) * 4;
			this.camera.position.y = 46 + Math.sin(t * 0.07) * 2;
			this.camera.lookAt(0, 0, 0);
		} else {
			this.camera.position.set(0, 46, 64);
			this.camera.lookAt(0, 0, 0);
		}

		this.composer.render();
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
		this.renderer.dispose();
	}
}
