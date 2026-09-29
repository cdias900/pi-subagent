import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	defineTool,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig } from "./agents.js";
import type { ResolvedModelConfig } from "./model-resolution.js";
import { loadChildExtensions } from "./sdk-extensions.js";
import { createChildModelRuntime } from "./sdk-model-runtime.js";
import { createScopedMcpExtension, type ScopedMcpServer } from "./sdk-mcp.js";

export type SdkSignal =
	| { status: "done"; summary?: string }
	| { status: "question"; question?: string }
	| { status: "error"; error?: string };

export interface SdkChild {
	readonly session: AgentSession;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	takeSignal(): SdkSignal | undefined;
	dispose(): Promise<void>;
}

/** Match the non-interactive CLI child's saved/default project-trust decision. */
export function resolveSdkProjectTrust(cwd: string, agentDir = getAgentDir()): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const saved = new ProjectTrustStore(agentDir).get(cwd);
	if (saved !== null) return saved;
	return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

/** Build a fresh, ephemeral Pi runtime; never discover the parent's extensions in the child. */
export async function createSdkChild(options: {
	signal?: AbortSignal;
	cwd: string;
	agent: AgentConfig;
	resolvedModel: ResolvedModelConfig;
	extensionPaths?: string[];
	mcpServers?: Record<string, ScopedMcpServer>;
	mcpBridgePath?: string;
	backgroundInstruction?: string;
	onEvent: (event: AgentSessionEvent) => void;
}): Promise<SdkChild> {
	const { cwd, agent, resolvedModel, extensionPaths = [], backgroundInstruction, onEvent } = options;
	const checkAbort = () => { if (options.signal?.aborted) throw new Error("Subagent was aborted"); };
	checkAbort();
	const agentDir = getAgentDir();
	const trusted = resolveSdkProjectTrust(cwd, agentDir);
	const isBackground = backgroundInstruction !== undefined;
	const replace = agent.systemPromptMode === "replace";
	const role = isBackground
		? [agent.systemPrompt.trim(), backgroundInstruction].filter(Boolean).join("\n\n")
		: agent.systemPrompt;
	const tools = agent.tools === undefined
		? undefined
		: isBackground
			? [...new Set([...agent.tools, "__bg_signal"])]
			: [...agent.tools];
	let pendingSignal: SdkSignal | undefined;
	let protocolError: string | undefined;
	const signalTool = isBackground
		? defineTool({
				name: "__bg_signal",
				label: "Background Signal",
				description: "Report completion, a question, or an unrecoverable error to the parent orchestrator.",
				parameters: Type.Object({
					status: Type.String({ description: "done, question, or error" }),
					summary: Type.Optional(Type.String()),
					question: Type.Optional(Type.String()),
					error: Type.Optional(Type.String()),
				}),
				async execute(_id, params) {
					if (params.status === "done") pendingSignal = { status: "done", summary: params.summary };
					else if (params.status === "question") pendingSignal = { status: "question", question: params.question };
					else if (params.status === "error") pendingSignal = { status: "error", error: params.error };
					else throw new Error(`Unknown background signal: ${params.status}`);
					return {
						content: [{ type: "text" as const, text: `Signal acknowledged: ${params.status}` }],
						details: {},
						terminate: true,
					};
				},
			})
		: undefined;

	const extensions = await loadChildExtensions(extensionPaths, cwd);
	checkAbort();
	const mcp = options.mcpServers && Object.keys(options.mcpServers).length > 0
		? createScopedMcpExtension({ servers: options.mcpServers, cwd, bridgePath: options.mcpBridgePath, signal: options.signal })
		: undefined;
	const models = await createChildModelRuntime(cwd, agentDir, options.signal);
	let runtime: AgentSessionRuntime;
	try {
		checkAbort();
		runtime = await createAgentSessionRuntime(
			async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
				const settingsManager = SettingsManager.create(runtimeCwd, agentDir, { projectTrusted: trusted });
				const services = await createAgentSessionServices({
					cwd: runtimeCwd,
					agentDir,
					settingsManager,
					modelRuntime: models.modelRuntime,
					resourceLoaderOptions: {
						noExtensions: true,
						extensionFactories: [...extensions, ...(mcp ? [mcp.extension] : [])],
						noSkills: replace || agent.noSkills === true,
						noPromptTemplates: replace || agent.noPromptTemplates === true,
						noContextFiles: replace || agent.noContextFiles === true,
						...(replace
							? { systemPromptOverride: () => role, appendSystemPromptOverride: () => [] }
							: { appendSystemPromptOverride: (base: string[]) => role.trim() ? [...base, role] : base }),
					},
				});
				const errors = [
					...services.diagnostics.filter((d) => d.type === "error").map((d) => d.message),
					...services.resourceLoader.getExtensions().errors.map((e) => `${e.path}: ${e.error}`),
				];
				if (errors.length > 0) throw new Error(`Child Pi setup failed: ${errors.join("; ")}`);
				const selection = resolvedModel.model === undefined ? undefined : resolveCliModel({
					cliModel: resolvedModel.model,
					cliThinking: resolvedModel.thinkingLevel,
					modelRuntime: services.modelRuntime,
				});
				if (selection?.error) throw new Error(selection.error);
				const result = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: selection?.model,
					thinkingLevel: resolvedModel.thinkingLevel ?? selection?.thinkingLevel,
					tools,
					customTools: signalTool ? [signalTool] : [],
				});
				return { ...result, services, diagnostics: services.diagnostics };
			},
			{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		);
	} catch (error) {
		models.cleanup();
		await mcp?.dispose();
		throw error;
	}
	const session = runtime.session;
	try {
		checkAbort();
		await session.bindExtensions({ mode: isBackground ? "rpc" : "json" });
		await mcp?.ready();
		checkAbort();
	} catch (error) {
		try { await runtime.dispose(); }
		finally { models.cleanup(); }
		throw error;
	}
	const unsubscribe = session.subscribe((event) => {
		if (isBackground && event.type === "message_end" && event.message.role === "assistant") {
			const calls = event.message.content.filter((part) => part.type === "toolCall");
			if (calls.length > 1 && calls.some((call) => call.name === "__bg_signal")) {
				// terminate:true only stops Pi when EVERY result in the batch terminates.
				// Abort before sibling tools execute rather than continuing after a
				// completion signal and potentially making further changes.
				protocolError = "__bg_signal must be the only tool call in its turn";
				session.agent.abort();
			}
		}
		onEvent(event);
	});
	let disposed = false;
	let stopping = false;
	let activePrompt: Promise<void> | undefined;

	const prompt = async (message: string): Promise<void> => {
		if (disposed || stopping) throw new Error("Subagent was aborted");
		const pending = session.prompt(message, {
			source: isBackground ? "rpc" : "interactive",
			// Pi's abort() sees an idle session during async prompt preflight. Reject
			// at the last preflight boundary so a stopped child cannot start a run.
			preflightResult(accepted) {
				if (accepted && (disposed || stopping)) throw new Error("Subagent was aborted");
			},
		});
		activePrompt = pending;
		try { await pending; }
		finally { if (activePrompt === pending) activePrompt = undefined; }
	};
	const abort = async (): Promise<void> => {
		stopping = true;
		try { await session.abort(); }
		finally {
			await activePrompt?.catch(() => {});
			if (!disposed) stopping = false;
		}
	};

	return {
		session,
		prompt,
		steer: (message) => session.steer(message),
		abort,
		takeSignal() {
			if (protocolError) {
				const error = protocolError;
				protocolError = undefined;
				pendingSignal = undefined;
				return { status: "error", error };
			}
			const signal = pendingSignal;
			pendingSignal = undefined;
			return signal;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			try { await abort(); }
			finally {
				unsubscribe();
				try { await runtime.dispose(); }
				finally { models.cleanup(); }
			}
		},
	};
}
