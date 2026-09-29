import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Bind configured !commands to the child's cwd without changing process.cwd(). */
export function bindCommandValues(value: unknown, cwd: string): unknown {
	if (typeof value === "string" && value.startsWith("!")) {
		const absolute = resolve(cwd);
		const cd = process.platform === "win32"
			? `cd /d "${absolute}"`
			: `cd '${absolute.replace(/'/g, `'\\''`)}'`;
		return `!${cd} && ${value.slice(1)}`;
	}
	if (Array.isArray(value)) return value.map((item) => bindCommandValues(item, cwd));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindCommandValues(item, cwd)]));
	}
	return value;
}

export async function createChildModelRuntime(cwd: string, agentDir: string, signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Subagent was aborted");
	const modelsPath = join(agentDir, "models.json");
	let original: string | undefined;
	try { original = readFileSync(modelsPath, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let temporaryDir: string | undefined;
	let childModelsPath = modelsPath;
	if (original !== undefined) {
		const config = JSON.parse(original);
		// Only credential/header values are executable Pi config, not model IDs,
		// labels, or other string fields that happen to begin with '!'.
		for (const provider of Object.values(config.providers ?? {}) as Record<string, unknown>[]) {
			if (provider.apiKey !== undefined) provider.apiKey = bindCommandValues(provider.apiKey, cwd);
			if (provider.headers !== undefined) provider.headers = bindCommandValues(provider.headers, cwd);
			for (const model of (provider.models ?? []) as Record<string, unknown>[]) {
				if (model.headers !== undefined) model.headers = bindCommandValues(model.headers, cwd);
			}
			for (const override of Object.values(provider.modelOverrides ?? {}) as Record<string, unknown>[]) {
				if (override.headers !== undefined) override.headers = bindCommandValues(override.headers, cwd);
			}
		}
		const modified = JSON.stringify(config);
		if (JSON.stringify(JSON.parse(original)) !== modified) {
			temporaryDir = mkdtempSync(join(tmpdir(), "pi-subagent-models-"));
			childModelsPath = join(temporaryDir, "models.json");
			writeFileSync(childModelsPath, modified, { mode: 0o600 });
		}
	}
	const cleanup = () => { if (temporaryDir) rmSync(temporaryDir, { recursive: true, force: true }); };
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: childModelsPath,
			modelsStorePath: join(agentDir, "models-store.json"),
		});
		if (signal?.aborted) throw new Error("Subagent was aborted");
		return { modelRuntime, cleanup };
	} catch (error) { cleanup(); throw error; }
}
