/**
 * Team coordination for subagent workflows
 *
 * A team is a persistent coordination layer that:
 *   - Maintains a shared context file injected into every agent's prompt
 *   - Stores named outputs from agents, referenceable via {output:name} placeholders
 *   - Optionally scopes MCP access per-agent-run via a generated PI_MCP_CONFIG file
 *
 * Directory structure:
 *   ~/.pi/teams/{team-name}/
 *     team.json           # metadata (name, created timestamp)
 *     shared_context.md   # injected into every agent's task
 *     outputs/            # named outputs from agents
 *       {name}.md         # one file per agent output
 *     .mcp-{name}.json    # scoped MCP config (temp, per agent run)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEAMS_DIR = path.join(os.homedir(), ".pi", "teams");

export interface TeamInfo {
	name: string;
	dir: string;
	created: string;
	outputs: string[];
	hasSharedContext: boolean;
}

export function getTeamsDir(): string {
	return TEAMS_DIR;
}

export function getTeamDir(teamName: string): string {
	return path.join(TEAMS_DIR, teamName);
}

export function ensureTeamDir(teamName: string): string {
	const dir = getTeamDir(teamName);
	fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });

	const metaPath = path.join(dir, "team.json");
	if (!fs.existsSync(metaPath)) {
		fs.writeFileSync(
			metaPath,
			JSON.stringify({ name: teamName, created: new Date().toISOString() }, null, 2) + "\n",
		);
	}

	return dir;
}

export function teamExists(teamName: string): boolean {
	return fs.existsSync(path.join(getTeamDir(teamName), "team.json"));
}

export function deleteTeam(teamName: string): boolean {
	const dir = getTeamDir(teamName);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

export function loadSharedContext(teamName: string): string {
	const filePath = path.join(getTeamDir(teamName), "shared_context.md");
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

export function saveOutput(teamName: string, outputName: string, content: string): void {
	const dir = path.join(getTeamDir(teamName), "outputs");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${outputName}.md`), content);
}

export function loadOutput(teamName: string, outputName: string): string | null {
	const filePath = path.join(getTeamDir(teamName), "outputs", `${outputName}.md`);
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

export function listOutputs(teamName: string): string[] {
	const dir = path.join(getTeamDir(teamName), "outputs");
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""));
	} catch {
		return [];
	}
}

// ── Scoped MCP configs ─────────────────────────────────────────────────

function scopedMcpConfigPath(teamName: string, saveAs: string): string {
	return path.join(getTeamDir(teamName), `.mcp-${saveAs}.json`);
}

/**
 * Writes a scoped MCP config containing only the requested MCP server names.
 * Source of truth is ~/.pi/mcp.json.
 */
export function writeScopedMcpConfig(teamName: string, saveAs: string, mcpNames: string[]): string | null {
	const globalConfigPath = path.join(os.homedir(), ".pi", "mcp.json");
	let allServers: Record<string, any> = {};
	try {
		allServers = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
	} catch {
		return null;
	}

	const scoped: Record<string, any> = {};
	for (const name of mcpNames) {
		if (allServers[name]) scoped[name] = allServers[name];
	}

	if (Object.keys(scoped).length === 0) return null;

	const outPath = scopedMcpConfigPath(teamName, saveAs);
	fs.writeFileSync(outPath, JSON.stringify(scoped, null, 2) + "\n");
	return outPath;
}

export function removeScopedMcpConfig(teamName: string, saveAs: string): void {
	try {
		fs.unlinkSync(scopedMcpConfigPath(teamName, saveAs));
	} catch {
		/* ignore */
	}
}

// ── Placeholder expansion ──────────────────────────────────────────────

/** Expand {output:name} placeholders. Unknown outputs become a marker. */
export function expandOutputPlaceholders(teamName: string, text: string): string {
	return text.replace(/\{output:([a-zA-Z0-9_-]+)\}/g, (_match, name) => {
		const content = loadOutput(teamName, name);
		if (content === null) return `[output:${name} NOT FOUND]`;
		return content;
	});
}

/**
 * Build the final agent task text in team mode:
 *   1) expands {output:*}
 *   2) prepends shared_context.md (if non-empty)
 */
export function buildTeamTask(teamName: string, task: string): string {
	let expandedTask = expandOutputPlaceholders(teamName, task);
	const sharedContext = loadSharedContext(teamName);

	if (sharedContext.trim()) {
		expandedTask = `## Team Shared Context\n\n${sharedContext.trim()}\n\n---\n\n## Your Task\n\n${expandedTask}`;
	}

	return expandedTask;
}

// ── Team listing ───────────────────────────────────────────────────────

export function listTeams(): TeamInfo[] {
	try {
		const entries = fs.readdirSync(TEAMS_DIR, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory())
			.map((e) => {
				const dir = path.join(TEAMS_DIR, e.name);

				let created = "unknown";
				try {
					const meta = JSON.parse(fs.readFileSync(path.join(dir, "team.json"), "utf-8"));
					created = meta.created || "unknown";
				} catch {
					/* ignore */
				}

				const outputs = listOutputs(e.name);
				const hasSharedContext = fs.existsSync(path.join(dir, "shared_context.md"));

				return { name: e.name, dir, created, outputs, hasSharedContext };
			});
	} catch {
		return [];
	}
}
