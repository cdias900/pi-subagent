/**
 * Minimal extension that registers the __bg_signal tool for background agent child processes.
 * Loaded via `-e` in the child pi process so the LLM's __bg_signal calls succeed
 * instead of erroring with "unknown tool". The parent process detects the signal
 * from the stdout event stream and handles state transitions.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function bgSignalExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "__bg_signal",
		label: "Background Signal",
		description:
			"Signal your current status to the parent orchestrator. " +
			"Call when your task is complete, you need input, or you hit an unrecoverable error.",
		parameters: Type.Object({
			status: Type.String({ description: "Signal type: 'done', 'question', or 'error'" }),
			summary: Type.Optional(Type.String({ description: "Summary of what was accomplished (for done)" })),
			question: Type.Optional(Type.String({ description: "What you need from the parent (for question)" })),
			error: Type.Optional(Type.String({ description: "Error description (for error)" })),
		}),
		async execute(_toolCallId, params) {
			// The parent process reads this from the stdout event stream.
			// We just return a success so the child LLM doesn't see an error.
			return {
				content: [{ type: "text", text: `Signal acknowledged: ${params.status}` }],
			};
		},
	});
}
