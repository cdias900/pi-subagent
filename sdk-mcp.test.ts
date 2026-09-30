import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ProjectTrustStore, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { createSdkChild, resolveSdkProjectTrust } from "./sdk-runner.js";
import { loadScopedMcpServers } from "./sdk-mcp.js";
import { offlineSdkFixture } from "./test/offline-sdk.js";
import type { AgentConfig } from "./agents.js";
import type { ResolvedModelConfig } from "./model-resolution.js";

const agent: AgentConfig = { name: "mcp", description: "Local MCP test", source: "user", filePath: "/fixture/mcp.md", systemPrompt: "Read-only local test" };
const model: ResolvedModelConfig = { model: "offline-test/mock", thinkingLevel: "off", modelSource: "parent", source: "parent" };
let fixture: Awaited<ReturnType<typeof offlineSdkFixture>>;
beforeEach(async () => { fixture = await offlineSdkFixture(); });
afterEach(async () => { await fixture.dispose(); });
const childOptions = () => ({ cwd: fixture.cwd, agent, resolvedModel: model, onEvent() {} });
const config = (mcpServers: object) => writeFileSync(join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers }));
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 4000;
	while (!predicate() && Date.now() < deadline) await delay();
	expect(predicate()).toBe(true);
}

/** Loopback-only protocol fixture: no credentials, remote services or persistent writes. */
async function httpFixture() {
	const calls: Array<{ method: string; authorization?: string }> = [];
	const server = createServer(async (req, res) => {
		if (req.method === "GET") { res.writeHead(405); res.end(); return; }
		if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (request.id === undefined) { res.writeHead(202); res.end(); return; }
		calls.push({ method: request.method, authorization: req.headers.authorization });
		const result = request.method === "initialize"
			? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } }
			: request.method === "tools/list"
				? { tools: ["ping", "private", "get_info"].map((name) => ({ name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: { value: { type: "string" } } } })) }
				: request.method === "resources/list"
					? { resources: [{ uri: "fixture://text", name: "Fixture text" }] }
					: request.method === "resources/templates/list" ? { resourceTemplates: [] }
						: request.method === "resources/read" ? { contents: [{ uri: "fixture://text", mimeType: "text/plain", text: "native-resource-content" }] }
							: { content: [{ type: "text", text: "mcp-fixture-response" }] };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP port");
	return { calls, url: `http://127.0.0.1:${address.port}/mcp`, async dispose() {
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	} };
}

function stdioScript() {
	const require = createRequire(import.meta.url);
	const script = join(fixture.root, "stdio-mcp.mjs");
	writeFileSync(script, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(fixture.root, "connected-mcp.pid"))}, String(process.pid));
