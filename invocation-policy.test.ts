import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import registerExtension, {
	buildSubagentParams,
	type SubagentExtensionOptions,
} from "./index.js";
import {
	SUBAGENT_SETTINGS_FILENAME,
	assertInvocationModelOverridesAllowed,
	findInvocationModelOverridePaths,
	loadSubagentSettings,
	validateSubagentSettings,
} from "./invocation-policy.js";

interface JsonSchema {
	properties: Record<string, JsonSchema>;
	items?: JsonSchema;
}

interface CapturedTool {
	name: string;
	parameters: JsonSchema;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<unknown>;
}

let tempDir: string;
let configPath: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-policy-test-"));
	configPath = path.join(tempDir, SUBAGENT_SETTINGS_FILENAME);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function modelPropertySets(schema: JsonSchema): Array<Record<string, JsonSchema>> {
	return [
		schema.properties,
		schema.properties.tasks.items!.properties,
		schema.properties.chain.items!.properties,
	];
}

function registerSubagentTool(options: SubagentExtensionOptions): CapturedTool {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerCommand() {},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		on() {},
		getThinkingLevel() {
			return "medium";
		},
	} as unknown as ExtensionAPI;

	registerExtension(pi, options);
	const tool = tools.get("subagent");
	expect(tool).toBeDefined();
	return tool!;
}

describe("persistent subagent settings", () => {
	it("defaults to allowing invocation overrides when the file is missing", () => {
		expect(loadSubagentSettings(configPath)).toEqual({
			settings: { allowInvocationModelOverrides: true },
			path: configPath,
		});
		expect(fs.existsSync(configPath)).toBe(false);
	});

	it("loads a persistent disabled policy", () => {
		fs.writeFileSync(
			configPath,
			'{"allowInvocationModelOverrides":false}\n',
		);

		expect(loadSubagentSettings(configPath)).toEqual({
			settings: { allowInvocationModelOverrides: false },
			path: configPath,
		});
	});

	it("allows an empty object and applies the backward-compatible default", () => {
		expect(validateSubagentSettings({})).toEqual({
			valid: true,
			settings: { allowInvocationModelOverrides: true },
		});
	});

	it.each([
		["non-object root", "[]", "configuration root must be a plain object"],
		[
			"unknown key",
			'{"allowInvocationModelOverrides":false,"other":true}',
			'configuration contains unknown key "other"',
		],
		[
			"non-boolean policy",
			'{"allowInvocationModelOverrides":"false"}',
			"allowInvocationModelOverrides must be a boolean",
		],
	] as const)("rejects a %s without changing the file", (_label, contents, message) => {
		fs.writeFileSync(configPath, contents);
		const original = fs.readFileSync(configPath);

		expect(loadSubagentSettings(configPath)).toEqual({
			settings: { allowInvocationModelOverrides: true },
			error: `${configPath}: ${message}`,
			path: configPath,
		});
		expect(fs.readFileSync(configPath)).toEqual(original);
	});

	it("reports malformed JSON without changing the file", () => {
		const malformed = '{"allowInvocationModelOverrides":';
		fs.writeFileSync(configPath, malformed);
		const original = fs.readFileSync(configPath);

		const result = loadSubagentSettings(configPath);
		expect(result.settings).toEqual({ allowInvocationModelOverrides: true });
		expect(result.path).toBe(configPath);
		expect(result.error).toContain(configPath);
		expect(result.error).toContain("JSON");
		expect(fs.readFileSync(configPath)).toEqual(original);
	});
});

