import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const ROLE_PROMPT_FLAG = "subagent-role-prompt";

export interface ChildPromptEvent {
	systemPrompt: string;
	systemPromptOptions?: { appendSystemPrompt?: string };
}

/** Keep Pi's discovery, trust decisions, and context-file ordering intact. */
export function addRoleToSystemPrompt(event: ChildPromptEvent, role: string): string {
	if (!role.trim()) return event.systemPrompt;
	const append = event.systemPromptOptions?.appendSystemPrompt;
	if (append) {
		const start = event.systemPrompt.indexOf(append);
		if (start !== -1 && start === event.systemPrompt.lastIndexOf(append)) {
			const end = start + append.length;
			return `${event.systemPrompt.slice(0, end)}\n\n${role}${event.systemPrompt.slice(end)}`;
		}
	}

	// Older hosts lack structured options. Also preserve an earlier extension's
	// rewrite if the original append section can no longer be located uniquely.
	return `${role}\n\n${event.systemPrompt}`;
}

export default function childSystemPrompt(pi: ExtensionAPI) {
	pi.registerFlag(ROLE_PROMPT_FLAG, {
		type: "string",
		description: "Internal subagent role prompt file",
	});
	let role: string | undefined;
	pi.on("before_agent_start", (event) => {
		const promptPath = pi.getFlag(ROLE_PROMPT_FLAG);
		if (typeof promptPath !== "string" || !promptPath) return;
		role ??= readFileSync(promptPath, "utf-8");
		return { systemPrompt: addRoleToSystemPrompt(event, role) };
	});
}
