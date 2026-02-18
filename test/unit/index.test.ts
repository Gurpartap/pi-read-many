import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerExtension from "../../index.js";

describe("index extension wiring", () => {
	it("registers read_many tool", () => {
		let registered: { name?: string; execute?: unknown } | undefined;

		const api = {
			registerTool: (definition: { name: string; execute: unknown }) => {
				registered = definition;
			},
		} as unknown as ExtensionAPI;

		registerExtension(api);

		expect(registered?.name).toBe("read_many");
		expect(typeof registered?.execute).toBe("function");
	});
});
