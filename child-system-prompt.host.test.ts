import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSystemPromptArgs } from "./test/legacy-cli-options.js";
import childSystemPrompt, { ROLE_PROMPT_FLAG, type ChildPromptEvent } from "./child-system-prompt.js";

// Point this at an installed Pi package root. No CLI, session, configured inline
// factory, provider, or model is started. One test loads only our child extension.
const hostRoot = process.env.PI_SUBAGENT_HOST_ROOT;
const modes = ["foreground", "background", "resumed RPC"] as const;

describe.skipIf(!hostRoot)("installed Pi child prompt contract", () => {
	let parseArgs: (args: string[]) => any;
	let DefaultResourceLoader: any;
	let SettingsManager: any;
	let buildSystemPrompt: (options: any) => string;
	let root: string;
	let cwd: string;
	let agentDir: string;
	let promptPath: string;

	beforeAll(async () => {
		const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(hostRoot!, "dist", file)).href);
		({ parseArgs } = await load("cli/args.js"));
		({ DefaultResourceLoader } = await load("core/resource-loader.js"));
		({ SettingsManager } = await load("core/settings-manager.js"));
		({ buildSystemPrompt } = await load("core/system-prompt.js"));
	});

	beforeEach(() => {
		vi.stubGlobal("fetch", () => { throw new Error("Network is disabled in prompt contract tests"); });
		root = mkdtempSync(join(tmpdir(), "pi-prompt-host-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		promptPath = join(root, "role.md");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir);
		writeFileSync(join(root, "personal-core.md"), "\uFEFFGLOBAL_CORE_MARKER");
		symlinkSync(join(root, "personal-core.md"), join(agentDir, "APPEND_SYSTEM.md"));
		writeFileSync(join(agentDir, "SYSTEM.md"), "SYSTEM_BINDING_MARKER");
		writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_AGENTS_MARKER");
		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_AGENTS_MARKER");
		writeFileSync(join(cwd, "CLAUDE.md"), "SHADOWED_CLAUDE_MARKER");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	async function loadPrompt(mode: typeof modes[number], options: {
		replace?: boolean;
		noContextFiles?: boolean;
		trusted?: boolean;
		loadExtension?: boolean;
	} = {}) {
		const role = mode === "foreground" ? "ROLE_MARKER" : "ROLE_MARKER\n__bg_signal";
		writeFileSync(promptPath, role);
		const args = [
			"--mode", mode === "foreground" ? "json" : "rpc",
			"--no-session", "--no-extensions",
			...buildSystemPromptArgs({
				promptFilePath: promptPath,
				systemPromptMode: options.replace ? "replace" : "append",
				noContextFiles: options.noContextFiles,
			}),
		];
		const parsed = parseArgs(args);
		expect(parsed.diagnostics).toEqual([]);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: options.trusted ?? true }),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: parsed.noContextFiles,
			systemPrompt: parsed.systemPrompt,
			appendSystemPrompt: parsed.appendSystemPrompt,
			additionalExtensionPaths: options.loadExtension ? parsed.extensions : [],
			extensionFactories: [],
		});
		await loader.reload();
		const loadedExtensions = loader.getExtensions();
		expect(loadedExtensions.extensions).toHaveLength(options.loadExtension ? 1 : 0);
		expect(loadedExtensions.errors).toEqual([]);
		const systemPromptOptions = {
			cwd,
			customPrompt: loader.getSystemPrompt(),
			appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
			contextFiles: loader.getAgentsFiles().agentsFiles,
			skills: [],
			selectedTools: [],
		};
		const base = buildSystemPrompt(systemPromptOptions);
		let prompt = base;
		if (!options.replace) {
			expect(args).not.toContain("--append-system-prompt");
			expect(parsed.unknownFlags.get(ROLE_PROMPT_FLAG)).toBe(promptPath);
			let handler!: (event: ChildPromptEvent) => { systemPrompt: string } | undefined;
			if (options.loadExtension) {
				const extension = loadedExtensions.extensions[0];
				expect(extension.flags.get(ROLE_PROMPT_FLAG).type).toBe("string");
				loadedExtensions.runtime.flagValues.set(ROLE_PROMPT_FLAG, parsed.unknownFlags.get(ROLE_PROMPT_FLAG));
				handler = extension.handlers.get("before_agent_start")[0];
			} else {
				childSystemPrompt({
					registerFlag() {},
					getFlag: (name: string) => parsed.unknownFlags.get(name),
					on: (_event: string, callback: typeof handler) => { handler = callback; },
				} as unknown as ExtensionAPI);
			}
			const event = { systemPrompt: base, systemPromptOptions };
			prompt = handler(event)!.systemPrompt;
			if (mode === "resumed RPC") {
				expect(handler(event)!.systemPrompt).toBe(prompt);
				expect(handler(event)!.systemPrompt).toBe(prompt);
			}
		}
		return { prompt, loader, args };
	}

	it.each(modes)("%s retains global APPEND once and repository context after the role", async (mode) => {
		const { prompt } = await loadPrompt(mode);
		for (const marker of ["SYSTEM_BINDING_MARKER", "GLOBAL_CORE_MARKER", "ROLE_MARKER", "GLOBAL_AGENTS_MARKER", "PROJECT_AGENTS_MARKER"]) {
			expect(prompt.split(marker)).toHaveLength(2);
		}
		expect(prompt.indexOf("GLOBAL_CORE_MARKER")).toBeLessThan(prompt.indexOf("ROLE_MARKER"));
		expect(prompt.indexOf("ROLE_MARKER")).toBeLessThan(prompt.indexOf("GLOBAL_AGENTS_MARKER"));
		expect(prompt.indexOf("GLOBAL_AGENTS_MARKER")).toBeLessThan(prompt.indexOf("PROJECT_AGENTS_MARKER"));
		expect(prompt).not.toContain("SHADOWED_CLAUDE_MARKER");
		if (mode !== "foreground") expect(prompt.split("__bg_signal")).toHaveLength(2);
	});

	it("uses a trusted project APPEND instead of duplicating global guidance", async () => {
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT_CORE_MARKER");
		const { prompt } = await loadPrompt("foreground");
		expect(prompt).not.toContain("GLOBAL_CORE_MARKER");
		expect(prompt.split("PROJECT_CORE_MARKER")).toHaveLength(2);
		expect(prompt.indexOf("PROJECT_CORE_MARKER")).toBeLessThan(prompt.indexOf("ROLE_MARKER"));
	});

	it("does not bypass the host's untrusted-project APPEND decision", async () => {
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "UNTRUSTED_CORE_MARKER");
		const { prompt } = await loadPrompt("background", { trusted: false });
		expect(prompt).not.toContain("UNTRUSTED_CORE_MARKER");
		expect(prompt.split("GLOBAL_CORE_MARKER")).toHaveLength(2);
		expect(prompt.split("ROLE_MARKER")).toHaveLength(2);
	});

	it("keeps one maintained APPEND body when project and global files share a target", async () => {
		symlinkSync(join(root, "personal-core.md"), join(cwd, ".pi", "APPEND_SYSTEM.md"));
		const { prompt } = await loadPrompt("resumed RPC");
		expect(prompt.split("GLOBAL_CORE_MARKER")).toHaveLength(2);
	});

	it.each(modes)("%s replace isolation suppresses both discovered APPEND and AGENTS", async (mode) => {
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT_CORE_MARKER");
		const { prompt, loader, args } = await loadPrompt(mode, { replace: true });
		expect(args).not.toContain(`--${ROLE_PROMPT_FLAG}`);
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
		for (const marker of ["GLOBAL_CORE_MARKER", "PROJECT_CORE_MARKER", "SYSTEM_BINDING_MARKER", "GLOBAL_AGENTS_MARKER", "PROJECT_AGENTS_MARKER"]) {
			expect(prompt).not.toContain(marker);
		}
		expect(prompt.split("ROLE_MARKER")).toHaveLength(2);
	});

	it("noContextFiles keeps its host meaning without disabling APPEND", async () => {
		const { prompt } = await loadPrompt("foreground", { noContextFiles: true });
		expect(prompt).toContain("GLOBAL_CORE_MARKER");
		expect(prompt).toContain("ROLE_MARKER");
		expect(prompt).not.toContain("GLOBAL_AGENTS_MARKER");
		expect(prompt).not.toContain("PROJECT_AGENTS_MARKER");
	});

	it("loads the emitted child extension and consumes its CLI flag on continuation", async () => {
		const { prompt } = await loadPrompt("resumed RPC", { loadExtension: true });
		for (const marker of ["GLOBAL_CORE_MARKER", "ROLE_MARKER", "__bg_signal", "PROJECT_AGENTS_MARKER"]) {
			expect(prompt.split(marker)).toHaveLength(2);
		}
	});
});
