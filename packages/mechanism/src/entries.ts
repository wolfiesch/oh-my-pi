import type { ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";

export type AgentMessage = Message | (Record<string, unknown> & { role: string });

export interface SessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp?: string;
}

export interface SessionMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

export interface ModelChangeEntry {
	type: "model_change";
	id: string;
	parentId: string | null;
	timestamp: string;
	model: string;
	role?: string;
}

export interface CustomMessageEntry<T = unknown> {
	type: "custom_message";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export interface SessionInitEntry {
	type: "session_init";
	id: string;
	parentId: string | null;
	timestamp: string;
	systemPrompt?: string;
	task?: string;
	tools?: string[];
}

export type MechFileEntry =
	| SessionHeader
	| SessionMessageEntry
	| ModelChangeEntry
	| CustomMessageEntry
	| SessionInitEntry;
