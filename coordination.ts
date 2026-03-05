/**
 * Team coordination tools — compatible with Claude Code Agent Teams.
 *
 * Registers: TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskList, SendMessage.
 * These are the same primitives used by Claude Code's agent team system, enabling
 * skills and workflows written for that system to work in PI without modification.
 *
 * Data is stored in ~/.pi/teams/{team-name}/:
 *   team.json      — metadata + config
 *   tasks.json     — task board (id, description, assignee, status, timestamps)
 *   messages.jsonl — append-only message log
 *   outputs/       — named agent outputs (managed by subagent team mode)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const TEAMS_DIR = path.join(os.homedir(), ".pi", "teams");

// ── Helpers ────────────────────────────────────────────────────────────

function teamDir(teamName: string): string {
	return path.join(TEAMS_DIR, teamName);
}

function tasksPath(teamName: string): string {
	return path.join(teamDir(teamName), "tasks.json");
}

function messagesPath(teamName: string): string {
	return path.join(teamDir(teamName), "messages.jsonl");
}

interface Task {
	id: string;
	description: string;
	assignee?: string;
	status: "pending" | "in_progress" | "completed" | "blocked";
	created: string;
	updated: string;
	blockedBy?: string[];
}

function readTasks(teamName: string): Task[] {
	try {
		return JSON.parse(fs.readFileSync(tasksPath(teamName), "utf-8"));
	} catch {
		return [];
	}
}

function writeTasks(teamName: string, tasks: Task[]): void {
	fs.writeFileSync(tasksPath(teamName), JSON.stringify(tasks, null, 2) + "\n");
}

function appendMessage(teamName: string, msg: Record<string, any>): void {
	const line = JSON.stringify({ ...msg, timestamp: new Date().toISOString() }) + "\n";
	fs.appendFileSync(messagesPath(teamName), line);
}

// ── Extension ──────────────────────────────────────────────────────────

export function registerCoordinationTools(pi: ExtensionAPI): void {

	// ── TeamCreate ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TeamCreate",
		label: "Create Team",
		description:
			"Create a team for multi-agent coordination. Sets up the team directory, task board, and message log. " +
			"After creating a team, use the `subagent` tool with `team` param set to this team name to spawn agents.",
		promptGuidelines: [
			"AGENT ROLE MAPPING (use with `subagent` tool):",
			"  Research/recon roles → agent: 'scout' — fast codebase scanning and reconnaissance",
			"  Planning/synthesis/analysis → agent: 'planner' — deep reasoning, architecture, design",
			"  Code implementation → agent: 'executor' — writes and modifies code with precision",
			"  Code review/QA → agent: 'reviewer' — finds bugs, security issues, quality problems",
			"Always set `team` param on subagent calls to share context. Use `saveAs` for named outputs. Reference previous outputs with {output:name} in task text.",
			"For parallel spawns, use subagent `tasks` array. For sequential deps, use `chain` with {previous} or {output:name}.",
		],
		parameters: Type.Object({
			team_name: Type.String({ description: "Team identifier (e.g. my-project)" }),
			agent_type: Type.Optional(Type.String({ description: "Role of the creator (default: orchestrator)" })),
		}),

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const name = params.team_name;
			const dir = teamDir(name);

			fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });

			const metaPath = path.join(dir, "team.json");
			if (!fs.existsSync(metaPath)) {
				fs.writeFileSync(
					metaPath,
					JSON.stringify(
						{
							name,
							created: new Date().toISOString(),
							creator: params.agent_type || "orchestrator",
						},
						null,
						2,
					) + "\n",
				);
			}

			// Initialize tasks.json if missing
			if (!fs.existsSync(tasksPath(name))) {
				writeTasks(name, []);
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Team "${name}" created.\n` +
							`  Dir: ${dir}\n` +
							`  Tasks: ${tasksPath(name)}\n` +
							`  Messages: ${messagesPath(name)}\n\n` +
							`Use subagent(team: "${name}", agent: "scout|planner|executor|reviewer", task: "...", saveAs: "...") to spawn agents.`,
					},
				],
			};
		},
	});

	// ── TeamDelete ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TeamDelete",
		label: "Delete Team",
		description: "Delete a team and all its data (tasks, messages, outputs). Use after project completion.",
		parameters: Type.Object({
			team_name: Type.String({ description: "Team to delete" }),
		}),

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const dir = teamDir(params.team_name);
			try {
				fs.rmSync(dir, { recursive: true, force: true });
				return { content: [{ type: "text", text: `Team "${params.team_name}" deleted.` }] };
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to delete team: ${err.message}` }],
					isError: true,
				};
			}
		},
	});

	// ── TaskCreate ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskCreate",
		label: "Create Task",
		description:
			"Add a task to the team's task board. Tasks track work assigned to agents. " +
			"Use addBlockedBy to set dependencies between tasks.",
		parameters: Type.Object({
			team_name: Type.String({ description: "Team the task belongs to" }),
			taskId: Type.String({ description: "Unique task identifier" }),
			description: Type.String({ description: "What the task involves" }),
			assignee: Type.Optional(Type.String({ description: "Agent role assigned to this task" })),
			addBlockedBy: Type.Optional(
				Type.Array(Type.String(), { description: "Task IDs that must complete before this one" }),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const tasks = readTasks(params.team_name);

			if (tasks.find((t) => t.id === params.taskId)) {
				return {
					content: [{ type: "text", text: `Task "${params.taskId}" already exists.` }],
					isError: true,
				};
			}

			const now = new Date().toISOString();
			const task: Task = {
				id: params.taskId,
				description: params.description,
				assignee: params.assignee,
				status: "pending",
				created: now,
				updated: now,
				blockedBy: params.addBlockedBy,
			};

			tasks.push(task);
			writeTasks(params.team_name, tasks);

			return {
				content: [
					{
						type: "text",
						text: `Task "${params.taskId}" created (${params.assignee || "unassigned"}, pending).`,
					},
				],
			};
		},
	});

	// ── TaskUpdate ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskUpdate",
		label: "Update Task",
		description: "Update a task's status or assignee on the team's task board.",
		parameters: Type.Object({
			team_name: Type.String({ description: "Team the task belongs to" }),
			taskId: Type.String({ description: "Task to update" }),
			status: Type.Optional(
				StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
					description: "New status",
				}),
			),
			assignee: Type.Optional(Type.String({ description: "New assignee" })),
		}),

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const tasks = readTasks(params.team_name);
			const task = tasks.find((t) => t.id === params.taskId);

			if (!task) {
				return {
					content: [{ type: "text", text: `Task "${params.taskId}" not found.` }],
					isError: true,
				};
			}

			if (params.status) task.status = params.status;
			if (params.assignee) task.assignee = params.assignee;
			task.updated = new Date().toISOString();

			writeTasks(params.team_name, tasks);

			return {
				content: [
					{
						type: "text",
						text: `Task "${params.taskId}" updated → ${task.status} (${task.assignee || "unassigned"}).`,
					},
				],
			};
		},
	});

	// ── TaskList ────────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskList",
		label: "List Tasks",
		description: "List all tasks on the team's task board with their current status.",
		parameters: Type.Object({
			team_name: Type.String({ description: "Team to list tasks for" }),
		}),

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const tasks = readTasks(params.team_name);

			if (tasks.length === 0) {
				return { content: [{ type: "text", text: "No tasks." }] };
			}

			const statusIcon: Record<string, string> = {
				pending: "○",
				in_progress: "◑",
				completed: "●",
				blocked: "✗",
			};

			const lines = tasks.map((t) => {
				const icon = statusIcon[t.status] || "?";
				const assignee = t.assignee ? ` [${t.assignee}]` : "";
				const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
				return `${icon} ${t.id}${assignee}: ${t.description}${blocked}`;
			});

			const summary = {
				total: tasks.length,
				pending: tasks.filter((t) => t.status === "pending").length,
				in_progress: tasks.filter((t) => t.status === "in_progress").length,
				completed: tasks.filter((t) => t.status === "completed").length,
				blocked: tasks.filter((t) => t.status === "blocked").length,
			};

			return {
				content: [
					{
						type: "text",
						text:
							`Tasks (${summary.completed}/${summary.total} done, ${summary.in_progress} active, ${summary.blocked} blocked):\n\n` +
							lines.join("\n"),
					},
				],
			};
		},
	});

	// ── SendMessage ────────────────────────────────────────────────

	pi.registerTool({
		name: "SendMessage",
		label: "Send Message",
		description:
			"Send a message to the team message log. In PI, agents are ephemeral (they run and exit), " +
			"so messages are logged for the orchestrator's reference rather than delivered to running agents. " +
			"Use this to record decisions, status updates, and completion notices.",
		parameters: Type.Object({
			team_name: Type.String({ description: "Team to post the message to" }),
			type: Type.Optional(
				StringEnum(["message", "broadcast", "shutdown_request", "shutdown_response"] as const, {
					description: "Message type (default: message)",
				}),
			),
			recipient: Type.Optional(Type.String({ description: "Target agent or 'orchestrator'" })),
			content: Type.String({ description: "Message content" }),
		}),

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const dir = teamDir(params.team_name);
			if (!fs.existsSync(dir)) {
				return {
					content: [{ type: "text", text: `Team "${params.team_name}" not found.` }],
					isError: true,
				};
			}

			const msgType = params.type || "message";

			// For shutdown requests, just acknowledge — PI agents exit on their own
			if (msgType === "shutdown_request" || msgType === "shutdown_response") {
				appendMessage(params.team_name, {
					type: msgType,
					recipient: params.recipient,
					content: params.content,
				});
				return {
					content: [{ type: "text", text: `Shutdown ${msgType === "shutdown_request" ? "requested" : "acknowledged"}.` }],
				};
			}

			appendMessage(params.team_name, {
				type: msgType,
				recipient: params.recipient || "all",
				content: params.content,
			});

			return {
				content: [
					{
						type: "text",
						text: `Message logged → ${params.recipient || "all"}: ${params.content.slice(0, 100)}${params.content.length > 100 ? "..." : ""}`,
					},
				],
			};
		},
	});
}