describe("invocation model override policy", () => {
	it("finds top-level, parallel-task, and chain-step overrides by property presence", () => {
		expect(
			findInvocationModelOverridePaths({
				model: undefined,
				thinkingLevel: "high",
				tasks: [
					{ agent: "scout", task: "one" },
					{ agent: "reviewer", task: "two", model: "provider/model" },
				],
				chain: [
					{ agent: "planner", task: "plan", thinkingLevel: undefined },
				],
			}),
		).toEqual([
			"model",
			"thinkingLevel",
			"tasks[1].model",
			"chain[0].thinkingLevel",
		]);
	});

	it("does not interpret same-named structured input data as overrides", () => {
		expect(
			findInvocationModelOverridePaths({
				agent: "parameterized",
				input: {
					model: "domain-data",
					thinkingLevel: "also-domain-data",
					nested: { model: "still-domain-data" },
				},
			}),
		).toEqual([]);
	});

	it("finds inherited overrides that downstream property access would consume", () => {
		const task = Object.assign(
			Object.create({ model: "provider/task-model" }) as Record<string, unknown>,
			{ agent: "scout", task: "inspect" },
		);
		const chainStep = Object.assign(
			Object.create({ thinkingLevel: "high" }) as Record<string, unknown>,
			{ agent: "reviewer", task: "review" },
		);
		const params = Object.assign(
			Object.create({ model: "provider/invocation-model" }) as Record<string, unknown>,
			{ tasks: [task], chain: [chainStep] },
		);

		expect(findInvocationModelOverridePaths(params)).toEqual([
			"model",
			"tasks[0].model",
			"chain[0].thinkingLevel",
		]);
	});

	it("rejects prohibited fields with their paths before dispatch", () => {
		expect(() =>
			assertInvocationModelOverridesAllowed(
				{
					tasks: [
						{ agent: "scout", task: "one" },
						{ agent: "reviewer", task: "two", thinkingLevel: "max" },
					],
				},
				false,
				configPath,
			),
		).toThrow(/tasks\[1\]\.thinkingLevel[\s\S]*No subagents were started/);
	});

	it("allows override-free calls when disabled and all calls when enabled", () => {
		expect(() =>
			assertInvocationModelOverridesAllowed(
				{ agent: "scout", task: "inspect" },
				false,
				configPath,
			),
		).not.toThrow();
		expect(() =>
			assertInvocationModelOverridesAllowed(
				{ agent: "scout", task: "inspect", model: "provider/model" },
				true,
				configPath,
			),
		).not.toThrow();
	});
});

describe("invocation policy schema and extension wiring", () => {
	it("exposes model fields in every invocation location when enabled", () => {
		const schema = buildSubagentParams(true) as unknown as JsonSchema;
		for (const properties of modelPropertySets(schema)) {
			expect(properties).toHaveProperty("model");
			expect(properties).toHaveProperty("thinkingLevel");
		}
	});

	it("omits model fields in every invocation location when disabled", () => {
		const schema = buildSubagentParams(false) as unknown as JsonSchema;
		for (const properties of modelPropertySets(schema)) {
			expect(properties).not.toHaveProperty("model");
			expect(properties).not.toHaveProperty("thinkingLevel");
		}
	});

	it("does not mutate the enabled schema when building the disabled variant", () => {
		const enabled = buildSubagentParams(true) as unknown as JsonSchema;
		buildSubagentParams(false);
		for (const properties of modelPropertySets(enabled)) {
			expect(properties).toHaveProperty("model");
			expect(properties).toHaveProperty("thinkingLevel");
		}
	});

	it("loads the persistent disabled policy into the schema and runtime guard", async () => {
		fs.writeFileSync(
			configPath,
			'{"allowInvocationModelOverrides":false}\n',
		);
		const tool = registerSubagentTool({ settingsPath: configPath });
		for (const properties of modelPropertySets(tool.parameters)) {
			expect(properties).not.toHaveProperty("model");
			expect(properties).not.toHaveProperty("thinkingLevel");
		}
		expect(tool.description).toContain("overrides are disabled");

		await expect(
			tool.execute(
				"call-1",
				{
					agent: "scout",
					task: "inspect",
					model: "provider/model",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/allowInvocationModelOverrides: false[\s\S]*No subagents were started/);
	});

	it("preserves the historical schema when the persistent file is missing", () => {
		const tool = registerSubagentTool({ settingsPath: configPath });
		for (const properties of modelPropertySets(tool.parameters)) {
			expect(properties).toHaveProperty("model");
			expect(properties).toHaveProperty("thinkingLevel");
		}
		expect(tool.description).not.toContain("overrides are disabled");
	});

	it("supports an injected policy for isolated embedding and tests", () => {
		const tool = registerSubagentTool({
			settings: { allowInvocationModelOverrides: false },
			settingsPath: "/test/subagent-settings.json",
		});
		for (const properties of modelPropertySets(tool.parameters)) {
			expect(properties).not.toHaveProperty("model");
		}
	});

	it("fails extension registration on an invalid persistent setting", () => {
		fs.writeFileSync(
			configPath,
			'{"allowInvocationModelOverrides":"sometimes"}\n',
		);
		expect(() =>
			registerExtension({} as ExtensionAPI, { settingsPath: configPath }),
		).toThrow(`${configPath}: allowInvocationModelOverrides must be a boolean`);
	});
});
