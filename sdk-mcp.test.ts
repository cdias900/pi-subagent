import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createSdkChild } from "./sdk-runner.js";
import { loadScopedMcpServers } from "./sdk-mcp.js";
import { offlineSdkFixture } from "./test/offline-sdk.js";
import type { AgentConfig } from "./agents.js";
import type { ResolvedModelConfig } from "./model-resolution.js";

const agent: AgentConfig = { name: "mcp", description: "Local MCP test", source: "user", filePath: "/fixture/mcp.md", systemPrompt: "Read-only local test", tools: ["mcp__alpha__ping"] };
const model: ResolvedModelConfig = { model: "offline-test/mock", thinkingLevel: "off", modelSource: "parent", source: "parent" };
let fixture: Awaited<ReturnType<typeof offlineSdkFixture>>;
beforeEach(async () => { fixture = await offlineSdkFixture(); });
afterEach(async () => { await fixture.dispose(); });

describe("session-scoped MCP in the SDK", () => {
	it("selects only configured server names without writing global environment", () => {
		writeFileSync(join(fixture.root, "mcp.json"), JSON.stringify({ alpha: { type: "http", url: "http://127.0.0.1:1" }, beta: { type: "http", url: "http://127.0.0.1:2" } }));
		expect(Object.keys(loadScopedMcpServers(["alpha"], fixture.agentDir))).toEqual(["alpha"]);
		expect(() => loadScopedMcpServers(["unknown"], fixture.agentDir)).toThrow("is not configured");
	});

	it("discovers and calls an HTTP MCP tool from two independent SDK sessions", async () => {
		const calls: string[] = [];
		const server = createServer(async (req, res) => {
			if (req.method === "GET") { res.writeHead(405); res.end(); return; }
			if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (request.id === undefined) { res.writeHead(202); res.end(); return; }
			calls.push(request.method);
			const result = request.method === "initialize"
				? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
				: request.method === "tools/list"
					? { tools: [{ name: "ping", description: "Local ping", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] }
					: { content: [{ type: "text", text: "mcp-fixture-response" }] };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP port");
		const before = process.env.PI_MCP_CONFIG;
		const children = await Promise.all([1, 2].map(() => createSdkChild({
			cwd: fixture.cwd, agent, resolvedModel: model, onEvent() {},
			mcpServers: { alpha: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } },
		})));
		try {
			await Promise.all(children.map((child) => child.prompt("mcp-fixture")));
			for (const child of children) {
				expect(child.session.getActiveToolNames()).toEqual(["mcp__alpha__ping"]);
				expect(JSON.stringify(child.session.messages)).toContain("MCP usable");
			}
			expect(calls.filter((m) => m === "tools/call")).toHaveLength(2);
			expect(process.env.PI_MCP_CONFIG).toBe(before);
		} finally {
			await Promise.all(children.map((child) => child.dispose()));
			server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 15000);

	it("does not connect after cancellation during an OAuth-module import", async () => {
		const bridgeDir = join(fixture.root, "bridge"); mkdirSync(bridgeDir);
		const marker = join(fixture.root, "oauth-import-started");
		writeFileSync(join(bridgeDir, "oauth.ts"), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'started');
await new Promise(resolve => setTimeout(resolve, 100));
export class BridgeOAuthProvider {}
`);
		let requests = 0;
		const server = createServer((_req, res) => { requests++; res.writeHead(400); res.end(); });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP port");
		const controller = new AbortController();
		try {
			const pending = createSdkChild({
				cwd: fixture.cwd, agent, resolvedModel: model, signal: controller.signal, onEvent() {},
				mcpBridgePath: join(bridgeDir, "index.ts"),
				mcpServers: { alpha: { type: "http", url: `http://127.0.0.1:${address.port}` } },
			});
			const result = pending.then(() => "unexpected success", (error: Error) => error.message);
			const deadline = Date.now() + 3000;
			while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			expect(existsSync(marker)).toBe(true); controller.abort();
			expect(await result).not.toBe("unexpected success");
			expect(requests).toBe(0);
		} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
	}, 10000);

	it("aborts an in-flight stdio MCP handshake and terminates its server", async () => {
		const pidPath = join(fixture.root, "hanging-mcp.pid");
		const controller = new AbortController();
		const pending = createSdkChild({
			cwd: fixture.cwd, agent, resolvedModel: model, signal: controller.signal, onEvent() {},
			mcpServers: { alpha: { type: "stdio", command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`] } },
		});
		// Attach rejection handling before aborting a promise that is still in setup.
		const result = pending.then(() => "unexpected success", (error: Error) => error.message);
		const deadline = Date.now() + 4000;
		while (!existsSync(pidPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(pidPath)).toBe(true);
		const pid = Number(readFileSync(pidPath, "utf8"));
		controller.abort();
		expect(await result).not.toBe("unexpected success");
		expect(() => process.kill(pid, 0)).toThrow();
	}, 10000);

	it("starts a scoped stdio MCP server in the child's cwd", async () => {
		const require = createRequire(import.meta.url);
		const script = join(fixture.root, "stdio-mcp.mjs");
		writeFileSync(script, `
import { Server } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/index.js")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href)};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/types.js")).href)};
const server = new Server({name: "fixture", version: "1"}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, () => ({tools: [{name: "ping", inputSchema: {type: "object", properties: {value: {type: "string"}}}}]}));
server.setRequestHandler(CallToolRequestSchema, () => ({content: [{type: "text", text: process.cwd()}]}));
await server.connect(new StdioServerTransport());
`);
		const child = await createSdkChild({ cwd: fixture.cwd, agent, resolvedModel: model, onEvent() {}, mcpServers: { alpha: { type: "stdio", command: process.execPath, args: [script] } } });
		try {
			await child.prompt("mcp-fixture");
			expect(JSON.stringify(child.session.messages)).toContain("/project");
		} finally { await child.dispose(); }
	}, 15000);
});
