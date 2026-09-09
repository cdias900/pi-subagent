export function hasTerminalFailure(result: { stopReason?: string }): boolean {
	return ["error", "aborted", "length"].includes(result.stopReason ?? "");
}

/** Process exit and the final model stop reason are separate completion signals. */
export function isSuccessfulResult(result: { exitCode: number; stopReason?: string; completionSignal?: "done" | "error" }): boolean {
	return !hasTerminalFailure(result) &&
		result.completionSignal !== "error" &&
		(result.completionSignal === "done" || result.exitCode === 0);
}

/** A signal-terminated process has no exit code; it did not exit successfully. */
export function processExitCode(code: number | null): number {
	return code ?? 1;
}
