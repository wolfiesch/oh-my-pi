import { describe, expect, test } from "bun:test";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SessionQueueEntryNotFoundError, SessionQueueService } from "../src/session/session-queue-service";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function queuedAgent(steering: AgentMessage[], followUp: AgentMessage[]): Agent {
	return {
		peekSteeringQueue: () => steering,
		peekFollowUpQueue: () => followUp,
		replaceQueues: (nextSteering: AgentMessage[], nextFollowUp: AgentMessage[]) => {
			steering = nextSteering;
			followUp = nextFollowUp;
		},
	} as unknown as Agent;
}

describe("SessionQueueService", () => {
	test("keeps stable non-serialized identities while exposing row/displayable/pending skew", () => {
		const prompt = user("ship it");
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "check race",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		const service = new SessionQueueService(queuedAgent([advisor, prompt], []), () => 1);
		const first = service.snapshot();
		const second = service.snapshot();
		expect(first.steering[0]?.entryId).toBe(second.steering[0]?.entryId);
		expect(JSON.stringify(prompt)).not.toContain(first.steering[0]?.entryId);
		expect(first).toMatchObject({ rowCount: 1, displayableCount: 2, pendingCount: 3, pendingNextTurnCount: 1 });
	});

	test("removes a prompt with its hidden companion and rejects the stale id", () => {
		const companion: AgentMessage = {
			role: "custom",
			customType: "image-attachment-description",
			content: "hidden",
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
		const service = new SessionQueueService(queuedAgent([companion, user("one"), user("two")], []), () => 0);
		const id = service.snapshot().steering[0]!.entryId;
		expect(service.remove(id).snapshot.steering.map(entry => entry.text)).toEqual(["two"]);
		expect(() => service.remove(id)).toThrow(SessionQueueEntryNotFoundError);
	});

	test("reorders user rows without dropping advisor cards and lane-clear preserves them", () => {
		const advisor: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "advice",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		const agent = queuedAgent([user("one"), advisor, user("two")], []);
		const service = new SessionQueueService(agent, () => 0);
		const second = service.snapshot().steering[1]!.entryId;
		expect(service.reorder(second, 0).steering.map(entry => entry.text)).toEqual(["two", "one"]);
		const cleared = service.clear({ lane: "steering" });
		expect(cleared.steering.map(entry => entry.text)).toEqual(["two", "one"]);
		expect(agent.peekSteeringQueue()).toEqual([advisor]);
	});
});