import { Server } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/index.js")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/types.js")).href)};
const server = new Server({name: "fixture", version: "1"}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, () => ({tools: [{name: "ping", inputSchema: {type: "object", properties: {value: {type: "string"}}}}]}));
server.setRequestHandler(CallToolRequestSchema, () => ({content: [{type: "text", text: process.cwd() + ':' + process.env.FIXTURE_SECRET}]}));
await server.connect(new StdioServerTransport());
`);
	return script;
}

describe("native scoped MCP", () => {
	it("selects raw native entries only, without old bridge or flat config", () => {
		writeFileSync(join(fixture.root, "mcp.json"), JSON.stringify({ alpha: { command: "ignored" } }));
		expect(loadScopedMcpServers([], fixture.agentDir)).toEqual({});
		expect(() => loadScopedMcpServers(["alpha"], fixture.agentDir)).toThrow("is not configured");
		config({ alpha: { type: "streamable-http", url: "http://127.0.0.1:1", oauth: { clientId: "fixture" }, timeout: 10 }, invalid: {}, disabled: { command: "ignored", enabled: false } });
		expect(Object.keys(loadScopedMcpServers(["alpha", "alpha"], fixture.agentDir))).toEqual(["alpha"]);
		expect(loadScopedMcpServers(["alpha"], fixture.agentDir).alpha).toMatchObject({ type: "streamable-http", oauth: { clientId: "fixture" }, timeout: 10 });
		expect(() => loadScopedMcpServers(["disabled"], fixture.agentDir)).toThrow("is disabled");
		writeFileSync(join(fixture.agentDir, "mcp.json"), JSON.stringify({ alpha: {} }));
		expect(() => loadScopedMcpServers(["alpha"], fixture.agentDir)).toThrow("expected an mcpServers object");
	});

	it.each([{}, { type: "sse", url: "http://127.0.0.1:1" }, { command: "node", exposure: "invalid" }])("delegates invalid selected protocol config to native registration: %j", async (entry) => {
		config({ alpha: entry, ignored: {} });
		await expect(createSdkChild({ ...childOptions(), mcpServers: loadScopedMcpServers(["alpha"], fixture.agentDir) })).rejects.toThrow("Child Pi setup failed");
		expect(fixture.requests).toHaveLength(0);
	});

	it("merges only the trusted target project's entries", () => {
		config({ alpha: { url: "http://127.0.0.1:1" } });
		mkdirSync(join(fixture.cwd, ".pi"));
		writeFileSync(join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: "project-command" }, quick: { command: "quick-command" } } }));
		expect(resolveSdkProjectTrust(fixture.cwd, fixture.agentDir)).toBe(false);
		expect(loadScopedMcpServers(["alpha"], fixture.agentDir, fixture.cwd, false).alpha).toEqual({ url: "http://127.0.0.1:1" });
		expect(() => loadScopedMcpServers(["quick"], fixture.agentDir, fixture.cwd, false)).toThrow("is not configured");
		new ProjectTrustStore(fixture.agentDir).set(fixture.cwd, true);
		expect(resolveSdkProjectTrust(fixture.cwd, fixture.agentDir)).toBe(true);
		expect(loadScopedMcpServers(["alpha"], fixture.agentDir, fixture.cwd, true).alpha).toEqual({ command: "project-command" });
		const other = join(fixture.root, "other"); mkdirSync(other);
		expect(loadScopedMcpServers(["alpha"], fixture.agentDir, other, true).alpha).toEqual({ url: "http://127.0.0.1:1" });
	});

	it("never inherits configured servers when mcps is omitted, or connects unselected entries", async () => {
		const http = await httpFixture();
		config({ alpha: { url: http.url }, ignored: { url: http.url } });
		try {
			const empty = await createSdkChild(childOptions());
			try { await empty.prompt("hello"); expect(http.calls).toHaveLength(0); expect(empty.session.getAllTools().some((t) => t.name.startsWith("mcp__"))).toBe(false); }
			finally { await empty.dispose(); }
			const selected = await createSdkChild({ ...childOptions(), mcpServers: loadScopedMcpServers(["alpha"], fixture.agentDir) });
			try { await selected.prompt("hello"); expect(http.calls.filter((c) => c.method === "initialize")).toHaveLength(1); }
			finally { await selected.dispose(); }
		} finally { await http.dispose(); }
	});

	it("preserves trusted project autoEnableCodemode and excludes other child extensions' servers", async () => {
		const http = await httpFixture();
		config({ alpha: { url: http.url }, ignored: { url: http.url } });
		// Global opts out, but the trusted child project opts back in.
		writeFileSync(join(fixture.agentDir, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: { alpha: { url: http.url } } }));
		const path = fixture.extension("extra-mcp", `export default function(pi) { pi.registerMcpServer("extra", {url: ${JSON.stringify(http.url)}}); }`);
		const selected = loadScopedMcpServers(["alpha"], fixture.agentDir, fixture.cwd, false);
		const child = await createSdkChild({ ...childOptions(), extensionPaths: [path], mcpServers: selected });
		try {
			await child.prompt("hello");
			expect(http.calls.filter((c) => c.method === "initialize")).toHaveLength(1);
			expect(child.session.getActiveToolNames()).not.toContain("codemode");
			expect(child.session.getAllTools().some((t) => t.name.startsWith("mcp__extra__"))).toBe(false);
		} finally { await child.dispose(); }
		mkdirSync(join(fixture.cwd, ".pi"));
		writeFileSync(join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ autoEnableCodemode: true, mcpServers: {} }));
		new ProjectTrustStore(fixture.agentDir).set(fixture.cwd, true);
		const projectChild = await createSdkChild({ ...childOptions(), mcpServers: loadScopedMcpServers(["alpha"], fixture.agentDir, fixture.cwd, true) });
		try { await projectChild.prompt("mcp-codemode"); expect(projectChild.session.getActiveToolNames()).toContain("codemode"); }
		finally { await projectChild.dispose(); await http.dispose(); }
	}, 15000);

	it.each(["direct", "codemode", "codemode-deferred", "deferred", "hidden"] as const)("honors native %s exposure and per-tool overrides", async (exposure) => {
		const http = await httpFixture();
		const child = await createSdkChild({ ...childOptions(), mcpServers: { alpha: { url: http.url, exposure, toolExposure: { private: "hidden", "get_*": "codemode", get_info: "direct" } } } });
		try {
			await child.prompt("hello"); // Native first-prompt startup wait, not custom ready polling.
			const tools = child.session.getAllTools();
			expect(tools.find((t) => t.name === "mcp__alpha__private")?.exposure).toBe("hidden");
			expect(tools.find((t) => t.name === "mcp__alpha__get_info")?.exposure).toBe("direct");
			expect(child.session.getActiveToolNames()).toContain("mcp__alpha__get_info");
			if (exposure === "hidden") {
				expect(tools.find((t) => t.name === "mcp__alpha__ping")?.exposure).toBe("hidden");
				expect(child.session.getActiveToolNames()).not.toContain("mcp__alpha__ping");
				await child.prompt("mcp-fixture");
				expect(http.calls.filter((c) => c.method === "tools/call")).toHaveLength(0);
				expect(child.session.messages.some((m) => m.role === "toolResult" && m.toolName === "mcp__alpha__ping" && m.isError)).toBe(true);
			} else {
				if (exposure !== "direct") expect(child.session.getActiveToolNames()).not.toContain("mcp__alpha__ping");
				await child.prompt(exposure === "direct" ? "mcp-fixture" : exposure === "deferred" ? "mcp-search" : "mcp-codemode");
				expect(http.calls.filter((c) => c.method === "tools/call")).toHaveLength(1);
				expect(JSON.stringify(child.session.messages)).toContain("mcp-fixture-response");
			}
		} finally { await child.dispose(); await http.dispose(); }
	}, 15000);

	it("expands native auth headers and reads resources in concurrent isolated sessions", async () => {
		const http = await httpFixture();
		const envBefore = { ...process.env };
		const cwdBefore = process.cwd();
		const children = await Promise.all([1, 2].map(() => createSdkChild({ ...childOptions(), mcpServers: { alpha: { url: http.url, exposure: "direct", headers: { Authorization: "Bearer ${PI_OFFLINE}" } } } })));
		try {
			await Promise.all(children.map((child) => child.prompt("mcp-fixture")));
			await Promise.all(children.map((child) => child.prompt("mcp-resource")));
			expect(http.calls.filter((c) => c.method === "initialize")).toHaveLength(2);
			expect(http.calls.filter((c) => c.method === "tools/call")).toHaveLength(2);
			expect(http.calls.filter((c) => c.method === "resources/read")).toHaveLength(2);
			expect(http.calls.every((c) => c.authorization === "Bearer 1")).toBe(true);
			for (const child of children) expect(JSON.stringify(child.session.messages)).toContain("native-resource-content");
			expect(process.env).toEqual(envBefore); expect(process.cwd()).toBe(cwdBefore);
		} finally { await Promise.all(children.map((child) => child.dispose())); await http.dispose(); }
	}, 15000);

	it("binds native HTTP credential commands to each child's cwd without process mutation", async () => {
		const http = await httpFixture();
		const cwdBefore = process.cwd();
		const children = [];
		try {
			for (const name of ["first", "second"]) {
				const cwd = join(fixture.root, name); mkdirSync(cwd);
				writeFileSync(join(cwd, "authorization.txt"), `Bearer ${name}`);
				children.push(await createSdkChild({ ...childOptions(), cwd, mcpServers: { alpha: { url: http.url, exposure: "direct", headers: { Authorization: "!cat authorization.txt" } } } }));
			}
			await Promise.all(children.map((child) => child.prompt("mcp-fixture")));
			expect(http.calls.filter((call) => call.method === "tools/call").map((call) => call.authorization).sort()).toEqual(["Bearer first", "Bearer second"]);
			expect(process.cwd()).toBe(cwdBefore);
		} finally { await Promise.all(children.map((child) => child.dispose())); await http.dispose(); }
	});

	it("dispatches trusted project MCP in the child's cwd with native env expansion", async () => {
		const script = stdioScript();
		const target = join(fixture.root, "target"); mkdirSync(join(target, ".pi"), { recursive: true });
		writeFileSync(join(target, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: process.execPath, args: [script], exposure: "direct", env: { FIXTURE_SECRET: "${PI_OFFLINE}" } } } }));
		fixture.agent("tools: [mcp__alpha__ping]\n", "mcp");
		await expect(fixture.invoke("subagent", { agent: "mcp", task: "mcp-fixture", cwd: target, mcps: ["alpha"] })).rejects.toThrow("is not configured");
		new ProjectTrustStore(fixture.agentDir).set(target, true);
		const result = await fixture.invoke("subagent", { agent: "mcp", task: "mcp-fixture", cwd: target, mcps: ["alpha"] });
		expect(result.details.results[0].exitCode).toBe(0);
		expect(JSON.stringify(result.details.results[0].messages)).toContain(`${target}:1`);
		const firstPid = Number(readFileSync(join(fixture.root, "connected-mcp.pid"), "utf8"));
		expect(() => process.kill(firstPid, 0)).toThrow();
		mkdirSync(join(target, "server-workdir"));
		writeFileSync(join(target, "native-token.txt"), "native-secret");
		const child = await createSdkChild({ ...childOptions(), cwd: target, mcpServers: { alpha: { command: process.execPath, args: [script], cwd: "server-workdir", exposure: "direct", env: { FIXTURE_SECRET: "!cat native-token.txt" } } } });
		try { await child.prompt("mcp-fixture"); expect(JSON.stringify(child.session.messages)).toContain(`${join(target, "server-workdir")}:native-secret`); }
		finally { await child.dispose(); }
		const secondPid = Number(readFileSync(join(fixture.root, "connected-mcp.pid"), "utf8"));
		expect(() => process.kill(secondPid, 0)).toThrow();
		await expect(child.prompt("hello")).rejects.toThrow("Subagent was aborted");
	}, 15000);

	it("closes a connected native stdio server on controller cancellation and does not reopen it", async () => {
		const controller = new AbortController();
		const script = stdioScript();
		const child = await createSdkChild({ ...childOptions(), signal: controller.signal, mcpServers: { alpha: { command: process.execPath, args: [script], exposure: "direct" } } });
		try {
			await child.prompt("mcp-fixture");
			const pid = Number(readFileSync(join(fixture.root, "connected-mcp.pid"), "utf8"));
			controller.abort();
			await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
			await expect(child.prompt("hello")).rejects.toThrow("Subagent was aborted");
			await expect(child.steer("hello")).rejects.toThrow("Subagent was aborted");
		} finally { await child.dispose(); }
	}, 15000);

	it("does not connect when setup is already cancelled", async () => {
		const http = await httpFixture(); const controller = new AbortController(); controller.abort();
		try {
			await expect(createSdkChild({ ...childOptions(), signal: controller.signal, mcpServers: { alpha: { url: http.url } } })).rejects.toThrow("Subagent was aborted");
			expect(http.calls).toHaveLength(0);
		} finally { await http.dispose(); }
	});

	it("does not reopen native startup after cancellation during an earlier session_start handler", async () => {
		const http = await httpFixture();
		const marker = join(fixture.root, "session-start.marker");
		const extension = fixture.extension("delayed-start", `import {writeFileSync} from 'node:fs'; export default function(pi) { pi.on('session_start', async () => { writeFileSync(${JSON.stringify(marker)}, 'started'); await new Promise(r => setTimeout(r, 100)); }); }`);
		const controller = new AbortController();
		const pending = createSdkChild({ ...childOptions(), extensionPaths: [extension], signal: controller.signal, mcpServers: { alpha: { url: http.url } } });
		const outcome = pending.then(() => "unexpected success", (e: Error) => e.message);
		try {
			await waitFor(() => existsSync(marker)); controller.abort();
			expect(await outcome).toContain("Subagent was aborted");
			await delay(); expect(http.calls).toHaveLength(0);
		} finally { await http.dispose(); }
	});

	// Accepted native 0.99.1 limitation: shutdown stops agent work immediately,
	// but a client still initializing survives until its request timeout. These
	// assertions pin that observed behavior, not an immediate-cleanup guarantee.
	it.each(["controller", "dispose"] as const)("documents delayed native startup cleanup via %s", async (stop) => {
		const pidPath = join(fixture.root, "hanging-mcp.pid");
		const controller = new AbortController();
		const server: McpServerConfig = { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`], timeout: 2 };
		const child = await createSdkChild({ ...childOptions(), signal: controller.signal, mcpServers: { alpha: server } });
		const pending = child.prompt("hello"); const outcome = pending.then(() => "unexpected success", (e: Error) => e.message);
		try {
			await waitFor(() => existsSync(pidPath));
			const pid = Number(readFileSync(pidPath, "utf8"));
			let stopped: Promise<void> | undefined;
			if (stop === "controller") controller.abort(); else stopped = child.dispose();
			await delay();
			expect(() => process.kill(pid, 0)).not.toThrow();
			await expect(child.prompt("hello")).rejects.toThrow("Subagent was aborted");
			// Native timeout cleanup eventually terminates the initializing server.
			await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
			await stopped;
			expect(await outcome).not.toBe("unexpected success");
			expect(fixture.requests).toHaveLength(0);
		} finally {
			// Only clean up our own loopback fixture if an assertion fails.
			if (existsSync(pidPath)) {
				try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { }
			}
			await child.dispose();
		}
	}, 15000);
});
