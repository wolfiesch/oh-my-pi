import * as THREE from "three";

// All structural geometry lives in the XZ plane (y = 0): the orrery is a flat
// astrolabe disc viewed from an elevated camera, so rings read as ellipses and
// the platonic solids float as featherlight 3D above it.

/** A closed circle drawn as a line loop in the XZ plane. */
export function circleGeometry(radius: number, segments = 160): THREE.BufferGeometry {
	const pts = new Float32Array(segments * 3);
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		pts[i * 3] = Math.cos(a) * radius;
		pts[i * 3 + 1] = 0;
		pts[i * 3 + 2] = Math.sin(a) * radius;
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
	return g;
}

/** Evenly spaced radial tick marks around a ring (compass graduations). */
export function tickGeometry(radius: number, count: number, len: number): THREE.BufferGeometry {
	const pts = new Float32Array(count * 2 * 3);
	for (let i = 0; i < count; i++) {
		const a = (i / count) * Math.PI * 2;
		const c = Math.cos(a);
		const s = Math.sin(a);
		const o = i * 6;
		pts[o] = c * radius;
		pts[o + 1] = 0;
		pts[o + 2] = s * radius;
		pts[o + 3] = c * (radius + len);
		pts[o + 4] = 0;
		pts[o + 5] = s * (radius + len);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
	return g;
}

/** The π glyph engraved on the great wheel, as line segments in the XZ plane. */
export function piGlyphGeometry(scale: number): THREE.BufferGeometry {
	// Local 2D coords (x horizontal, z vertical), top bar at +z. The bar overhangs
	// the legs (the defining feature of π); a small foot curls off the right leg.
	const w = 0.92; // top-bar half width
	const h = 0.78; // leg half height
	const lx = 0.4; // leg offset
	const seg: number[][] = [
		// top bar
		[-w, h],
		[w, h],
		// left leg (straight)
		[-lx, h],
		[-lx, -h],
		// right leg (straight)
		[lx, h],
		[lx, -h],
		// right-leg foot curl
		[lx, -h],
		[lx + 0.34, -h + 0.16],
	];
	const pts = new Float32Array(seg.length * 3);
	for (let i = 0; i < seg.length; i++) {
		pts[i * 3] = seg[i][0] * scale;
		pts[i * 3 + 1] = 0;
		// Negate z: the camera looks toward +Z, so local +z maps to screen-bottom.
		// Flipping keeps the π top-bar reading at the top of the screen.
		pts[i * 3 + 2] = -seg[i][1] * scale;
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
	return g;
}

export type PlatonicKind = "tetra" | "cube" | "octa" | "dodeca" | "icosa";

/** Ordered five solids — one slot per model lane. */
export const PLATONIC_ORDER: readonly PlatonicKind[] = ["tetra", "cube", "octa", "dodeca", "icosa"];

function solidGeometry(kind: PlatonicKind, radius: number): THREE.BufferGeometry {
	switch (kind) {
		case "tetra":
			return new THREE.TetrahedronGeometry(radius);
		case "cube": {
			const s = radius * 1.15;
			return new THREE.BoxGeometry(s, s, s);
		}
		case "octa":
			return new THREE.OctahedronGeometry(radius);
		case "dodeca":
			return new THREE.DodecahedronGeometry(radius);
		case "icosa":
			return new THREE.IcosahedronGeometry(radius);
	}
}

/** A platonic solid as a clean glowing wireframe (true edges, not triangulated). */
export function platonicEdges(kind: PlatonicKind, radius = 1): THREE.BufferGeometry {
	const solid = solidGeometry(kind, radius);
	const edges = new THREE.EdgesGeometry(solid, 1);
	solid.dispose();
	return edges;
}

/** A faceted spherical wireframe used for an agent body. */
export function nodeEdges(radius: number): THREE.BufferGeometry {
	const ico = new THREE.IcosahedronGeometry(radius, 1);
	const edges = new THREE.EdgesGeometry(ico, 1);
	ico.dispose();
	return edges;
}

/** A quadratic arc lifted above the disc plane, sampled as a polyline. */
export function arcPoints(from: THREE.Vector3, to: THREE.Vector3, lift: number, samples = 48): THREE.Vector3[] {
	const mid = from.clone().add(to).multiplyScalar(0.5);
	mid.y += from.distanceTo(to) * 0.25 + lift;
	const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
	return curve.getPoints(samples);
}
