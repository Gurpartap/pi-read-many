import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { __test, createReadManyTool } from "../../read-many.js";

const {
	measureText,
	createPathHash,
	pickDelimiter,
	formatContentBlock,
	buildPartialSection,
	buildPlan,
} = __test as {
	measureText: (text: string) => { bytes: number; lines: number };
	createPathHash: (path: string) => string;
	pickDelimiter: (path: string, index: number, content: string) => string;
	formatContentBlock: (path: string, body: string, index: number) => string;
	buildPartialSection: (candidate: any, remainingLines: number, remainingBytes: number) => string | undefined;
	buildPlan: (strategy: "request-order" | "smallest-first", order: number[], candidates: any[]) => any;
};

type StubReadResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details?: any;
};

function createToolWithMap(map: Record<string, StubReadResult | Error>) {
	const readTool = {
		execute: async (_toolCallId: string, input: { path: string }) => {
			const value = map[input.path];
			if (!value) {
				throw new Error(`No stub for path: ${input.path}`);
			}
			if (value instanceof Error) {
				throw value;
			}
			return value;
		},
	};

	return createReadManyTool(() => readTool as any);
}

function makeCandidate(path: string, text: string, ok: boolean, index: number, body?: string) {
	return {
		index,
		path,
		ok,
		fullText: text,
		fullMetrics: measureText(text),
		body,
	};
}

describe("read_many: helper logic", () => {
	it("creates deterministic delimiter hashes", () => {
		expect(createPathHash("/tmp/a.txt")).toBe(createPathHash("/tmp/a.txt"));
		expect(createPathHash("/tmp/a.txt")).not.toBe(createPathHash("/tmp/b.txt"));
		expect(createPathHash("/tmp/a.txt")).toMatch(/^[0-9A-F]{6}$/);
	});

	it("adds suffix when delimiter collides with content", () => {
		const path = "/tmp/collide.txt";
		const base = `PINE_1_${createPathHash(path)}`;
		const content = `hello\n${base}\nworld`;
		const picked = pickDelimiter(path, 1, content);
		expect(picked).toBe(`${base}_1`);
	});

	it("falls back after 256 suffix collisions", () => {
		const path = "/tmp/deep-collide.txt";
		const base = `PINE_1_${createPathHash(path)}`;
		const collisions = [base, ...Array.from({ length: 256 }, (_, i) => `${base}_${i + 1}`)];
		const content = collisions.join("\n");

		const picked = pickDelimiter(path, 1, content);
		expect(new Set(collisions).has(picked)).toBe(false);
		expect(picked.startsWith(`${base}_`)).toBe(true);
	});

	it("formats heredoc blocks with matching closing delimiter", () => {
		const block = formatContentBlock("/tmp/file.txt", "line 1\nline 2", 3);
		const lines = block.split("\n");
		expect(lines[0]).toBe("@/tmp/file.txt");
		expect(lines[1]).toMatch(/^<<'ORBIT_3_[0-9A-F]{6}(?:_.*)?'$/);
		const delimiter = lines[1].slice(3, -1);
		expect(lines.slice(2, -1).join("\n")).toBe("line 1\nline 2");
		expect(lines.at(-1)).toBe(delimiter);
	});

	it("builds a partial section that stays within remaining budgets", () => {
		const body = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
		const candidate = makeCandidate("/tmp/large.txt", "ignored", true, 0, body);
		const partial = buildPartialSection(candidate, 40, 1500);
		expect(partial).toBeDefined();

		const metrics = measureText(partial ?? "");
		expect(metrics.lines).toBeLessThanOrEqual(40);
		expect(metrics.bytes).toBeLessThanOrEqual(1500);
		expect(partial).toContain("@/tmp/large.txt");
	});

	it("uses strict request-order full packing (stops on first non-fitting full block)", () => {
		const huge = "H".repeat(DEFAULT_MAX_BYTES + 128);
		const candidates = [
			makeCandidate("/a", "small-a", true, 0),
			makeCandidate("/b", huge, true, 1),
			makeCandidate("/c", "small-c", true, 2),
		];

		const requestPlan = buildPlan("request-order", [0, 1, 2], candidates);
		expect(requestPlan.fullIncluded.has(0)).toBe(true);
		expect(requestPlan.fullIncluded.has(2)).toBe(false);

		const smallestPlan = buildPlan("smallest-first", [0, 2, 1], candidates);
		expect(smallestPlan.fullIncluded.has(2)).toBe(true);
	});

	it("counts successful full blocks separately from total full blocks", () => {
		const candidates = [
			makeCandidate("/ok-1", "x", true, 0),
			makeCandidate("/err", "y", false, 1),
			makeCandidate("/ok-2", "z", true, 2),
		];
		const plan = buildPlan("request-order", [0, 1, 2], candidates);
		expect(plan.fullCount).toBe(3);
		expect(plan.fullSuccessCount).toBe(2);
	});
});

