/**
 * Regression: project-local agent discovery must honor `params.cwd`.
 *
 * Bug: the `subagent` execute handler discovered project-local `.pi/agents`
 * relative to `ctx.cwd` instead of `params.cwd`, so an explicit `cwd` passed by
 * the caller (pointing at a project with `.pi/agents`) was ignored for agent
 * discovery even though it was used for the spawned child process. The fix
 * routes list_subagents / describe_agent / subagent discovery through a single
 * shared seam — `resolveScopeDiscovery(params, ctx.cwd)` — so all three share
 * `params.cwd ?? ctx.cwd` semantics.
 *
 * This file exercises that seam behaviorally with two distinct temporary
 * directories (host ctx cwd vs. target project cwd), and adds a thin wiring
 * guard that the `subagent` execute handler still funnels discovery through the
 * shared helper rather than calling `discoverAgents` directly.
 *
 * Importing index.ts does NOT trigger extension registration — the default
 * export (the extension entry point) is only invoked by pi when loading the
 * extension, never at module-eval time. So importing `resolveScopeDiscovery` is
 * safe and side-effect free.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveScopeDiscovery } from "./index.js";

const INDEX_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

/** A unique project-only agent name so tmpdir ancestor `.pi/agents` pollution
 * (if any) cannot masquerade as a success. We assert presence/absence of this
 * specific name, never total agent counts. */
const PROJ_ONLY = "proj-only-cwd-regression-9f3a";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProjectAgent(projectDir: string, name: string): string {
	const agentsDir = path.join(projectDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const file = path.join(agentsDir, `${name}.md`);
	fs.writeFileSync(
		file,
		`---\nname: ${name}\ndescription: project-only regression agent\n---\nSystem prompt body for ${name}.\n`,
		"utf-8",
	);
	return file;
}

describe("resolveScopeDiscovery — project-local cwd", () => {
	let hostDir: string;
	let projectDir: string;

	beforeEach(() => {
		hostDir = makeTempDir("pi-subagent-host-");
		projectDir = makeTempDir("pi-subagent-project-");
		writeProjectAgent(projectDir, PROJ_ONLY);
	});

	afterEach(() => {
		for (const d of [hostDir, projectDir]) {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});

	it("finds the project agent when params.cwd points at the project", () => {
		const discovery = resolveScopeDiscovery(
			{ cwd: projectDir, agentScope: "both" },
			hostDir,
		);
		const found = discovery.agents.find((a) => a.name === PROJ_ONLY);
		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
		expect(discovery.projectAgentsDir).toBe(path.join(projectDir, ".pi", "agents"));
	});

	it("does NOT find the project agent when params.cwd is omitted (ctx fallback)", () => {
		// Distinct host cwd must not discover the project's agents.
		const discovery = resolveScopeDiscovery({ agentScope: "both" }, hostDir);
		const found = discovery.agents.find((a) => a.name === PROJ_ONLY);
		expect(found).toBeUndefined();
	});

	it("excludes project agents by default scope even with correct cwd", () => {
		// agentScope omitted => defaults to "user"; project agent excluded.
		const discovery = resolveScopeDiscovery({ cwd: projectDir }, hostDir);
		const found = discovery.agents.find((a) => a.name === PROJ_ONLY);
		expect(found).toBeUndefined();
	});

	it("falls back to ctx.cwd when params.cwd is undefined (matches list/describe)", () => {
		// Sanity: with the project dir as ctx cwd and no params.cwd, the
		// project agent IS found — proving the fallback path works and mirrors
		// the pre-fix list_subagents/describe_agent behavior.
		const discovery = resolveScopeDiscovery({ agentScope: "both" }, projectDir);
		const found = discovery.agents.find((a) => a.name === PROJ_ONLY);
		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
	});
});

describe("subagent execute wiring", () => {
	it("funnels discovery through resolveScopeDiscovery, not discoverAgents directly", () => {
		const src = fs.readFileSync(INDEX_TS, "utf-8");

		// The three tool execute handlers must all call the shared seam. We assert
		// a minimum (not an exact count) so the guard is not brittle to incidental
		// call-site additions.
		const seamCalls = src.match(/resolveScopeDiscovery\(params,\s*ctx\.cwd\)/g);
		expect(seamCalls?.length ?? 0).toBeGreaterThanOrEqual(3);

		// The regressed form — discoverAgents(ctx.cwd, agentScope) directly inside
		// the subagent execute handler — must not survive.
		const directInHandler = src.match(/discoverAgents\(ctx\.cwd,\s*agentScope\)/);
		expect(
			directInHandler,
			"subagent execute must not call discoverAgents(ctx.cwd, agentScope) directly",
		).toBeNull();
	});
});
