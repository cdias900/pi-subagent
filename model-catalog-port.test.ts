import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { makeModelCatalogPort } from "./index.js";

function fakeModel(
	id: string,
	provider: string,
	name = id,
	overrides: Partial<Model<Api>> = {},
): Model<Api> {
	return {
		id,
		provider,
		name,
		api: "openai-responses",
		reasoning: true,
		...overrides,
	} as Model<Api>;
}

describe("makeModelCatalogPort", () => {
	it("requires a provider for exact lookup and delegates to registry.find", () => {
		const selected = fakeModel("selected", "provider");
		const registry = {
			find: vi.fn((_provider: string, _id: string) => selected),
			getAll: vi.fn(() => [selected]),
			getAvailable: vi.fn(() => [selected]),
		};
		const port = makeModelCatalogPort(registry);

		expect(port.findExact(undefined, "selected")).toBeUndefined();
		expect(registry.find).not.toHaveBeenCalled();
		expect(port.findExact("provider", "selected")).toBe(selected);
		expect(registry.find).toHaveBeenCalledWith("provider", "selected");
	});

	it("resolves patterns in public-registry priority order", () => {
		const providerExact = fakeModel("exact", "provider");
		const fullIdExact = fakeModel("Model-X", "Provider-X");
		const bareIdExact = fakeModel("BARE-ID", "provider-y");
		const firstSubstring = fakeModel("first", "provider-z", "First Sonnet");
		const laterSubstring = fakeModel("sonnet-later", "provider-a");
		const all = [
			fullIdExact,
			bareIdExact,
			firstSubstring,
			laterSubstring,
		];
		const registry = {
			find: vi.fn((provider: string, id: string) =>
				provider === "provider" && id === "exact" ? providerExact : undefined,
			),
			getAll: vi.fn(() => all),
			getAvailable: vi.fn(() => all),
		};
		const port = makeModelCatalogPort(registry);

		expect(port.resolvePattern("provider/exact")).toBe(providerExact);
		expect(registry.getAll).not.toHaveBeenCalled();
		expect(port.resolvePattern("provider-x/model-x")).toBe(fullIdExact);
		expect(port.resolvePattern("bare-id")).toBe(bareIdExact);
		expect(port.resolvePattern("sonnet")).toBe(firstSubstring);
	});

	it("resolves provider-qualified fuzzy aliases after exact misses", () => {
		const unrelated = fakeModel("unrelated", "provider-b", "Different Model");
		const selected = fakeModel(
			"claude-sonnet-4-5",
			"provider-a",
			"Preferred Sonnet",
		);
		const all = [unrelated, selected];
		const registry = {
			find: vi.fn((_provider: string, _id: string) => undefined),
			getAll: vi.fn(() => all),
			getAvailable: vi.fn(() => all),
		};
		const port = makeModelCatalogPort(registry);

		expect(port.resolvePattern("provider-a/sonnet")).toBe(selected);
		expect(registry.find).toHaveBeenCalledWith("provider-a", "sonnet");
	});

	it("does not cross providers for provider-qualified aliases", () => {
		const crossProvider = fakeModel(
			"provider-b-choice",
			"provider-b",
			"Shared Alias",
		);
		const selected = fakeModel(
			"provider-a-choice",
			"PROVIDER-A",
			"Shared Alias",
		);
		const all = [crossProvider, selected];
		const registry = {
			find: vi.fn((_provider: string, _id: string) => undefined),
			getAll: vi.fn(() => all),
			getAvailable: vi.fn(() => all),
		};
		const port = makeModelCatalogPort(registry);

		const resolved = port.resolvePattern("provider-a/shared");

		expect(resolved).toBe(selected);
		expect(resolved).not.toBe(crossProvider);
	});

	it("preserves bare-pattern first-match behavior", () => {
		const first = fakeModel("first-choice", "provider-b", "Shared Alias");
		const second = fakeModel("second-choice", "provider-a", "Shared Alias");
		const all = [first, second];
		const registry = {
			find: vi.fn((_provider: string, _id: string) => undefined),
			getAll: vi.fn(() => all),
			getAvailable: vi.fn(() => all),
		};
		const port = makeModelCatalogPort(registry);

		expect(port.resolvePattern("shared")).toBe(first);
	});

	it("checks availability by provider and id rather than object identity", () => {
		const available = fakeModel("same-id", "same-provider");
		const registry = {
			find: vi.fn((_provider: string, _id: string) => undefined),
			getAll: vi.fn(() => []),
			getAvailable: vi.fn(() => [available]),
		};
		const port = makeModelCatalogPort(registry);

		expect(port.isAvailable(fakeModel("same-id", "same-provider"))).toBe(true);
		expect(port.isAvailable(fakeModel("same-id", "other-provider"))).toBe(false);
	});

	it("uses compatibility thinking-level discovery", () => {
		const nonReasoning = fakeModel("plain", "provider", "Plain", {
			reasoning: false,
		});
		const registry = {
			find: vi.fn((_provider: string, _id: string) => undefined),
			getAll: vi.fn(() => [nonReasoning]),
			getAvailable: vi.fn(() => [nonReasoning]),
		};
		const port = makeModelCatalogPort(registry);

		expect(port.supportedThinkingLevels(nonReasoning)).toEqual(["off"]);
	});
});
