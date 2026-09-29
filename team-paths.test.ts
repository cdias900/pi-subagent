import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCoordinationTools } from "./coordination.js";
import { deleteTeam, getTeamDir, getTeamsDir, loadOutput, saveOutput, validateTeamPathName } from "./team.js";
import { join } from "node:path";

const unsafe = ["", ".", "..", "../..", "../../Documents", "/tmp/elsewhere", "nested/team", "nested\\team", "C:\\Users\\someone", "bad\0name"];

describe("team filesystem boundaries", () => {
	it.each(unsafe)("rejects team path %j before deleting or creating anything", (name) => {
		expect(() => getTeamDir(name)).toThrow("not a path");
		expect(() => deleteTeam(name)).toThrow("not a path");
	});
	it.each(unsafe)("rejects output path %j before filesystem access", (name) => {
		expect(() => saveOutput("fixture", name, "synthetic")).toThrow("not a path");
		expect(() => loadOutput("fixture", name)).toThrow("not a path");
	});
	it("preserves ordinary, Unicode, and space-containing names", () => {
		for (const name of ["sdk-release", "my project", "pédro", ".hidden", "agent-1"]) {
			expect(() => validateTeamPathName(name)).not.toThrow();
			expect(getTeamDir(name)).toBe(join(getTeamsDir(), name));
		}
	});
	it("enforces the same boundary through the registered TeamDelete tool", async () => {
		let remove: ((...args: unknown[]) => Promise<unknown>) | undefined;
		registerCoordinationTools({ registerTool(definition: { name: string; execute: typeof remove }) {
			if (definition.name === "TeamDelete") remove = definition.execute;
		} } as unknown as ExtensionAPI);
		expect(remove).toBeTypeOf("function");
		await expect(remove!("test", { team_name: "../.." }, undefined, undefined, {})).rejects.toThrow("not a path");
	});
});
