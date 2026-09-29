import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { offlineSdkFixture } from "./test/offline-sdk.js";

let fixture: Awaited<ReturnType<typeof offlineSdkFixture>>;
beforeEach(async () => { fixture = await offlineSdkFixture(); });
afterEach(async () => { await fixture.dispose(); });

describe("SDK background workflow regressions", () => {
	it("stops a failing chain before its next step is dispatched", async () => {
		await fixture.invoke("subagent", {
			chain: [{ agent: "offline", task: "failure" }, { agent: "offline", task: "should-not-start" }],
			background: true, saveAs: "failed-chain",
		});
		await fixture.waitFor("failed-chain", "error");
		expect(fixture.requests).toHaveLength(1);
	});

	it("retains successful members of a mixed background batch", async () => {
		await fixture.invoke("subagent", {
			tasks: [{ agent: "offline", task: "failure" }, { agent: "offline", task: "background-done" }],
			background: true, saveAs: "mixed-batch", notifyPerTask: false,
		});
		const result = await fixture.waitFor("mixed-batch", "done");
		expect(result.details.results[0].stopReason).toBe("error");
		expect(result.details.results[1].completionSignal).toBe("done");
	});

	it("can cancel immediately while child SDK creation is pending", async () => {
		await fixture.invoke("subagent", { agent: "offline", task: "slow", background: true, saveAs: "early-stop" });
		await fixture.invoke("subagent_stop", { id: "early-stop" });
		await fixture.waitFor("early-stop", "aborted");
		await fixture.shutdown();
		expect(fixture.requests).toHaveLength(0);
	});
});
