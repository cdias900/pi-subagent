import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { offlineSdkFixture } from "./test/offline-sdk.js";

let fixture: Awaited<ReturnType<typeof offlineSdkFixture>>;
beforeEach(async () => { fixture = await offlineSdkFixture(); });
afterEach(async () => { await fixture.dispose(); });

describe("SDK telemetry from real local-provider events", () => {
	it("records actual provider usage and the model context window", async () => {
		const result = await fixture.invoke("subagent", { agent: "offline", task: "hello" });
		expect(result.details.results[0]).toMatchObject({
			backend: "sdk", provider: "offline-test", model: "mock", contextWindow: 8192,
			usage: { input: 10, output: 5, turns: 1, cost: 0 },
		});
	});

	it("accumulates model/tool turns rather than overwriting their usage", async () => {
		fixture.agent("tools: read\n");
		const result = await fixture.invoke("subagent", { agent: "offline", task: "read-marker" });
		expect(result.details.results[0].usage).toMatchObject({ input: 20, output: 10, turns: 2 });
		expect(result.details.results[0].messages.filter((m: { role: string }) => m.role === "toolResult")).toHaveLength(1);
	});

	it("retains cumulative background usage across a question and reply", async () => {
		await fixture.invoke("subagent", { agent: "offline", task: "question", background: true, saveAs: "usage" });
		await fixture.waitFor("usage", "waiting");
		await fixture.invoke("subagent_steer", { id: "usage", message: "yes" });
		const result = await fixture.waitFor("usage", "done");
		expect(result.details.results[0].usage).toMatchObject({ input: 20, output: 10, turns: 2 });
	});
});