describe("read_many: execute behavior", () => {
	it("switches to smallest-first only when successful full coverage improves, while rendering in original order", async () => {
		const big = Array.from({ length: 3200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
		const tool = createToolWithMap({
			"/a": { content: [{ type: "text", text: big }] },
			"/b": { content: [{ type: "text", text: "small-b" }] },
			"/c": { content: [{ type: "text", text: "small-c" }] },
		});

		const result = await tool.execute(
			"call-1",
			{
				files: [{ path: "/a" }, { path: "/b" }, { path: "/c" }],
			},
			undefined,
			undefined,
			{ cwd: "/" } as any,
		);

		const text = (result.content[0] as any).text as string;
		const details = result.details as any;
		expect(details.packing.strategy).toBe("smallest-first");
		expect(details.packing.switchedForCoverage).toBe(true);
		expect(details.packing.fullIncludedSuccessCount).toBe(2);
		expect(details.packing.partialIncludedPath).toBe("/a");

		const posA = text.indexOf("@/a");
		const posB = text.indexOf("@/b");
		const posC = text.indexOf("@/c");
		expect(posA).toBeGreaterThanOrEqual(0);
		expect(posB).toBeGreaterThan(posA);
		expect(posC).toBeGreaterThan(posB);
	});

	it("does not switch strategy when only error-block coverage improves", async () => {
		const big = Array.from({ length: 3200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
		const tool = createToolWithMap({
			"/a": { content: [{ type: "text", text: big }] },
			"/e1": new Error("missing e1"),
			"/e2": new Error("missing e2"),
		});

		const result = await tool.execute(
			"call-2",
			{
				files: [{ path: "/a" }, { path: "/e1" }, { path: "/e2" }],
			},
			undefined,
			undefined,
			{ cwd: "/" } as any,
		);

		const details = result.details as any;
		expect(details.packing.strategy).toBe("request-order");
		expect(details.packing.switchedForCoverage).toBe(false);
		expect(details.packing.fullIncludedSuccessCount).toBe(0);
		expect(details.packing.partialIncludedPath).toBe("/a");
	});

	it("uses heredoc error framing and honors stopOnError", async () => {
		const tool = createToolWithMap({
			"/bad": new Error("boom"),
			"/good": { content: [{ type: "text", text: "ok" }] },
		});

		const result = await tool.execute(
			"call-3",
			{
				files: [{ path: "/bad" }, { path: "/good" }],
				stopOnError: true,
			},
			undefined,
			undefined,
			{ cwd: "/" } as any,
		);

		const text = (result.content[0] as any).text as string;
		const details = result.details as any;
		expect(details.processedCount).toBe(1);
		expect(details.errorCount).toBe(1);
		expect(details.successCount).toBe(0);
		expect(details.files).toHaveLength(1);
		expect(text).toContain("@/bad");
		expect(text).toContain("[Error: boom]");
		expect(text).not.toContain("@/good");
	});

	it("summarizes image attachments in combined text output", async () => {
		const tool = createToolWithMap({
			"/img": {
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
			},
		});

		const result = await tool.execute(
			"call-4",
			{
				files: [{ path: "/img" }],
			},
			undefined,
			undefined,
			{ cwd: "/" } as any,
		);

		const text = (result.content[0] as any).text as string;
		const details = result.details as any;
		expect(text).toContain("Read image file [image/png]");
		expect(text).toContain("[1 image attachment(s) omitted; use read on this file for image payload.]");
		expect(details.files[0].imageCount).toBe(1);
	});

	it("keeps combinedTruncation undefined when packed output already fits", async () => {
		const tool = createToolWithMap({
			"/a": { content: [{ type: "text", text: "a" }] },
			"/b": { content: [{ type: "text", text: "b" }] },
		});

		const result = await tool.execute(
			"call-5",
			{
				files: [{ path: "/a" }, { path: "/b" }],
			},
			undefined,
			undefined,
			{ cwd: "/" } as any,
		);

		const details = result.details as any;
		expect(details.combinedTruncation).toBeUndefined();
	});
});
