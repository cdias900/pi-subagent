import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getAgentDir, truncateHead, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { version } from "./package.json";

export interface ScopedMcpServer {
	type: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
}

/** Read only native config files; trusted project entries replace global entries. */
export function loadScopedMcpServers(
	names: readonly string[],
	agentDir = getAgentDir(),
	cwd = process.cwd(),
	projectTrusted = false,
): Record<string, ScopedMcpServer> {
	if (names.length === 0) return {};
	const configPaths = [join(agentDir, "mcp.json"), ...(projectTrusted ? [join(cwd, ".pi", "mcp.json")] : [])];
	const servers = new Map<string, { server: Record<string, unknown>; source: string }>();
	for (const source of configPaths) {
		if (!existsSync(source)) continue;
		const config = JSON.parse(readFileSync(source, "utf8"));
		if (!config?.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
			throw new Error(`Invalid MCP config ${source}: expected an mcpServers object`);
		}
		for (const [name, server] of Object.entries(config.mcpServers)) {
			servers.set(name, { server: server as Record<string, unknown>, source });
		}
	}
	return Object.fromEntries([...new Set(names)].map((name) => {
		const entry = servers.get(name);
		if (!entry) throw new Error(`MCP server "${name}" is not configured in ${configPaths.join(" or ")}`);
		const { server, source } = entry;
		if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error(`Invalid MCP server "${name}" in ${source}`);
		if (server.enabled === false) throw new Error(`MCP server "${name}" is disabled in ${source}`);
		// These clients deliberately are not Pi's native runtime. Fail closed rather
		// than ignore authentication or expose tools intended to be hidden/deferred.
		const unsupported = ["headers", "oauth", "toolExposure", "timeout"].find((key) => server[key] !== undefined)
			?? (server.exposure !== undefined && server.exposure !== "direct" ? "exposure (only direct is supported)" : undefined);
		if (unsupported) throw new Error(`Scoped MCP server "${name}" in ${source} does not support ${unsupported}`);
		const envValues = server.env && typeof server.env === "object" ? Object.values(server.env) : [];
		if (envValues.some((value) => typeof value === "string" && (value.includes("${") || value.startsWith("!")))) {
			throw new Error(`Scoped MCP server "${name}" in ${source} does not support env secret expansion`);
		}
		const paths = [server.command, server.cwd, ...(Array.isArray(server.args) ? server.args : [])];
		if (paths.some((value) => typeof value === "string" && value.startsWith("~/"))) {
			throw new Error(`Scoped MCP server "${name}" in ${source} does not support ~/ expansion`);
		}
		const type = server.type ?? (server.command ? "stdio" : server.url ? "http" : undefined);
		const normalizedType = type === "streamable-http" ? "http" : type;
		if (!/^[a-zA-Z0-9_-]+$/.test(name) ||
			!(normalizedType === "stdio" && typeof server.command === "string" && server.command.trim() ||
			  normalizedType === "http" && typeof server.url === "string" && server.url.trim())) {
			throw new Error(`Invalid MCP server "${name}" in ${source}: expected stdio command or HTTP url`);
		}
		return [name, { ...server, type: normalizedType } as unknown as ScopedMcpServer];
	}));
}

function textContent(value: string) {
	const capped = truncateHead(value);
	return { type: "text" as const, text: capped.content + (capped.truncated ? "\n[truncated]" : "") };
}

export function createScopedMcpExtension(options: {
	servers: Record<string, ScopedMcpServer>;
	cwd: string;
	signal?: AbortSignal;
}) {
	const clients = new Map<string, Client>();
	let initialization: Promise<void> | undefined;
	let closed = false;
	const onAbort = () => { void close(); };
	const close = async () => {
		closed = true;
		options.signal?.removeEventListener("abort", onAbort);
		await Promise.allSettled([...clients.values()].map((client) => client.close()));
		clients.clear();
	};
	const factory: ExtensionFactory = (pi) => {
		pi.on("session_start", async () => {
			if (options.signal?.aborted) throw new Error("MCP setup was aborted");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			initialization = (async () => {
				for (const [name, server] of Object.entries(options.servers)) {
					if (closed) throw new Error("MCP setup was aborted");
					const connect = async (legacySse = false) => {
						if (closed) throw new Error("MCP setup was aborted");
						const client = new Client({ name: `pi-subagent-${name}`, version });
						clients.set(name, client);
						const transport = server.type === "stdio"
							? new StdioClientTransport({
								command: server.command ?? "", args: server.args,
								env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...server.env },
								cwd: server.cwd ? resolve(options.cwd, server.cwd) : options.cwd, stderr: "pipe",
							})
							: server.type === "sse" || legacySse
								? new SSEClientTransport(new URL(server.url ?? ""))
								: new StreamableHTTPClientTransport(new URL(server.url ?? ""));
						try {
							await client.connect(transport);
							if (closed) throw new Error("MCP setup was aborted");
							return client;
						} catch (error) { await client.close().catch(() => {}); throw error; }
					};
					let client: Client;
					try { client = await connect(); }
					catch (error) {
						if (server.type !== "http" || !(error instanceof StreamableHTTPError) || ![404, 405, 415].includes(error.code ?? 0)) throw error;
						client = await connect(true);
					}
					let cursor: string | undefined;
					do {
						const page = await client.listTools(cursor ? { cursor } : undefined);
						if (closed) throw new Error("MCP setup was aborted");
						for (const tool of page.tools) {
							pi.registerTool({
								name: `mcp__${name}__${tool.name}`,
								label: `${tool.name} (${name})`,
								description: tool.description ?? `MCP tool ${tool.name} from ${name}`,
								parameters: Type.Unsafe(tool.inputSchema),
								async execute(_id, params, signal) {
									const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { signal });
									if (result.isError) throw new Error(textContent(JSON.stringify(result.content ?? result.structuredContent ?? "MCP tool failed")).text);
									const items = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
									const content = items.map((item) => {
										if (item.type === "text") return textContent(String(item.text ?? ""));
										if (item.type === "image") return { type: "image" as const, data: String(item.data ?? ""), mimeType: String(item.mimeType ?? "image/png") };
										if (item.type === "resource") {
											const resource = item.resource as Record<string, unknown>;
											return textContent(`Resource (${resource.uri ?? "unknown"}):\n${resource.text ?? "[binary data]"}`);
										}
										return textContent(JSON.stringify(item));
									});
									return { content: content.length ? content : [textContent(result.structuredContent ? JSON.stringify(result.structuredContent) : "(no output)")], details: { server: name, tool: tool.name } };
								},
							});
						}
						cursor = page.nextCursor;
					} while (cursor);
				}
			})().catch(async (error) => { await close(); throw error; });
			await initialization;
		});
		pi.on("session_shutdown", close);
	};
	return {
		extension: { name: "subagent-scoped-mcp", factory },
		async ready() { if (!initialization) throw new Error("MCP runtime did not start"); await initialization; },
		dispose: close,
	};
}
