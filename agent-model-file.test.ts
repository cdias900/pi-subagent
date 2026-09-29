import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

const fsHooks = vi.hoisted((): {
	afterFsync: (() => void) | undefined;
	renameError: Error | undefined;
} => ({ afterFsync: undefined, renameError: undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		fsyncSync(fd: number) {
			actual.fsyncSync(fd);
			fsHooks.afterFsync?.();
		},
		renameSync(oldPath: fs.PathLike, newPath: fs.PathLike) {
			if (fsHooks.renameError !== undefined) throw fsHooks.renameError;
			actual.renameSync(oldPath, newPath);
		},
	};
});
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import { persistAgentModelFile } from "./agent-model-file.js";

function config(
	filePath: string,
	overrides: Partial<AgentConfig> = {},
): AgentConfig {
	return {
		name: "selected-agent",
		description: "Selected agent",
		systemPrompt: "stale discovery body",
		source: "user",
		filePath,
		...overrides,
	};
}

describe("persistAgentModelFile", () => {
	let root: string;
	let agentsDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-file-"));
		agentsDir = path.join(root, "agents");
		fs.mkdirSync(agentsDir);
		process.env.PI_CODING_AGENT_DIR = root;
	});

	afterEach(() => {
		fsHooks.afterFsync = undefined;
		fsHooks.renameError = undefined;
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.chmodSync(agentsDir, 0o700);
		for (const entry of fs.readdirSync(agentsDir)) {
			try {
				fs.chmodSync(path.join(agentsDir, entry), 0o600);
			} catch {
				// A dangling symlink or already-removed test file needs no cleanup.
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("inserts a normalized model in the selected file while preserving all other bytes and mode", () => {
		const filePath = path.join(agentsDir, "filename-does-not-match.md");
		const original = [
			"---",
			"# identity comment",
			"name: selected-agent",
			"description: Selected agent",
			"parameters:",
			"  type: object",
			"  properties:",
			"    model:",
			"      type: string",
			"---",
			"Prompt body with a delimiter:",
			"---",
			"and no final newline",
		].join("\n");
		fs.writeFileSync(filePath, original, { mode: 0o640 });
		fs.chmodSync(filePath, 0o640);

		const result = persistAgentModelFile(config(filePath), {
			model: "provider/new-model:low",
			thinkingLevel: "high",
		});

		const expected = original.replace(
			"---\nPrompt body",
			'model: "provider/new-model:high"\n---\nPrompt body',
		);
		expect(fs.readFileSync(filePath, "utf8")).toBe(expected);
		expect(fs.statSync(filePath).mode & 0o777).toBe(0o640);
		expect(result).toEqual({
			config: {
				...config(filePath),
				model: "provider/new-model:high",
			},
			path: filePath,
			changed: true,
		});
		expect(fs.readdirSync(agentsDir)).toEqual(["filename-does-not-match.md"]);
	});

	it("replaces only the top-level scalar and clears its old reasoning suffix", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"name: selected-agent",
			"description: Selected agent",
			'model: "old/provider-model:high" # keep this comment',
			"parameters:",
			"  properties:",
			"    model: { type: string } # nested model stays",
			"---",
			"Body bytes",
			"",
		].join("\n");
		fs.writeFileSync(filePath, original);

		persistAgentModelFile(config(filePath), {
			model: "provider/model:release",
		});

		expect(fs.readFileSync(filePath, "utf8")).toBe(
			original.replace(
				'"old/provider-model:high"',
				'"provider/model:release"',
			),
		);
	});

	it("replaces a multiline model value without touching the following fields or body", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"name: selected-agent",
			"description: Selected agent",
			"model: >- # model note",
			"  provider/old-model:high",
			"tools: read, bash # untouched",
			"---",
			"Body",
		].join("\n");
		fs.writeFileSync(filePath, original);

		persistAgentModelFile(config(filePath), {
			model: "provider/new-model",
		});

		expect(fs.readFileSync(filePath, "utf8")).toBe(
			[
				"---",
				"name: selected-agent",
				"description: Selected agent",
				'model: "provider/new-model" # model note',
				"tools: read, bash # untouched",
				"---",
				"Body",
			].join("\n"),
		);
	});

	it("removes only the top-level model with CRLF and preserves a delimiter in a no-newline body", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"name: selected-agent",
			"description: Selected agent",
			'model: "provider/model:high" # removed with the field',
			"parameters:",
			"  properties:",
			"    model: { type: string }",
			"---",
			"body",
			"---",
			"still body",
		].join("\r\n");
		fs.writeFileSync(filePath, original);

		const result = persistAgentModelFile(config(filePath), { model: undefined });

		expect(fs.readFileSync(filePath, "utf8")).toBe(
			original.replace(
				'model: "provider/model:high" # removed with the field\r\n',
				"",
			),
		);
		expect(result.config.model).toBeUndefined();
		expect(result.changed).toBe(true);
	});

	it("is a byte- and inode-preserving no-op when reset finds no model", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = "---\nname: selected-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(filePath, original);
		const inode = fs.statSync(filePath).ino;

		const result = persistAgentModelFile(config(filePath), { model: undefined });

		expect(result.changed).toBe(false);
		expect(fs.readFileSync(filePath, "utf8")).toBe(original);
		expect(fs.statSync(filePath).ino).toBe(inode);
	});

	it.each(["bundled", "project"] as const)("rejects a %s agent without reading or editing its file", (source) => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = "---\nname: selected-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(filePath, original);

		expect(() =>
			persistAgentModelFile(config(filePath, { source }), {
				model: "provider/model",
			}),
		).toThrow(/only user-source agents are editable/);
		expect(fs.readFileSync(filePath, "utf8")).toBe(original);
	});

	it("rejects outside paths and final symlinks", () => {
		const outside = path.join(root, "outside.md");
		const target = path.join(agentsDir, "target.md");
		const link = path.join(agentsDir, "selected.md");
		const original = "---\nname: selected-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(outside, original);
		fs.writeFileSync(target, original);
		fs.symlinkSync(target, link);

		expect(() =>
			persistAgentModelFile(config(outside), { model: "provider/model" }),
		).toThrow(/outside the user agents directory/);
		expect(() =>
			persistAgentModelFile(config(link), { model: "provider/model" }),
		).toThrow(/symbolic-link agent files are not editable/);
		expect(fs.readFileSync(outside, "utf8")).toBe(original);
		expect(fs.readFileSync(target, "utf8")).toBe(original);
	});

	it("rejects stale selections, missing files, and read-only files", () => {
		const stale = path.join(agentsDir, "stale.md");
		const readOnly = path.join(agentsDir, "read-only.md");
		const original = "---\nname: renamed-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(stale, original);
		fs.writeFileSync(
			readOnly,
			"---\nname: selected-agent\ndescription: Selected agent\n---\nBody",
		);
		fs.chmodSync(readOnly, 0o444);

		expect(() =>
			persistAgentModelFile(config(stale), { model: "provider/model" }),
		).toThrow(/not the selected agent/);
		expect(() =>
			persistAgentModelFile(config(path.join(agentsDir, "missing.md")), {
				model: "provider/model",
			}),
		).toThrow(/cannot inspect the selected file/);
		expect(() =>
			persistAgentModelFile(config(readOnly), { model: "provider/model" }),
		).toThrow(/read-only/);
		expect(fs.readFileSync(stale, "utf8")).toBe(original);
	});

	it("rejects a terminator that agent discovery would interpret before the editor boundary", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"name: selected-agent",
			"description: Selected agent",
			"---extra: discovery stops here",
			"model: provider/old",
			"---",
			"Body",
		].join("\n");
		fs.writeFileSync(filePath, original);

		for (const change of [
			{ model: "provider/new" },
			{ model: undefined },
		] as const) {
			expect(() => persistAgentModelFile(config(filePath), change)).toThrow(
				/ambiguous frontmatter terminator/,
			);
			expect(fs.readFileSync(filePath, "utf8")).toBe(original);
		}
	});

	it("rejects a model key supplied through a YAML alias", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"name: selected-agent",
			"description: Selected agent",
			"modelKey: &key model",
			"*key : provider/old",
			"---",
			"Body",
		].join("\n");
		fs.writeFileSync(filePath, original);

		expect(() =>
			persistAgentModelFile(config(filePath), { model: "provider/new" }),
		).toThrow(/non-scalar top-level "model" keys/);
		expect(fs.readFileSync(filePath, "utf8")).toBe(original);
	});

	it("preserves uniform root-map indentation when inserting model", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"  name: selected-agent",
			"  description: Selected agent",
			"---",
			"Body",
		].join("\n");
		fs.writeFileSync(filePath, original);

		persistAgentModelFile(config(filePath), { model: "provider/new" });

		expect(fs.readFileSync(filePath, "utf8")).toBe(
			original.replace("---\nBody", '  model: "provider/new"\n---\nBody'),
		);
	});

	it("edits a CR-only agent consistently with discovery normalization", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = [
			"---",
			"name: selected-agent",
			"description: Selected agent",
			"model: provider/old:high",
			"---",
			"Body",
		].join("\r");
		fs.writeFileSync(filePath, original);

		persistAgentModelFile(config(filePath), { model: "provider/new" });

		expect(fs.readFileSync(filePath, "utf8")).toBe(
			original.replace("provider/old:high", '"provider/new"'),
		);
	});

	it.each([
		{
			label: "duplicate model keys",
			yaml: "name: selected-agent\ndescription: Selected agent\nmodel: provider/one\nmodel: provider/two\n",
		},
		{
			label: "flow-style frontmatter",
			yaml: "{ name: selected-agent, description: Selected agent, model: provider/old }\n",
		},
		{
			label: "anchored model",
			yaml: "name: selected-agent\ndescription: Selected agent\nmodel: &chosen provider/old\ncopy: *chosen\n",
		},
	])("rejects $label without mutation", ({ yaml }) => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = `---\n${yaml}---\nBody`;
		fs.writeFileSync(filePath, original);

		expect(() =>
			persistAgentModelFile(config(filePath), { model: "provider/new" }),
		).toThrow();
		expect(fs.readFileSync(filePath, "utf8")).toBe(original);
		expect(fs.readdirSync(agentsDir)).toEqual(["selected.md"]);
	});

	it.each([
		{ model: "model-without-provider" },
		{ model: "provider/" },
		{ model: " provider/model" },
		{ model: "provider/model", thinkingLevel: "turbo" },
	])("rejects invalid model selection %# without mutation", (change) => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = "---\nname: selected-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(filePath, original);

		expect(() =>
			persistAgentModelFile(config(filePath), change as never),
		).toThrow();
		expect(fs.readFileSync(filePath, "utf8")).toBe(original);
	});

	it("detects a concurrent content change and removes its temporary file", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = "---\nname: selected-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(filePath, original);
		fsHooks.afterFsync = () => {
			fsHooks.afterFsync = undefined;
			fs.appendFileSync(filePath, "\nexternal edit");
		};

		expect(() =>
			persistAgentModelFile(config(filePath), { model: "provider/model" }),
		).toThrow(/changed concurrently/);
		expect(fs.readFileSync(filePath, "utf8")).toBe(`${original}\nexternal edit`);
		expect(fs.readdirSync(agentsDir)).toEqual(["selected.md"]);
	});

	it("preserves the original and cleans the temporary file when rename fails", () => {
		const filePath = path.join(agentsDir, "selected.md");
		const original = "---\nname: selected-agent\ndescription: Selected agent\n---\nBody";
		fs.writeFileSync(filePath, original);
		fsHooks.renameError = new Error("injected rename failure");

		expect(() =>
			persistAgentModelFile(config(filePath), { model: "provider/model" }),
		).toThrow(/injected rename failure/);
		expect(fs.readFileSync(filePath, "utf8")).toBe(original);
		expect(fs.readdirSync(agentsDir)).toEqual(["selected.md"]);
	});
});
