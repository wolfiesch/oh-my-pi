/**
 * Provider branding utilities for the Auther dashboard.
 *
 * `resolveBrand` maps an auth-credential provider id to a stable presentation
 * descriptor (display name, brand colour, optional simple-icons slug).
 * `BrandLogo` renders the matching simple-icons glyph when one exists, and a
 * deterministic monogram otherwise so every credential card has an identity.
 *
 * Only the icons actually referenced are imported (named imports keep the
 * bundle to the brands we know about). Providers without a simple-icons entry
 * — OpenAI and Fastmail were removed upstream; z.ai/Kimi/MiniMax/Wafer/
 * Firecrawl never had one — resolve to a named monogram instead.
 */
import type { CSSProperties } from "react";
import {
	type SimpleIcon,
	siAnthropic,
	siBrave,
	siCloudflare,
	siElevenlabs,
	siGooglegemini,
	siNamecheap,
	siOpenrouter,
} from "simple-icons";

export interface ProviderBrand {
	brandId: string;
	name: string;
	simpleIconSlug?: string;
	color: string;
}

interface BrandDef {
	brandId: string;
	name: string;
	/** simple-icons glyph, when the package ships one for this brand. */
	icon?: SimpleIcon;
	/** Brand colour for icon-less brands; ignored when `icon` is present. */
	color?: string;
}

/** Canonical brand definitions keyed by `brandId`. */
const BRANDS: Record<string, BrandDef> = {
	anthropic: { brandId: "anthropic", name: "Anthropic", icon: siAnthropic },
	openai: { brandId: "openai", name: "OpenAI", color: "#10a37f" },
	googlegemini: { brandId: "googlegemini", name: "Google Gemini", icon: siGooglegemini },
	openrouter: { brandId: "openrouter", name: "OpenRouter", icon: siOpenrouter },
	cloudflare: { brandId: "cloudflare", name: "Cloudflare", icon: siCloudflare },
	namecheap: { brandId: "namecheap", name: "Namecheap", icon: siNamecheap },
	fastmail: { brandId: "fastmail", name: "Fastmail", color: "#0067b9" },
	elevenlabs: { brandId: "elevenlabs", name: "ElevenLabs", icon: siElevenlabs },
	brave: { brandId: "brave", name: "Brave", icon: siBrave },
	zai: { brandId: "zai", name: "Z.ai" },
	kimi: { brandId: "kimi", name: "Kimi" },
	minimax: { brandId: "minimax", name: "MiniMax" },
	wafer: { brandId: "wafer", name: "Wafer" },
	firecrawl: { brandId: "firecrawl", name: "Firecrawl" },
};

/** Provider id (normalized) → `brandId`. Many providers fold onto one brand. */
const PROVIDER_ALIASES: Record<string, string> = {
	anthropic: "anthropic",
	openai: "openai",
	"openai-codex": "openai",
	gemini: "googlegemini",
	"google-antigravity": "googlegemini",
	"google-gemini-cli": "googlegemini",
	openrouter: "openrouter",
	cloudflare: "cloudflare",
	namecheap: "namecheap",
	fastmail: "fastmail",
	elevenlabs: "elevenlabs",
	brave: "brave",
	zai: "zai",
	kimi: "kimi",
	"kimi-code": "kimi",
	minimax: "minimax",
	"minimax-code": "minimax",
	wafer: "wafer",
	firecrawl: "firecrawl",
};

/** Stable hue from a string so unknown brands keep a consistent colour. */
function deterministicColor(seed: string): string {
	let hash = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	const hue = (hash >>> 0) % 360;
	return `hsl(${hue} 62% 45%)`;
}

/** Title-case a normalized provider id for an unknown-brand display name. */
function humanize(normalized: string): string {
	const words = normalized.split(/[-_\s]+/).filter(Boolean);
	if (words.length === 0) return "Unknown";
	return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** First alphanumeric glyph of a brand name, used as the monogram fallback. */
function monogramOf(name: string): string {
	for (const ch of name) {
		if (/[a-z0-9]/i.test(ch)) return ch.toUpperCase();
	}
	return "?";
}

export function resolveBrand(provider: string): ProviderBrand {
	const normalized = provider.trim().toLowerCase();
	const brandId = PROVIDER_ALIASES[normalized];
	const def = brandId ? BRANDS[brandId] : undefined;
	if (def) {
		return {
			brandId: def.brandId,
			name: def.name,
			simpleIconSlug: def.icon?.slug,
			color: def.icon ? `#${def.icon.hex}` : (def.color ?? deterministicColor(def.brandId)),
		};
	}
	return {
		brandId: normalized || "unknown",
		name: humanize(normalized),
		color: deterministicColor(normalized || "unknown"),
	};
}

export interface BrandLogoProps {
	provider: string;
	/** Square edge length in px. */
	size?: number;
	className?: string;
}

export function BrandLogo({ provider, size = 24, className }: BrandLogoProps) {
	const brand = resolveBrand(provider);
	const icon = BRANDS[brand.brandId]?.icon;

	if (icon) {
		return (
			<svg
				role="img"
				aria-label={brand.name}
				viewBox="0 0 24 24"
				width={size}
				height={size}
				className={className}
				fill={brand.color}
			>
				<title>{brand.name}</title>
				<path d={icon.path} />
			</svg>
		);
	}

	const monogramStyle: CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: size,
		height: size,
		borderRadius: Math.round(size * 0.25),
		background: brand.color,
		color: "#fff",
		fontSize: Math.round(size * 0.5),
		fontWeight: 600,
		lineHeight: 1,
		userSelect: "none",
	};

	return (
		<span role="img" aria-label={brand.name} className={className} style={monogramStyle}>
			{monogramOf(brand.name)}
		</span>
	);
}
