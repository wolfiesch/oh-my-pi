import * as THREE from "three";

// Palette tokens. Light IS the lines: every value here is a stroke colour on the
// ink-black field. Warm gold is the locked default; swap `accent`/`accentBright`
// to retheme (e.g. cyan) without touching geometry.
export const PALETTE = {
	background: 0x050505,
	// Structural line art (rings, wheel, glyph) — quiet single-weight strokes.
	structure: 0x6b5a2c,
	structureBright: 0xb89645,
	// Agent / lane accent.
	accent: 0xe5c158,
	accentBright: 0xffdf7a,
	// Cold dim — idle bodies and the resting line.
	dim: 0x4a3d1e,
	// The one reserved state-change accent: a failure flares, then heals.
	flare: 0xff4d3d,
	// Inter-agent message pulse.
	pulse: 0xfff2c4,
} as const;

export const colour = (hex: number): THREE.Color => new THREE.Color(hex);

// A bright additive line material that bloom picks up. One instance per element
// so brightness / opacity can be tweened independently.
export function lineMaterial(hex: number, opacity = 1): THREE.LineBasicMaterial {
	return new THREE.LineBasicMaterial({
		color: hex,
		transparent: true,
		opacity,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
	});
}
