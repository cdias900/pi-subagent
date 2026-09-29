import { describe, expect, it } from "vitest";
import { buildModelArgs } from "./test/legacy-cli-options.js";

describe("buildModelArgs", () => {
	it("returns no flags when neither model nor thinking level is resolved", () => {
		expect(buildModelArgs({})).toEqual([]);
	});

	it("emits a resolved model", () => {
		expect(buildModelArgs({ model: "base" })).toEqual(["--model", "base"]);
	});

	it("emits model before thinking level", () => {
		expect(buildModelArgs({ model: "base", thinkingLevel: "high" })).toEqual([
			"--model",
			"base",
			"--thinking",
			"high",
		]);
	});

	it("emits a thinking level without a model", () => {
		expect(buildModelArgs({ thinkingLevel: "medium" })).toEqual([
			"--thinking",
			"medium",
		]);
	});

	it.each(["off", "max"] as const)(
		"passes the %s thinking level through verbatim",
		(thinkingLevel) => {
			expect(buildModelArgs({ thinkingLevel })).toEqual([
				"--thinking",
				thinkingLevel,
			]);
		},
	);

	it("strips a defensive raw-model suffix and uses it as the thinking level", () => {
		expect(buildModelArgs({ model: "provider/base:high" })).toEqual([
			"--model",
			"provider/base",
			"--thinking",
			"high",
		]);
	});

	it("prefers a separately resolved thinking level over a raw-model suffix", () => {
		expect(
			buildModelArgs({
				model: "provider/base:high",
				thinkingLevel: "low",
			}),
		).toEqual(["--model", "provider/base", "--thinking", "low"]);
	});
});
