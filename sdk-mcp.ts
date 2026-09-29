import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getAgentDir, truncateHead, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChildModuleLoader } from "./sdk-extensions.js";
import { version } from "./package.json";

export interface ScopedMcpServer {
	type: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
}

/** Same global source and name selection as the former per-run scoped file. */
export function loadScopedMcpServers(names: readonly string[], agentDir = getAgentDir()): Record<string, ScopedMcpServer> {
	const configPath = join(dirname(agentDir), "mcp.json");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	return Object.fromEntries([...new Set(names)].map((name) => {
		const server = config[name];
		if (!server || !["stdio", "http", "sse"].includes(server.type)) {
			throw new Error(`MCP server "${name}" is not configured in ${configPath}`);
		}
		return [name, server as ScopedMcpServer];
	}));
}

function textContent(value: string) {
	const capped = truncateHead(value);
	return { type: "text" as const, text: capped.content + (capped.truncated ? "\n[truncated]" : "") };
}

export function createScopedMcpExtension(options: {
	servers: Record<string, ScopedMcpServer>;
	cwd: string;
	bridgePath?: string;
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
					let authProvider: OAuthClientProvider | undefined;
					if (options.bridgePath && server.type === "http") {
						// Reuse the bridge's maintained credential store and OAuth refresh
						// behavior; do not initialize another global bridge extension.
						const oauth = await createChildModuleLoader().import<{
							BridgeOAuthProvider: new (name: string, port: number) => OAuthClientProvider;
						}>(join(dirname(options.bridgePath), "oauth.ts"));
						if (closed) throw new Error("MCP setup was aborted");
						authProvider = new oauth.BridgeOAuthProvider(name, 19876);
						authProvider.redirectToAuthorization = () => {
							throw new Error(`MCP server "${name}" needs login; authenticate it in the parent Pi session first`);
						};
					}
					const connect = async (legacySse = false) => {
						if (closed) throw new Error("MCP setup was aborted");
						const client = new Client({ name: `pi-subagent-${name}`, version });
						clients.set(name, client);
						const transport = server.type === "stdio"
							? new StdioClientTransport({
								command: server.command ?? "", args: server.args,
								env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...server.env },
								cwd: options.cwd, stderr: "pipe",
							})
							: server.type === "sse" || legacySse
								? new SSEClientTransport(new URL(server.url ?? ""), { authProvider })
								: new StreamableHTTPClientTransport(new URL(server.url ?? ""), { authProvider });
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
