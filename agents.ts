/**
 * Agent discovery and configuration.
 *
 * Agents are discovered from three sources (in priority order):
 *   1. Project-local: .pi/agents/ (highest priority — overrides everything)
 *   2. User: ~/.pi/agent/agents/ (overrides bundled)
 *   3. Bundled: this package's agents/ directory (defaults, lowest priority)
 *
 * Same-name agents from higher-priority sources replace lower-priority ones.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { normalizeParametersSchema } from "./parameters.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	extensions?: string[];
	model?: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
	parameters?: Record<string, unknown>;
	inputInstructions?: string;
	allowFreeform?: boolean;
	allowRuntimeTools?: boolean;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: string[];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.map(String);
	}
	if (typeof value === "string") {
		return value.split(",").map((s) => s.trim()).filter(Boolean);
	}
	return undefined;
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"], diagnostics: string[]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

			const name = asString(frontmatter.name);
			const description = asString(frontmatter.description);

			if (!name || !description) continue;

			let parametersSchema: Record<string, unknown> | undefined;
			if (frontmatter.parameters !== undefined) {
				const { schema, error } = normalizeParametersSchema(frontmatter.parameters);
				if (error) {
					diagnostics.push(`Agent '${name}' in ${source} skipped due to invalid parameters: ${error}`);
					continue;
				}
				parametersSchema = schema;
			}

			const tools = asStringList(frontmatter.tools);
			const extensions = asStringList(frontmatter.extensions);

			agents.push({
				name,
				description,
				tools: tools && tools.length > 0 ? tools : undefined,
				extensions: extensions && extensions.length > 0 ? extensions : undefined,
				model: asString(frontmatter.model),
				systemPrompt: body,
				source,
				filePath,
				parameters: parametersSchema,
				inputInstructions: asString(frontmatter.inputInstructions),
				allowFreeform: asBoolean(frontmatter.allowFreeform),
				allowRuntimeTools: asBoolean(frontmatter.allowRuntimeTools),
			});
		} catch (err: any) {
			diagnostics.push(`Failed to parse agent file ${filePath}: ${err.message}`);
			continue;
		}
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** Locate the bundled agents/ directory shipped with this package. */
function getBundledAgentsDir(): string {
	try {
		// ESM: use import.meta.url
		const thisFile = fileURLToPath(import.meta.url);
		return path.join(path.dirname(thisFile), "agents");
	} catch {
		// CJS fallback
		return path.join(__dirname, "agents");
	}
}

/**
 * Discover all available agents.
 *
 * Priority (higher overrides lower):
 *   project (.pi/agents/) > user (~/.pi/agent/agents/) > bundled (package agents/)
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundledDir = getBundledAgentsDir();

	const diagnostics: string[] = [];

	// Load from all three sources
	const bundledAgents = loadAgentsFromDir(bundledDir, "bundled", diagnostics);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", diagnostics);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", diagnostics);

	// Merge with priority: bundled < user < project
	const agentMap = new Map<string, AgentConfig>();

	// Bundled first (lowest priority)
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);

	if (scope === "both" || scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope === "both" || scope === "project") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir, diagnostics };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
