import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GLOBAL_CONFIG_FILENAME,
	loadGlobalConfig,
	resetGlobalOverride,
	saveGlobalOverride,
	validateSubagentModelConfig,
	type SubagentModelConfig,
} from "./model-config.js";

vi.mock(import("node:fs"), { spy: true });

function parseErrorMessage(contents: string): string {
	try {
		JSON.parse(contents);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	throw new Error("Expected malformed JSON to fail parsing");
}

function writeBytes(filePath: string, contents: string | Buffer): Buffer {
	const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, bytes);
	return bytes;
}

function readBytes(filePath: string): Buffer {
	return fs.readFileSync(filePath);
}

function expectRejectedWithoutWrite(
	filePath: string,
	contents: string,
	message: string,
): void {
	const originalBytes = writeBytes(filePath, contents);

	expect(loadGlobalConfig(filePath)).toEqual({
		config: {},
		error: `${filePath}: ${message}`,
		path: filePath,
	});
	expect(readBytes(filePath)).toEqual(originalBytes);
}

function captureError(operation: () => void): Error {
	try {
		operation();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`Expected an Error, received ${String(error)}`);
	}

	throw new Error("Expected operation to throw");
}

describe("validateSubagentModelConfig", () => {
	it("returns a discriminated success result for a valid whole config", () => {
		const config: SubagentModelConfig = {
			scout: { model: "anthropic/claude", thinkingLevel: "high" },
		};

		expect(validateSubagentModelConfig(config)).toEqual({
			valid: true,
			config,
		});
	});

	it("returns a discriminated failure result for a malformed inner override", () => {
		expect(
			validateSubagentModelConfig({ scout: { model: 7 } }),
		).toEqual({
			valid: false,
			error: 'model for agent "scout" must be a string',
		});
	});
});

