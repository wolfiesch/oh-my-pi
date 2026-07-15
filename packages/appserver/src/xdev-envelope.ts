const XD_URL_PREFIX = "xd://";
const MAX_XDEV_CONTENT_BYTES = 128 * 1024;
const MAX_XDEV_TOOL_BYTES = 256;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function xdevToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	if (!name || /[/?#]/u.test(name) || encoder.encode(name).byteLength > MAX_XDEV_TOOL_BYTES) return undefined;
	return name;
}

function xdevTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const path = value.trim();
	if (!path.toLowerCase().startsWith(XD_URL_PREFIX)) return undefined;
	return xdevToolName(path.slice(XD_URL_PREFIX.length));
}

export interface XdevWriteCall {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Recognize a real v17 device dispatch from the outer write call. Invalid JSON,
 * help requests, and ordinary writes deliberately stay on the write path.
 */
export function xdevWriteCall(tool: unknown, value: unknown): XdevWriteCall | undefined {
	if (typeof tool !== "string" || tool.trim().toLowerCase() !== "write" || !isRecord(value)) return undefined;
	const target = xdevTarget(value.path);
	if (!target || typeof value.content !== "string") return undefined;
	if (encoder.encode(value.content).byteLength > MAX_XDEV_CONTENT_BYTES) return undefined;
	try {
		const args: unknown = JSON.parse(value.content);
		return isRecord(args) ? { tool: target, args } : undefined;
	} catch {
		return undefined;
	}
}

export interface XdevResultEnvelope {
	tool: string;
	mode: "execute";
	args: Record<string, unknown>;
	inner: unknown;
}

/** Parse only executable v17 envelopes. Help/documentation writes remain write results. */
export function xdevResultEnvelope(value: unknown): XdevResultEnvelope | undefined {
	if (!isRecord(value) || !isRecord(value.xdev)) return undefined;
	const xdev = value.xdev;
	const tool = xdevToolName(xdev.tool);
	if (!tool || xdev.mode !== "execute" || !isRecord(xdev.args)) return undefined;
	return { tool, mode: "execute", args: xdev.args, inner: xdev.inner };
}
