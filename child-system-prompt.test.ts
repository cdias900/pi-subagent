import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import childSystemPrompt, {
	addRoleToSystemPrompt,
	ROLE_PROMPT_FLAG,
	type ChildPromptEvent,
} from "./child-system-prompt.js";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("child role prompt", () => {
	it("retains discovered APPEND before the role and AGENTS context afterward", () => {
		const result = addRoleToSystemPrompt({
			systemPrompt: "Pi defaults\n\nShared guidance\n\nRepository guidance",
			systemPromptOptions: { appendSystemPrompt: "Shared guidance" },
		}, "Review the change");
		expect(result).toBe("Pi defaults\n\nShared guidance\n\nReview the change\n\nRepository guidance");
	});

	it("preserves earlier and later extension additions", () => {
		const earlier = "Earlier extension\nPi defaults\n\nShared guidance\n\nRepository guidance\nEarlier suffix";
		const result = addRoleToSystemPrompt({
			systemPrompt: earlier,
			systemPromptOptions: { appendSystemPrompt: "Shared guidance" },
		}, "Review the change") + "\nLater extension";
		expect(result).toBe("Earlier extension\nPi defaults\n\nShared guidance\n\nReview the change\n\nRepository guidance\nEarlier suffix\nLater extension");
	});

	it.each([
		["older host", undefined, "Pi defaults\n\nRepository guidance"],
		["no append file", {}, "Pi defaults\n\nRepository guidance"],
		["rewritten append", { appendSystemPrompt: "Original shared guidance" }, "Customized shared guidance\n\nRepository guidance"],
		["ambiguous append", { appendSystemPrompt: "Repeated" }, "Repeated\n\nRepository guidance: Repeated"],
	] as const)("keeps existing guidance intact for %s", (_name, systemPromptOptions, systemPrompt) => {
		expect(addRoleToSystemPrompt({ systemPrompt, systemPromptOptions }, "Review the change"))
			.toBe(`Review the change\n\n${systemPrompt}`);
	});

	it("does not change the incoming prompt for an empty role", () => {
		expect(addRoleToSystemPrompt({ systemPrompt: "Existing guidance" }, " \n"))
			.toBe("Existing guidance");
	});

	it("reads only the role file and does not accumulate it over RPC continuations", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-child-prompt-"));
		directories.push(dir);
		const promptFile = join(dir, "role.md");
		writeFileSync(promptFile, "Review the change\nUse __bg_signal when finished.");
		let handler!: (event: ChildPromptEvent) => { systemPrompt: string } | undefined;
		const registerFlag = vi.fn();
		childSystemPrompt({
			registerFlag,
			getFlag: (name: string) => name === ROLE_PROMPT_FLAG ? promptFile : undefined,
			on: (_event: string, callback: typeof handler) => { handler = callback; },
		} as unknown as ExtensionAPI);
		expect(registerFlag).toHaveBeenCalledWith(ROLE_PROMPT_FLAG, expect.objectContaining({ type: "string" }));
		const event = {
			systemPrompt: "Pi defaults\n\nShared guidance\n\nRepository guidance",
			systemPromptOptions: { appendSystemPrompt: "Shared guidance" },
		};
		const first = handler(event)!.systemPrompt;
		expect(readFileSync(promptFile, "utf-8")).toBe("Review the change\nUse __bg_signal when finished.");
		rmSync(promptFile);
		const resumed = handler(event)!.systemPrompt;
		expect(resumed).toBe(first);
		expect(resumed.split("Review the change")).toHaveLength(2);
		expect(resumed.split("Shared guidance")).toHaveLength(2);
		expect(resumed.split("__bg_signal")).toHaveLength(2);
		expect(event.systemPrompt).not.toContain("Review the change");
	});
});