describe("global subagent model config", () => {
	let tempDir: string;
	let configPath: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-config-test-"));
		configPath = path.join(tempDir, "config", GLOBAL_CONFIG_FILENAME);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadGlobalConfig", () => {
		it("returns an empty config, no error, and the exact path when the file is missing", () => {
			expect(loadGlobalConfig(configPath)).toEqual({
				config: {},
				path: configPath,
			});
			expect(fs.existsSync(configPath)).toBe(false);
			expect(fs.existsSync(path.dirname(configPath))).toBe(false);
		});

		it("parses a valid file, including partial and deliberately empty overrides", () => {
			const config: SubagentModelConfig = {
				scout: { model: "anthropic/claude-sonnet-5" },
				executor: { thinkingLevel: "max" },
				reviewer: {
					model: "openai/gpt-5.6-sol",
					thinkingLevel: "off",
				},
				unconfigured: {},
			};
			const originalBytes = writeBytes(
				configPath,
				`${JSON.stringify(config, null, 2)}\n`,
			);

			expect(loadGlobalConfig(configPath)).toEqual({ config, path: configPath });
			expect(readBytes(configPath)).toEqual(originalBytes);
		});

		it("reads the file fresh on every call", () => {
			writeBytes(configPath, '{"scout":{"model":"first/model"}}');
			expect(loadGlobalConfig(configPath).config).toEqual({
				scout: { model: "first/model" },
			});

			writeBytes(configPath, '{"planner":{"thinkingLevel":"high"}}');
			expect(loadGlobalConfig(configPath).config).toEqual({
				planner: { thinkingLevel: "high" },
			});
		});

		it("returns the exact path and parse error for malformed JSON without changing bytes", () => {
			const malformed = '{"scout":{"model":"provider/model"}';
			const originalBytes = writeBytes(configPath, malformed);

			expect(loadGlobalConfig(configPath)).toEqual({
				config: {},
				error: `${configPath}: ${parseErrorMessage(malformed)}`,
				path: configPath,
			});
			expect(readBytes(configPath)).toEqual(originalBytes);
		});

		it.each([
			["number", "42"],
			["string", '"config"'],
			["boolean", "false"],
			["null", "null"],
			["array", "[]"],
		])("rejects a %s root without changing the file", (_label, contents) => {
			expectRejectedWithoutWrite(
				configPath,
				contents,
				"configuration root must be a plain object",
			);
		});

		it.each([
			["number", "42"],
			["string", '"override"'],
			["boolean", "false"],
			["null", "null"],
			["array", "[]"],
		])("rejects a %s agent entry without changing the file", (_label, entry) => {
			expectRejectedWithoutWrite(
				configPath,
				`{"scout":${entry}}`,
				'override for agent "scout" must be a plain object',
			);
		});

		it("rejects unknown override keys without changing the file", () => {
			expectRejectedWithoutWrite(
				configPath,
				'{"scout":{"model":"provider/model","temperature":0.2}}',
				'override for agent "scout" contains unknown key "temperature"',
			);
		});

		it.each([
			["null", "null"],
			["number", "7"],
			["boolean", "true"],
			["object", "{}"],
			["array", "[]"],
		])("rejects a %s model without changing the file", (_label, model) => {
			expectRejectedWithoutWrite(
				configPath,
				`{"scout":{"model":${model}}}`,
				'model for agent "scout" must be a string',
			);
		});

		it.each([
			["unknown string", '"ultra"'],
			["null", "null"],
			["number", "7"],
			["array", "[]"],
		])(
			"rejects an invalid thinkingLevel (%s) without changing the file",
			(_label, thinkingLevel) => {
				expectRejectedWithoutWrite(
					configPath,
					`{"scout":{"thinkingLevel":${thinkingLevel}}}`,
					'thinkingLevel for agent "scout" must be a canonical thinking level',
				);
			},
		);
	});

	describe("saveGlobalOverride", () => {
		it("re-reads the latest file and changes only the target agent", () => {
			writeBytes(
				configPath,
				'{"scout":{"model":"old/model"},"stale":{"thinkingLevel":"low"}}',
			);
			expect(loadGlobalConfig(configPath).config).toHaveProperty("stale");

			const preserved = {
				model: "anthropic/claude-sonnet-5",
				thinkingLevel: "high" as const,
			};
			writeBytes(
				configPath,
				JSON.stringify({
					scout: { model: "latest/model", thinkingLevel: "minimal" },
					reviewer: preserved,
				}),
			);

			saveGlobalOverride("scout", { model: "openai/gpt-5.6-sol" }, configPath);

			const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
			expect(saved).toEqual({
				scout: { model: "openai/gpt-5.6-sol" },
				reviewer: preserved,
			});
			expect(JSON.stringify(saved.reviewer)).toBe(JSON.stringify(preserved));
			expect(saved).not.toHaveProperty("stale");
		});

		it("uses an atomic sibling temp, leaves no temp file, and writes readable mode-0600 JSON", () => {
			saveGlobalOverride(
				"scout",
				{ model: "anthropic/claude-sonnet-5", thinkingLevel: "high" },
				configPath,
			);

			expect(fs.readdirSync(path.dirname(configPath))).toEqual([
				GLOBAL_CONFIG_FILENAME,
			]);
			expect(fs.readFileSync(configPath, "utf8")).toBe(
				'{\n  "scout": {\n    "model": "anthropic/claude-sonnet-5",\n    "thinkingLevel": "high"\n  }\n}\n',
			);
			if (process.platform !== "win32") {
				expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
			}
		});

		it("removes the temp sibling and propagates the original error when rename fails", () => {
			const renameError = new Error("rename failed");
			let tempPath = "";
			const rename = vi.mocked(fs.renameSync);
			const unlink = vi.mocked(fs.unlinkSync);

			rename.mockImplementationOnce((source, destination) => {
				tempPath = String(source);
				expect(destination).toBe(configPath);
				expect(tempPath.startsWith(`${configPath}.tmp-`)).toBe(true);
				expect(fs.readFileSync(tempPath, "utf8")).toBe(
					'{\n  "scout": {\n    "model": "provider/model"\n  }\n}\n',
				);
				throw renameError;
			});

			const error = captureError(() => {
				saveGlobalOverride("scout", { model: "provider/model" }, configPath);
			});

			expect(error).toBe(renameError);
			expect(rename).toHaveBeenCalledTimes(1);
			expect(unlink).toHaveBeenCalledTimes(1);
			expect(unlink).toHaveBeenCalledWith(tempPath);
			expect(fs.existsSync(tempPath)).toBe(false);
			expect(fs.readdirSync(path.dirname(configPath))).toEqual([]);
		});

		it("aggregates rename and non-ENOENT cleanup errors", () => {
			const renameError = new Error("rename failed");
			const cleanupError = Object.assign(new Error("cleanup failed"), {
				code: "EACCES",
			});
			let tempPath = "";
			const rename = vi.mocked(fs.renameSync);
			const unlink = vi.mocked(fs.unlinkSync);

			rename.mockImplementationOnce((source, destination) => {
				tempPath = String(source);
				expect(destination).toBe(configPath);
				expect(fs.existsSync(tempPath)).toBe(true);
				throw renameError;
			});
			unlink.mockImplementationOnce((candidate) => {
				expect(candidate).toBe(tempPath);
				throw cleanupError;
			});

			const error = captureError(() => {
				saveGlobalOverride("scout", { model: "provider/model" }, configPath);
			});

			expect(error).toBeInstanceOf(AggregateError);
			const aggregateError = error as AggregateError;
			expect(aggregateError.errors).toHaveLength(2);
			expect(aggregateError.errors[0]).toBe(renameError);
			expect(aggregateError.errors[1]).toBe(cleanupError);
			expect(aggregateError.message).toBe(
				`Failed to write ${configPath} and clean up ${tempPath}`,
			);
			expect(rename).toHaveBeenCalledTimes(1);
			expect(unlink).toHaveBeenCalledTimes(1);
			expect(fs.existsSync(tempPath)).toBe(true);
		});

		it("preserves the original rename error when cleanup sees ENOENT", () => {
			const renameError = new Error("rename failed after temp disappeared");
			let tempPath = "";
			const rename = vi.mocked(fs.renameSync);
			const unlink = vi.mocked(fs.unlinkSync);

			rename.mockImplementationOnce((source, destination) => {
				tempPath = String(source);
				expect(destination).toBe(configPath);
				expect(fs.existsSync(tempPath)).toBe(true);
				fs.unlinkSync(tempPath);
				throw renameError;
			});

			const error = captureError(() => {
				saveGlobalOverride("scout", { model: "provider/model" }, configPath);
			});

			expect(error).toBe(renameError);
			expect(error).not.toBeInstanceOf(AggregateError);
			expect(rename).toHaveBeenCalledTimes(1);
			expect(unlink).toHaveBeenCalledTimes(2);
			expect(unlink).toHaveBeenNthCalledWith(1, tempPath);
			expect(unlink).toHaveBeenNthCalledWith(2, tempPath);
			expect(fs.existsSync(tempPath)).toBe(false);
		});

		it("omits undefined fields for model-only and thinking-only overrides", () => {
			saveGlobalOverride(
				"model-only",
				{ model: "openai/gpt-5.6-sol", thinkingLevel: undefined },
				configPath,
			);
			saveGlobalOverride(
				"thinking-only",
				{ model: undefined, thinkingLevel: "xhigh" },
				configPath,
			);

			const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
			expect(saved).toEqual({
				"model-only": { model: "openai/gpt-5.6-sol" },
				"thinking-only": { thinkingLevel: "xhigh" },
			});
			expect("thinkingLevel" in saved["model-only"]).toBe(false);
			expect("model" in saved["thinking-only"]).toBe(false);
		});

		it("deliberately allows an empty override after pruning undefined fields", () => {
			saveGlobalOverride(
				"scout",
				{ model: undefined, thinkingLevel: undefined },
				configPath,
			);

			expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
				scout: {},
			});
		});
	});

	describe("resetGlobalOverride", () => {
		it("removes only the target agent", () => {
			const preserved = { model: "openai/gpt-5.6-sol", thinkingLevel: "max" };
			writeBytes(
				configPath,
				JSON.stringify({
					scout: { model: "anthropic/claude-sonnet-5" },
					executor: preserved,
				}),
			);

			resetGlobalOverride("scout", configPath);

			expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
				executor: preserved,
			});
		});

		it("is a byte-preserving no-op when the agent is missing from an existing file", () => {
			const originalBytes = writeBytes(
				configPath,
				'{ "scout" : { "model" : "provider/model" } }\n',
			);

			resetGlobalOverride("reviewer", configPath);

			expect(readBytes(configPath)).toEqual(originalBytes);
		});

		it("does not create a file when both the file and agent are missing", () => {
			resetGlobalOverride("scout", configPath);

			expect(fs.existsSync(configPath)).toBe(false);
			expect(fs.existsSync(path.dirname(configPath))).toBe(false);
		});
	});

	it.each(["save", "reset"] as const)(
		"%s refuses malformed JSON and preserves its exact bytes",
		(operation) => {
			const malformed = '{"scout":{"model":';
			const originalBytes = writeBytes(configPath, malformed);
			const expectedError = `${configPath}: ${parseErrorMessage(malformed)}`;

			const error = captureError(() => {
				if (operation === "save") {
					saveGlobalOverride("scout", { model: "provider/model" }, configPath);
				} else {
					resetGlobalOverride("scout", configPath);
				}
			});

			expect(error.message).toBe(expectedError);
			expect(readBytes(configPath)).toEqual(originalBytes);
		},
	);
});
