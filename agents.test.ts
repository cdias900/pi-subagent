import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadAgentsFromDir, type AgentConfig } from "./agents.js";

function makeTempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));
}

function yamlValue(v: unknown): string {
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		return `\n${v.map((item) => `  - ${item}`).join("\n")}`;
	}
	if (v !== null && typeof v === "object") {
		// JSON is valid YAML; serialize nested objects inline
		return JSON.stringify(v);
	}
	return String(v);
}

function writeAgent(dir: string, name: string, frontmatter: Record<string, unknown>, body: string = "System prompt body."): string {
	const content = `---\n${Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${yamlValue(v)}`)
		.join("\n")}\n---\n${body}`;
	const filePath = path.join(dir, `${name}.md`);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function loadDir(dir: string): { agents: AgentConfig[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const agents = loadAgentsFromDir(dir, "project", diagnostics);
	return { agents, diagnostics };
}

describe("loadAgentsFromDir — tools three-state", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempAgentDir();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("omitted tools => undefined", () => {
		writeAgent(dir, "no-tools", { name: "no-tools", description: "No tools field" });
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		expect(agents[0].tools).toBeUndefined();
	});

	it("explicit empty array [] => []", () => {
		writeAgent(dir, "empty-tools", { name: "empty-tools", description: "Empty tools", tools: [] });
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		expect(agents[0].tools).toEqual([]);
	});

	it("non-empty tools => normalized array", () => {
		writeAgent(dir, "some-tools", { name: "some-tools", description: "Some tools", tools: ["read", "write", "bash"] });
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		expect(agents[0].tools).toEqual(["read", "write", "bash"]);
	});

	it("comma-separated string tools => normalized array", () => {
		writeAgent(dir, "string-tools", { name: "string-tools", description: "String tools", tools: "read, write, bash" });
		const { agents } = loadDir(dir);
		expect(agents).toHaveLength(1);
		expect(agents[0].tools).toEqual(["read", "write", "bash"]);
	});
});

describe("loadAgentsFromDir — new frontmatter fields", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempAgentDir();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("parses all four new fields when present", () => {
		writeAgent(dir, "full-agent", {
			name: "full-agent",
			description: "Has all new fields",
			systemPromptMode: "replace",
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		const agent = agents[0];
		expect(agent.systemPromptMode).toBe("replace");
		expect(agent.noSkills).toBe(true);
		expect(agent.noPromptTemplates).toBe(true);
		expect(agent.noContextFiles).toBe(true);
	});

	it("systemPromptMode 'append' is valid", () => {
		writeAgent(dir, "append-agent", {
			name: "append-agent",
			description: "Append mode",
			systemPromptMode: "append",
		});
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		expect(agents[0].systemPromptMode).toBe("append");
	});

	it("omitted new fields => undefined/false", () => {
		writeAgent(dir, "legacy-agent", { name: "legacy-agent", description: "No new fields" });
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		const agent = agents[0];
		expect(agent.systemPromptMode).toBeUndefined();
		expect(agent.noSkills).toBeUndefined();
		expect(agent.noPromptTemplates).toBeUndefined();
		expect(agent.noContextFiles).toBeUndefined();
	});

	it("explicit false booleans are preserved", () => {
		writeAgent(dir, "false-agent", {
			name: "false-agent",
			description: "Explicit false",
			noSkills: false,
			noPromptTemplates: false,
			noContextFiles: false,
		});
		const { agents } = loadDir(dir);
		expect(agents).toHaveLength(1);
		expect(agents[0].noSkills).toBe(false);
		expect(agents[0].noPromptTemplates).toBe(false);
		expect(agents[0].noContextFiles).toBe(false);
	});
});

describe("loadAgentsFromDir — invalid systemPromptMode", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempAgentDir();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("invalid systemPromptMode emits diagnostic and skips only that agent", () => {
		writeAgent(dir, "bad-mode", {
			name: "bad-mode",
			description: "Invalid mode",
			systemPromptMode: "merge",
		});
		writeAgent(dir, "good-agent", {
			name: "good-agent",
			description: "Valid agent",
			systemPromptMode: "append",
		});
		const { agents, diagnostics } = loadDir(dir);
		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("good-agent");
		expect(agents[0].systemPromptMode).toBe("append");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("bad-mode");
		expect(diagnostics[0]).toContain("invalid systemPromptMode");
		expect(diagnostics[0]).toContain("'merge'");
	});
});

describe("loadAgentsFromDir — legacy parsing", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempAgentDir();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("agent with only legacy fields (name, description, tools, model) loads correctly", () => {
		writeAgent(dir, "legacy", {
			name: "legacy",
			description: "Legacy agent",
			tools: ["read", "grep"],
			model: "claude-sonnet-4",
		});
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		const agent = agents[0];
		expect(agent.name).toBe("legacy");
		expect(agent.description).toBe("Legacy agent");
		expect(agent.tools).toEqual(["read", "grep"]);
		expect(agent.model).toBe("claude-sonnet-4");
		expect(agent.systemPromptMode).toBeUndefined();
		expect(agent.noSkills).toBeUndefined();
		expect(agent.noPromptTemplates).toBeUndefined();
		expect(agent.noContextFiles).toBeUndefined();
	});

	it("agent with parameters, allowFreeform, allowRuntimeTools still works", () => {
		writeAgent(dir, "param-agent", {
			name: "param-agent",
			description: "Parameterized agent",
			allowFreeform: true,
			allowRuntimeTools: false,
			parameters: {
				type: "object",
				required: ["task"],
				properties: {
					task: { type: "string" },
				},
			},
		});
		const { agents, diagnostics } = loadDir(dir);
		expect(diagnostics).toEqual([]);
		expect(agents).toHaveLength(1);
		expect(agents[0].allowFreeform).toBe(true);
		expect(agents[0].allowRuntimeTools).toBe(false);
		expect(agents[0].parameters).toEqual({
			type: "object",
			required: ["task"],
			properties: { task: { type: "string" } },
		});
	});

	it("empty directory returns no agents and no diagnostics", () => {
		const { agents, diagnostics } = loadDir(dir);
		expect(agents).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("agent missing name is skipped silently", () => {
		writeAgent(dir, "no-name", { description: "No name" });
		const { agents, diagnostics } = loadDir(dir);
		expect(agents).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("agent missing description is skipped silently", () => {
		writeAgent(dir, "no-desc", { name: "no-desc" });
		const { agents, diagnostics } = loadDir(dir);
		expect(agents).toEqual([]);
		expect(diagnostics).toEqual([]);
	});
});
