import { describe, it, expect } from "vitest";
import extension from "./index.js";
import { summarizeParameters, buildExampleInput } from "./parameters.js";

describe("extension entrypoint smoke", () => {
	it("loads the extension entrypoint as a function", () => {
		expect(extension).toBeTypeOf("function");
	});
});

describe("parameters smoke", () => {
	const schema = {
		type: "object",
		required: ["name", "count"],
		properties: {
			name: { type: "string" },
			count: { type: "integer" },
			enabled: { type: "boolean" },
			tags: { type: "array" },
		},
	};

	it("summarizes required, optional, and properties", () => {
		const summary = summarizeParameters(schema);
		expect(summary.required).toEqual(["name", "count"]);
		expect(summary.optional).toEqual(["enabled", "tags"]);
		expect(summary.properties).toEqual(["name", "count", "enabled", "tags"]);
	});

	it("builds an example input with defaults per property type", () => {
		const example = buildExampleInput(schema);
		expect(example).toEqual({
			name: "example",
			count: 0,
			enabled: true,
			tags: [],
		});
	});
});
