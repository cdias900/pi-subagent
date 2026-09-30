import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionStartEvent,
	type McpServerConfig,
} from "@earendil-works/pi-coding-agent";

import { bindCommandValues } from "./sdk-model-runtime.js";

export type ScopedMcpServer = McpServerConfig;

// Keep the native file-level preference with this selection without adding a
// synthetic server key or changing callers' Record<string, McpServerConfig> API.
const selections = new WeakMap<Record<string, McpServerConfig>, { autoEnableCodemode?: boolean }>();

/** Select raw native entries only; Pi validates them when the extension registers them. */
export function loadScopedMcpServers(
	names: readonly string[],
	agentDir = getAgentDir(),
	cwd = process.cwd(),
	projectTrusted = false,
): Record<string, McpServerConfig> {
	if (names.length === 0) return {};
	const configPaths = [join(agentDir, "mcp.json"), ...(projectTrusted ? [join(cwd, ".pi", "mcp.json")] : [])];
	const servers = new Map<string, { server: unknown; source: string }>();
	let autoEnableCodemode: boolean | undefined;
	for (const source of configPaths) {
		if (!existsSync(source)) continue;
		const config = JSON.parse(readFileSync(source, "utf8"));
		if (!config?.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
			throw new Error(`Invalid MCP config ${source}: expected an mcpServers object`);
		}
		if (typeof config.autoEnableCodemode === "boolean") autoEnableCodemode = config.autoEnableCodemode;
		for (const [name, server] of Object.entries(config.mcpServers)) servers.set(name, { server, source });
	}
	const selected = Object.fromEntries([...new Set(names)].map((name) => {
		const entry = servers.get(name);
		if (!entry) throw new Error(`MCP server "${name}" is not configured in ${configPaths.join(" or ")}`);
		if ((entry.server as McpServerConfig | null)?.enabled === false) {
			throw new Error(`MCP server "${name}" is disabled in ${entry.source}`);
		}
		// This is a raw selection boundary, not protocol validation. registerMcpServer
		// below owns validation (including transport aliases) and rejects invalid entries.
		return [name, entry.server as McpServerConfig];
	}));
	selections.set(selected, { autoEnableCodemode });
	return selected;
}

/** Native lifecycle, credentials, expansion and exposure; never inherit unselected mcp.json servers. */
export function createScopedMcpExtension(servers: Record<string, McpServerConfig>, cwd: string) {
	const factory: ExtensionFactory = async (pi) => {
		for (const [name, config] of Object.entries(servers)) pi.registerMcpServer(name, config);
		const selectedNames = new Set(Object.keys(servers));
		// Bind only native executable secret fields after registration validation.
		// The SDK resolves !commands from process.cwd(), which is still the parent's.
		const selectedServers = () => pi.getMcpServers().filter(({ name }) => selectedNames.has(name)).map((server) => {
			const { config } = server;
			const bound: McpServerConfig = "command" in config
				? { ...config, env: bindCommandValues(config.env, cwd) as typeof config.env }
				: { ...config, headers: bindCommandValues(config.headers, cwd) as typeof config.headers,
					oauth: config.oauth ? { ...config.oauth, clientSecret: bindCommandValues(config.oauth.clientSecret, cwd) as string | undefined } : undefined };
			return { ...server, config: bound };
		});
		await createCodemodeExtension({ mode: "on" })(pi);
		await createToolSearchExtension()(pi);
		let closed = false;
		pi.on("session_shutdown", () => { closed = true; });
		await createMcpExtension({
			loadConfig: () => ({ servers: [], errors: [], ...selections.get(servers) }),
		})({
			...pi,
			getMcpServers: selectedServers,
			// An earlier child session_start handler can still be awaiting when
			// cancellation emits shutdown. Guard only native startup; preserve
			// the public API's overloaded on() contract for every other event.
			on: new Proxy(pi.on, {
				apply(on, _receiver, [event, handler]) {
					if (event !== "session_start") return Reflect.apply(on, pi, [event, handler]);
					return pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
						if (!closed) await handler(event, ctx);
					});
				},
			}),
		});
	};
	return { name: "subagent-scoped-mcp", factory };
}
