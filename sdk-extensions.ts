import { createJiti } from "jiti";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as agentCore from "@earendil-works/pi-agent-core";
import * as ai from "@earendil-works/pi-ai/compat";
import * as tui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { bindCommandValues } from "./sdk-model-runtime.js";

/** Fresh module state per child, but the same host SDK/types as the parent. */
export function createChildModuleLoader() {
	return createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		virtualModules: {
			"@earendil-works/pi-coding-agent": codingAgent,
			"@mariozechner/pi-coding-agent": codingAgent,
			"@earendil-works/pi-agent-core": agentCore,
			"@mariozechner/pi-agent-core": agentCore,
			"@earendil-works/pi-ai": ai,
			"@earendil-works/pi-ai/compat": ai,
			"@mariozechner/pi-ai": ai,
			"@earendil-works/pi-tui": tui,
			"@mariozechner/pi-tui": tui,
			typebox,
			"@sinclair/typebox": typebox,
			"typebox/compile": typeboxCompile,
			"@sinclair/typebox/compile": typeboxCompile,
			"typebox/value": typeboxValue,
			"@sinclair/typebox/value": typeboxValue,
		},
	});
}

export async function loadChildExtensions(paths: readonly string[], cwd: string): Promise<InlineExtension[]> {
	const extensions: InlineExtension[] = [];
	for (const path of [...new Set(paths)]) {
		const loader = createChildModuleLoader();
		const factory = await loader.import<ExtensionFactory>(path, { default: true });
		if (typeof factory !== "function") throw new Error(`Extension has no default factory: ${path}`);
		extensions.push({ name: path, factory: (pi) => factory(new Proxy(pi, {
			get(target, key, receiver) {
				if (key !== "registerProvider") return Reflect.get(target, key, receiver);
				return (provider: unknown, config?: Record<string, unknown>) => {
					if (typeof provider !== "string" || !config) return Reflect.apply(target.registerProvider, target, [provider]);
					const bound = { ...config };
					if (bound.apiKey !== undefined) bound.apiKey = bindCommandValues(bound.apiKey, cwd);
					if (bound.headers !== undefined) bound.headers = bindCommandValues(bound.headers, cwd);
					return Reflect.apply(target.registerProvider, target, [provider, bound]);
				};
			},
		})) });
	}
	return extensions;
}
