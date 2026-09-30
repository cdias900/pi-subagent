import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import registerExtension from "../index.js";

export interface ModelRequest {
	model: string;
	messages: Array<{ role: string; content?: unknown }>;
	authorization?: string;
}
interface ToolCall { name: string; arguments: object }
function completion(res: ServerResponse, value: string | ToolCall | ToolCall[]) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const id = `fixture-${Date.now()}`;
	const chunk = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	if (typeof value === "string") { chunk({ role: "assistant", content: value }, null); chunk({}, "stop"); }
	else {
		chunk({ role: "assistant", tool_calls: (Array.isArray(value) ? value : [value]).map((tool, index) => ({
			index, id: `fixture-call-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
		})) }, null);
		chunk({}, "tool_calls");
	}
	res.write(`data: ${JSON.stringify({ id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
	res.end("data: [DONE]\n\n");
}

export async function offlineSdkFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-sdk-test-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"));
	writeFileSync(join(cwd, "marker.txt"), "fixture-content\n");
	const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "TOOL_GATEWAY_MCP_URL", "PI_TOOL_GATEWAY_CONFIG_DIR"].map((key) => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const requests: ModelRequest[] = [];
	let failures = 0;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const request: ModelRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests.push({ ...request, authorization: req.headers.authorization });
		const prompt = JSON.stringify(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
		const turnMessages = request.messages.slice(request.messages.map((m) => m.role).lastIndexOf("user"));
		const hasResult = turnMessages.some((m) => m.role === "tool");
		if (prompt.includes("failure") || prompt.includes("retry-once") && failures++ === 0) {
			res.writeHead(prompt.includes("retry-once") ? 500 : 400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "scripted model failure", type: "invalid_request_error" } }));
			return;
		}
		if (prompt.includes("slow")) { await new Promise((resolve) => setTimeout(resolve, 1000)); if (res.destroyed) return; }
		if (prompt.includes("delegate")) {
			completion(res, hasResult ? "Parent saw child" : { name: "subagent", arguments: { agent: "offline", task: "hello" } });
		} else if (prompt.includes("mixed-signal")) {
			completion(res, hasResult ? "Unexpected continuation" : [
				{ name: "__bg_signal", arguments: { status: "done", summary: "done" } },
				{ name: "write", arguments: { path: "unwanted.txt", content: "unwanted" } },
			]);
		} else if (prompt.includes("question")) {
			completion(res, { name: "__bg_signal", arguments: { status: "question", question: "May I proceed?" } });
		} else if (prompt.includes("yes") || prompt.includes("background-done")) {
			completion(res, { name: "__bg_signal", arguments: { status: "done", summary: "Finished" } });
		} else if (prompt.includes("read-marker")) {
			completion(res, hasResult ? "Read completed" : { name: "read", arguments: { path: "marker.txt" } });
		} else if (prompt.includes("write-marker")) {
			completion(res, hasResult ? "Write completed" : { name: "write", arguments: { path: "written.txt", content: "written-content" } });
		} else if (prompt.includes("gateway-fixture")) {
			completion(res, hasResult ? (JSON.stringify(request.messages).includes("mock_ping") ? "Gateway usable" : "Gateway missing") : { name: "tool_gateway_search_tools", arguments: { query: "mock_ping", include_direct: true } });
		} else if (prompt.includes("mcp-codemode")) {
			completion(res, hasResult ? "Codemode completed" : { name: "codemode", arguments: { code: "const result = await tools.mcp__alpha__ping({value: 'test'}); text(result);" } });
		} else if (prompt.includes("mcp-search")) {
			const searched = turnMessages.some((m) => m.role === "tool" && JSON.stringify(m).includes("mcp__alpha__ping"));
			completion(res, !hasResult ? { name: "tool_search", arguments: { query: "mcp__alpha__ping" } }
				: searched && !turnMessages.some((m) => m.role === "tool" && JSON.stringify(m).includes("mcp-fixture-response"))
					? { name: "mcp__alpha__ping", arguments: { value: "test" } } : "Search completed");
		} else if (prompt.includes("mcp-resource")) {
			completion(res, hasResult ? "Resource completed" : { name: "read_mcp_resource", arguments: { server: "alpha", uri: "fixture://text" } });
		} else if (prompt.includes("mcp-fixture")) {
			completion(res, hasResult ? "MCP usable" : { name: "mcp__alpha__ping", arguments: { value: "test" } });
		} else completion(res, "Offline parity: café 🚀");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		"offline-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "offline-key",
			models: ["mock", "mock-alt"].map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
		},
	} }));
	const agent = (extra = "", name = "offline") => writeFileSync(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Local SDK test\n${/^tools:/m.test(extra) ? "" : "tools: []\n"}${extra}---\nROLE_MARKER\n`);
	agent();
	const extension = (name: string, source: string) => {
		const path = join(agentDir, "extensions", `${name}.ts`);
		writeFileSync(path, source);
		return path;
	};
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const notices: string[] = [];
	const availableModels = ["mock", "mock-alt"].map((id) => ({ provider: "offline-test", id, reasoning: false }));
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
		registerCommand() {}, getThinkingLevel: () => "off",
		sendMessage(message: { content: string }) { notices.push(message.content); }, appendEntry() {},
	} as unknown as ExtensionAPI;
	registerExtension(pi, { settings: { allowInvocationModelOverrides: true } });
	const ctx = {
		cwd, model: availableModels[0], hasUI: false, mode: "print", sessionManager: { getBranch: () => [] },
		modelRegistry: { find: (provider: string, id: string) => availableModels.find((m) => m.provider === provider && m.id === id), getAll: () => availableModels, getAvailable: () => availableModels },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	const invoke = (name: string, params: object, signal?: AbortSignal) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return tool.execute("fixture-call", params, signal, undefined, ctx);
	};
	const shutdown = async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); };
	const waitFor = async (id: string, status: string) => {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const result = await invoke("subagent_status", { id });
			if (result.content[0]?.text.includes(`Status: ${status}`)) return result;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`Timed out waiting for ${id} to become ${status}`);
	};
	return { root, cwd, agentDir, requests, notices, agent, extension, invoke, shutdown, waitFor,
		async dispose() {
			await shutdown();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(root, { recursive: true, force: true });
		},
	};
}
