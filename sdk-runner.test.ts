import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createSdkChild, resolveSdkProjectTrust } from "./sdk-runner.js";
import { createChildModuleLoader } from "./sdk-extensions.js";
import { offlineSdkFixture } from "./test/offline-sdk.js";
import type { AgentConfig } from "./agents.js";
import type { ResolvedModelConfig } from "./model-resolution.js";

const model: ResolvedModelConfig = { model: "offline-test/mock", thinkingLevel: "off", modelSource: "parent", source: "parent" };
const agent: AgentConfig = { name: "offline", description: "Local fixture", source: "user", filePath: "/fixture/offline.md", systemPrompt: "ROLE_MARKER" };
let fixture: Awaited<ReturnType<typeof offlineSdkFixture>>;
beforeEach(async () => { fixture = await offlineSdkFixture(); });
afterEach(async () => { await fixture.dispose(); });

const extensionSource = `export default function (pi) {
	pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nEXTENSION_MARKER" }));
}`;
const systemPrompt = () => String(fixture.requests.at(-1)?.messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "");

async function invokeAgent(params: object = { agent: "offline", task: "hello" }, signal?: AbortSignal) {
	return fixture.invoke("subagent", params, signal);
}

describe("one in-process SDK execution path", () => {
	it("creates an ephemeral child and captures typed read events", async () => {
		const events: string[] = [];
		const child = await createSdkChild({ cwd: fixture.cwd, agent: { ...agent, tools: ["read"] }, resolvedModel: model, onEvent(event) { events.push(event.type); } });
		try {
			expect(child.session.sessionFile).toBeUndefined();
			await child.prompt("read-marker");
			expect(events).toContain("tool_execution_start");
			expect(events).toContain("tool_execution_end");
			expect(child.session.getSessionStats().assistantMessages).toBe(2);
		} finally { await child.dispose(); }
	});

	it("preserves omitted, empty, and background-only tool lists", async () => {
		for (const [tools, backgroundInstruction, expected] of [
			[undefined, undefined, ["read", "bash", "edit", "write"]],
			[[], undefined, []],
			[[], "Call __bg_signal at the end", ["__bg_signal"]],
		] as const) {
			const child = await createSdkChild({ cwd: fixture.cwd, agent: { ...agent, tools: tools ? [...tools] : undefined }, resolvedModel: model, backgroundInstruction, onEvent() {} });
			try { expect(child.session.getActiveToolNames()).toEqual(expected); }
			finally { await child.dispose(); }
		}
	});

	it("runs the actual subagent tool and returns SDK metadata", async () => {
		const result = await invokeAgent();
		expect(result.content[0].text).toBe("Offline parity: café 🚀");
		expect(result.details.results[0]).toMatchObject({ backend: "sdk", exitCode: 0, stopReason: "stop" });
	});

	it("executes allowed reads and writes in the child's cwd", async () => {
		fixture.agent("tools: [read, write]\n");
		expect((await invokeAgent({ agent: "offline", task: "read-marker" })).content[0].text).toBe("Read completed");
		expect((await invokeAgent({ agent: "offline", task: "write-marker" })).content[0].text).toBe("Write completed");
		expect(readFileSync(join(fixture.cwd, "written.txt"), "utf8")).toBe("written-content");
	});

	it("keeps parallel results and expands a chain's previous output", async () => {
		const parallel = await invokeAgent({ tasks: [{ agent: "offline", task: "one" }, { agent: "offline", task: "two" }] });
		expect(parallel.content[0].text).toContain("2/2 succeeded");
		expect(parallel.details.results.every((r: { backend: string; exitCode: number }) => r.backend === "sdk" && r.exitCode === 0)).toBe(true);
		const chain = await invokeAgent({ chain: [{ agent: "offline", task: "one" }, { agent: "offline", task: "use {previous}" }] });
		expect(chain.details.results).toHaveLength(2);
		expect(JSON.stringify(fixture.requests.at(-1))).toContain("Offline parity: café 🚀");
	});

	it("preserves strict parameterized input validation before SDK setup", async () => {
		fixture.agent("parameters:\n  type: object\n  properties:\n    topic: { type: string }\n  required: [topic]\n", "typed");
		await invokeAgent({ agent: "typed", input: { topic: "input-marker" } });
		expect(JSON.stringify(fixture.requests.at(-1))).toContain("input-marker");
		const count = fixture.requests.length;
		await expect(invokeAgent({ agent: "typed", input: {} })).rejects.toThrow("Input validation failed");
		expect(fixture.requests).toHaveLength(count);
	});

	it("keeps the project-agent consent gate before SDK dispatch", async () => {
		const dir = join(fixture.cwd, ".pi", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "project.md"), "---\nname: project\ndescription: Project fixture\ntools: []\n---\nPROJECT_ROLE\n");
		await expect(invokeAgent({ agent: "project", task: "hello", agentScope: "both" })).rejects.toThrow("explicit opt-in");
		expect(fixture.requests).toHaveLength(0);
		await invokeAgent({ agent: "project", task: "hello", agentScope: "both", confirmProjectAgents: false });
		expect(systemPrompt()).toContain("PROJECT_ROLE");
	});

	it("composes discovered APPEND, role and context once and preserves replace isolation", async () => {
		mkdirSync(join(fixture.cwd, ".pi"));
		writeFileSync(join(fixture.agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND");
		writeFileSync(join(fixture.cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND");
		writeFileSync(join(fixture.cwd, "AGENTS.md"), "CONTEXT_MARKER");
		new ProjectTrustStore(fixture.agentDir).set(fixture.cwd, true);
		await invokeAgent();
		const prompt = systemPrompt();
		expect(prompt).not.toContain("GLOBAL_APPEND");
		for (const marker of ["PROJECT_APPEND", "ROLE_MARKER", "CONTEXT_MARKER"]) expect(prompt.split(marker)).toHaveLength(2);
		expect(prompt.indexOf("PROJECT_APPEND")).toBeLessThan(prompt.indexOf("ROLE_MARKER"));
		expect(prompt.indexOf("ROLE_MARKER")).toBeLessThan(prompt.indexOf("CONTEXT_MARKER"));
		fixture.agent("systemPromptMode: replace\nextensions: fixture\n");
		fixture.extension("fixture", extensionSource);
		await invokeAgent();
		expect(systemPrompt()).toContain("EXTENSION_MARKER");
		for (const marker of ["GLOBAL_APPEND", "PROJECT_APPEND", "CONTEXT_MARKER"]) expect(systemPrompt()).not.toContain(marker);
	});

	it("uses saved/default trust rather than the parent's temporary decision", async () => {
		mkdirSync(join(fixture.cwd, ".pi"));
		writeFileSync(join(fixture.cwd, ".pi", "SYSTEM.md"), "UNTRUSTED_MARKER");
		expect(resolveSdkProjectTrust(fixture.cwd, fixture.agentDir)).toBe(false);
		await invokeAgent();
		expect(systemPrompt()).not.toContain("UNTRUSTED_MARKER");
		new ProjectTrustStore(fixture.agentDir).set(fixture.cwd, true);
		await invokeAgent();
		expect(systemPrompt()).toContain("UNTRUSTED_MARKER");
	});

	it("resolves frontmatter and invocation models in the same SDK path", async () => {
		fixture.agent("model: offline-test/mock-alt\n");
		await invokeAgent(); expect(fixture.requests.at(-1)?.model).toBe("mock-alt");
		await invokeAgent({ agent: "offline", task: "hello", model: "offline-test/mock" });
		expect(fixture.requests.at(-1)?.model).toBe("mock");
	});

	it("loads selected and symlinked extensions without a sidecar", async () => {
		const source = join(fixture.root, "linked-extension"); mkdirSync(source);
		writeFileSync(join(source, "index.ts"), extensionSource);
		symlinkSync(source, join(fixture.agentDir, "extensions", "buildkite"));
		fixture.agent("extensions: buildkite\n");
		const result = await invokeAgent();
		expect(result.details.results[0].backend).toBe("sdk");
		expect(systemPrompt()).toContain("EXTENSION_MARKER");
	});

	it("gives simultaneous children independent extension module state", async () => {
		fixture.extension("counter", `let count = 0; export default function(pi) {
			pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nCHILD_COUNT:" + (++count) }));
		}`);
		fixture.agent("extensions: counter\n");
		await invokeAgent({ tasks: [{ agent: "offline", task: "one" }, { agent: "offline", task: "two" }] });
		for (const request of fixture.requests) expect(JSON.stringify(request)).toContain("CHILD_COUNT:1");
	});

	it("fails before dispatch when an explicitly requested extension is absent", async () => {
		await expect(invokeAgent({ agent: "offline", task: "hello", extensions: ["not-installed"] })).rejects.toThrow("is not installed");
		expect(fixture.requests).toHaveLength(0);
	});

	it("binds command-based credentials to the target cwd without changing the parent", async () => {
		const target = join(fixture.root, "other"); mkdirSync(target);
		const configPath = join(fixture.agentDir, "models.json");
		const original = readFileSync(configPath, "utf8");
		const config = JSON.parse(original); config.providers["offline-test"].apiKey = "!pwd";
		writeFileSync(configPath, JSON.stringify(config));
		const parentCwd = process.cwd();
		const result = await invokeAgent({ agent: "offline", task: "hello", cwd: target });
		expect(result.details.results[0].backend).toBe("sdk");
		expect(fixture.requests.at(-1)?.authorization).toContain("/other");
		expect(process.cwd()).toBe(parentCwd);
		expect(JSON.parse(readFileSync(configPath, "utf8")).providers["offline-test"].apiKey).toBe("!pwd");
	});

	it("propagates terminal model failures and preserves successful parallel siblings", async () => {
		const result = await invokeAgent({ tasks: [{ agent: "offline", task: "failure" }, { agent: "offline", task: "hello" }] });
		expect(result.content[0].text).toContain("1/2 succeeded");
		expect(result.details.results[0].stopReason).toBe("error");
		expect(result.details.results[1].stopReason).toBe("stop");
	});

	it("retries a transient model error and uses the final stop reason", async () => {
		writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
		const result = await invokeAgent({ agent: "offline", task: "retry-once" });
		expect(result.details.results[0].stopReason).toBe("stop");
		expect(fixture.requests).toHaveLength(2);
	});

	it("aborts a running foreground SDK session", async () => {
		const controller = new AbortController();
		const pending = invokeAgent({ agent: "offline", task: "slow" }, controller.signal);
		while (!fixture.requests.length) await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort(); await expect(pending).rejects.toThrow("Subagent was aborted");
	});

	it("blocks a stopped child at the last async prompt-preflight boundary", async () => {
		const path = fixture.extension("delayed", `export default function (pi) { pi.on("input", async () => { await new Promise(r => setTimeout(r, 100)); return { action: "continue" }; }); }`);
		const child = await createSdkChild({ cwd: fixture.cwd, agent, resolvedModel: model, extensionPaths: [path], onEvent() {} });
		try {
			const pending = child.prompt("hello"); await new Promise((resolve) => setTimeout(resolve, 10));
			await child.abort(); await expect(pending).rejects.toThrow("Subagent was aborted");
			expect(fixture.requests).toHaveLength(0);
		} finally { await child.dispose(); }
	});

	it("completes an implicit background end and resumes a question in the same session", async () => {
		await invokeAgent({ agent: "offline", task: "hello", background: true, saveAs: "implicit" });
		await fixture.waitFor("implicit", "done");
		fixture.extension("fixture", extensionSource); fixture.agent("extensions: fixture\n");
		await invokeAgent({ agent: "offline", task: "question", background: true, saveAs: "question" });
		await fixture.waitFor("question", "waiting");
		await fixture.invoke("subagent_steer", { id: "question", message: "yes" });
		const done = await fixture.waitFor("question", "done");
		expect(done.details.results[0].backend).toBe("sdk");
	});

	it("runs extension-backed background parallel and chain groups", async () => {
		fixture.extension("fixture", extensionSource); fixture.agent("extensions: fixture\n");
		await invokeAgent({ tasks: [{ agent: "offline", task: "background-done one" }, { agent: "offline", task: "background-done two" }], background: true, saveAs: "parallel", notifyPerTask: false });
		await fixture.waitFor("parallel", "done");
		await invokeAgent({ chain: [{ agent: "offline", task: "background-done one" }, { agent: "offline", task: "background-done {previous}" }], background: true, saveAs: "chain", notifyPerTask: false });
		const done = await fixture.waitFor("chain", "done"); expect(done.details.results).toHaveLength(2);
	});

	it("interrupts and replaces a background prompt", async () => {
		await invokeAgent({ agent: "offline", task: "slow", background: true, saveAs: "interrupt" });
		while (!fixture.requests.length) await new Promise((resolve) => setTimeout(resolve, 10));
		await fixture.invoke("subagent_steer", { id: "interrupt", message: "yes", interrupt: true });
		await fixture.waitFor("interrupt", "done");
	});

	it("does not resurrect a child stopped while interruption is in flight", async () => {
		await invokeAgent({ agent: "offline", task: "slow", background: true, saveAs: "stopped" });
		while (!fixture.requests.length) await new Promise((resolve) => setTimeout(resolve, 10));
		const steering = fixture.invoke("subagent_steer", { id: "stopped", message: "yes", interrupt: true });
		await fixture.invoke("subagent_stop", { id: "stopped" }); await steering;
		await fixture.waitFor("stopped", "aborted");
		expect(fixture.notices.some((n) => n.includes("DONE from stopped"))).toBe(false);
	});

	it("rejects a mixed background signal/write batch before a write or another model call", async () => {
		fixture.agent("tools: write\n");
		await invokeAgent({ agent: "offline", task: "mixed-signal", background: true, saveAs: "mixed" });
		await fixture.waitFor("mixed", "error");
		expect(existsSync(join(fixture.cwd, "unwanted.txt"))).toBe(false); expect(fixture.requests).toHaveLength(1);
	});

	it("awaits child cleanup on parent shutdown", async () => {
		await invokeAgent({ agent: "offline", task: "slow", background: true, saveAs: "shutdown" });
		while (!fixture.requests.length) await new Promise((resolve) => setTimeout(resolve, 10));
		await fixture.shutdown(); expect((await fixture.invoke("subagent_status", {})).content[0].text).toBe("No background agents.");
		expect(fixture.notices.some((n) => n.includes("DONE from shutdown"))).toBe(false);
	});

	it("drives a real Pi parent tool call with no alternative child engine", async () => {
		const result = await new Promise<{ code: number | null; text: string; stderr: string }>((resolve, reject) => {
			const proc = spawn("pi", ["--mode", "json", "-p", "--no-session", "--no-extensions", "-e", join(import.meta.dirname, "index.ts"), "--tools", "subagent", "--model", "offline-test/mock", "--thinking", "off", "delegate"], { cwd: fixture.cwd, env: { ...process.env, PI_TELEMETRY: "0" }, stdio: ["ignore", "pipe", "pipe"] });
			const out: Buffer[] = [], err: Buffer[] = [];
			const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Pi parent timed out")); }, 15000);
			proc.stdout.on("data", (data: Buffer) => out.push(data)); proc.stderr.on("data", (data: Buffer) => err.push(data));
			proc.once("error", (error) => { clearTimeout(timer); reject(error); });
			proc.once("close", (code) => { clearTimeout(timer); resolve({ code, text: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
		});
		expect(result.code, result.stderr).toBe(0); expect(result.text).toContain("Parent saw child"); expect(result.text).toContain('"backend":"sdk"');
	}, 20000);

	it("uses one SDK path in production without routing or agent process launching", () => {
		const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
		for (const removed of ["selectAgentBackend", "sdk-isolated", "PI_SUBAGENT_BACKEND", "spawn(", "SDK_SIDECAR_PATH"]) expect(source).not.toContain(removed);
	});

	it.skipIf(process.env.PI_SUBAGENT_BENCH !== "1")("benchmarks identical offline workloads", async () => {
		for (const withExtension of [false, true]) {
			if (withExtension) { fixture.extension("fixture", extensionSource); fixture.agent("extensions: fixture\n"); }
			for (const parallel of [1, 4]) {
				const samples: number[] = [];
				for (let run = -1; run < 10; run++) {
					const start = performance.now();
					await invokeAgent(parallel === 1 ? { agent: "offline", task: "hello" } : { tasks: Array.from({ length: parallel }, () => ({ agent: "offline", task: "hello" })) });
					if (run >= 0) samples.push(performance.now() - start);
				}
				const sorted = samples.sort((a, b) => a - b);
				console.log(`SDK_BENCH ${JSON.stringify({ withExtension, parallel, samples: sorted.length, medianMs: Math.round(sorted[5]), p95Ms: Math.round(sorted.at(-1)!), processRssMiB: Math.round(process.memoryUsage().rss / 1048576) })}`);
			}
		}
	}, 30000);
});

describe("real extension compatibility", () => {
	it.skipIf(!process.env.PI_SUBAGENT_BUILDKITE_EXTENSION_PATH)("keeps concurrent Buildkite calls' abort signals independent", async () => {
		const path = process.env.PI_SUBAGENT_BUILDKITE_EXTENSION_PATH!;
		const first = await createChildModuleLoader().import<{ setSignal(s: AbortSignal): void; listPipelines(search: string): Promise<unknown> }>(join(dirname(path), "api.ts"));
		const second = await createChildModuleLoader().import<typeof first>(join(dirname(path), "api.ts"));
		const previousFetch = globalThis.fetch, previousToken = process.env.BUILDKITE_TOKEN;
		const a = new AbortController(), b = new AbortController(), seen: Array<AbortSignal | null | undefined> = [];
		process.env.BUILDKITE_TOKEN = "local-fixture";
		globalThis.fetch = async (_url, options) => { seen.push(options?.signal); return new Response("[]", { status: 200 }); };
		try {
			first.setSignal(a.signal); const p1 = first.listPipelines("first");
			second.setSignal(b.signal); const p2 = second.listPipelines("second");
			await Promise.all([p1, p2]); expect(seen).toEqual([a.signal, b.signal]);
		} finally { globalThis.fetch = previousFetch; if (previousToken === undefined) delete process.env.BUILDKITE_TOKEN; else process.env.BUILDKITE_TOKEN = previousToken; }
	});

	it.skipIf(!process.env.PI_SUBAGENT_GATEWAY_EXTENSION_PATH)("loads the real Tool Gateway extension with simultaneous SDK children against a local MCP fixture", async () => {
		let sessionNumber = 0;
		const listedSessions: string[] = [];
		const gateway = createServer(async (req, res) => {
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const sessionId = input.method === "initialize" ? `fixture-session-${++sessionNumber}` : String(req.headers["mcp-session-id"] ?? "");
			if (input.method === "tools/list") listedSessions.push(sessionId);
			res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionId });
			const result = input.method === "tools/list" ? { tools: [{ name: "mock_ping", description: "Local test", inputSchema: { type: "object", properties: {} } }] } : { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } };
			res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
		});
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const address = gateway.address(); if (!address || typeof address === "string") throw new Error("Expected TCP port");
		process.env.TOOL_GATEWAY_MCP_URL = `http://127.0.0.1:${address.port}/mcp`; process.env.PI_TOOL_GATEWAY_CONFIG_DIR = join(fixture.root, "gateway-config");
		symlinkSync(dirname(process.env.PI_SUBAGENT_GATEWAY_EXTENSION_PATH!), join(fixture.agentDir, "extensions", "pi-tool-gateway-extension"));
		fixture.agent("tools: tool_gateway_search_tools\nextensions: pi-tool-gateway-extension\n");
		try {
			const results = await invokeAgent({ tasks: [{ agent: "offline", task: "gateway-fixture one" }, { agent: "offline", task: "gateway-fixture two" }] });
			for (const result of results.details.results) { expect(result.backend).toBe("sdk"); expect(JSON.stringify(result.messages)).toContain("Gateway usable"); }
			expect(new Set(listedSessions).size).toBe(2);
		} finally { gateway.closeAllConnections(); await new Promise<void>((resolve) => gateway.close(() => resolve())); }
	}, 15000);
});
