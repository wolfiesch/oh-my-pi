import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { IrcBus, type IrcMessage } from "../bus";

interface FakeSession {
	session: AgentSession;
	delivered: IrcMessage[];
	setError: (error: Error) => void;
}

function makeFakeSession(): FakeSession {
	let nextError: Error | null = null;
	const delivered: IrcMessage[] = [];
	const session = {
		deliverIrcMessage: async (msg: IrcMessage) => {
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			delivered.push(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		setError: error => {
			nextError = error;
		},
	};
}

describe("IrcBus delivery observers", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("notifies only for successful delivery or mailbox consumption and unsubscribes cleanly", async () => {
		const main = makeFakeSession();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: main.session });
		const scout = makeFakeSession();
		registry.register({ id: "Scout", displayName: "task", kind: "sub", session: scout.session });

		const observed: string[] = [];
		const unsubscribeThrowing = bus.onDelivered(() => {
			throw new Error("observer boom");
		});
		const unsubscribe = bus.onDelivered((from, to) => {
			observed.push(`${from}->${to}`);
		});

		await bus.send({ from: "Main", to: "Scout", body: "live" });
		expect(observed).toEqual(["Main->Scout"]);

		const waiting = bus.wait("Main", { from: "Scout" }, 1000);
		await bus.send({ from: "Scout", to: "Main", body: "waiter" });
		expect((await waiting)?.body).toBe("waiter");
		expect(observed).toEqual(["Main->Scout", "Scout->Main"]);

		main.setError(new Error("temporarily unavailable"));
		const failed = await bus.send({ from: "Scout", to: "Main", body: "pending wait" });
		expect(failed.outcome).toBe("failed");
		expect(observed).toHaveLength(2);

		expect((await bus.wait("Main", { from: "Scout" }, 5))?.body).toBe("pending wait");
		expect(observed).toEqual(["Main->Scout", "Scout->Main", "Scout->Main"]);

		main.setError(new Error("down one"));
		await bus.send({ from: "Scout", to: "Main", body: "one" });
		main.setError(new Error("down two"));
		await bus.send({ from: "Scout", to: "Main", body: "two" });
		expect(observed).toHaveLength(3);

		expect(bus.inbox("Main", { peek: true }).map(msg => msg.body)).toEqual(["one", "two"]);
		expect(observed).toHaveLength(3);
		expect(bus.inbox("Main").map(msg => msg.body)).toEqual(["one", "two"]);
		expect(observed).toEqual(["Main->Scout", "Scout->Main", "Scout->Main", "Scout->Main", "Scout->Main"]);

		const beforeUnsubscribe = [...observed];
		unsubscribe();
		unsubscribeThrowing();
		await bus.send({ from: "Main", to: "Scout", body: "after unsubscribe" });
		expect(observed).toEqual(beforeUnsubscribe);
	});
});
