import { Type, type Static } from "@sinclair/typebox";
import type {
	ExtensionAPI,
	ReadToolDetails,
	ReadToolInput,
	ToolDefinition,
	TruncationResult,
} from "@mariozechner/pi-coding-agent";
import {
	createReadTool,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";

const ReadManySchema = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
		}),
		{
			minItems: 1,
			maxItems: 26,
			description: "Files to read in the exact order listed (max 26)",
		},
	),
	stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (default false)" })),
});

type ReadManyInput = Static<typeof ReadManySchema>;

interface ReadManyFileDetail {
	path: string;
	ok: boolean;
	error?: string;
	imageCount?: number;
	truncation?: ReadToolDetails["truncation"];
}

interface TextMetrics {
	bytes: number;
	lines: number;
}

interface FileCandidate {
	index: number;
	path: string;
	ok: boolean;
	fullText: string;
	fullMetrics: TextMetrics;
	body?: string; // present for successful text/image-summary reads; used for partial rendering
}

interface PackedSection {
	index: number;
	text: string;
	metrics: TextMetrics;
}

type PackingStrategy = "request-order" | "smallest-first";

interface PackingPlan {
	strategy: PackingStrategy;
	fullIncluded: Set<number>;
	partialSection?: PackedSection;
	omittedIndexes: number[];
	usedBytes: number;
	usedLines: number;
	sectionCount: number;
	fullCount: number;
	fullSuccessCount: number;
}

interface ReadManyDetails {
	processedCount: number;
	successCount: number;
	errorCount: number;
	files: ReadManyFileDetail[];
	packing: {
		strategy: PackingStrategy;
		switchedForCoverage: boolean;
		fullIncludedCount: number;
		fullIncludedSuccessCount: number;
		partialIncludedPath?: string;
		omittedPaths: string[];
	};
	combinedTruncation?: TruncationResult;
}

const DELIMITER_WORDS = [
	"PINE",
	"MANGO",
	"ORBIT",
	"RAVEN",
	"CEDAR",
	"LOTUS",
	"EMBER",
	"NOVA",
	"DUNE",
	"KITE",
	"TIDAL",
	"QUARTZ",
	"ACORN",
	"BLAZE",
	"FJORD",
	"GLYPH",
	"HARBOR",
	"IVORY",
	"JUNIPER",
	"SIERRA",
	"UMBRA",
	"VIOLET",
	"WILLOW",
	"XENON",
	"YARROW",
	"ZEPHYR",
] as const;

function measureText(text: string): TextMetrics {
	return {
		bytes: Buffer.byteLength(text, "utf-8"),
		lines: text.split("\n").length,
	};
}

function createPathHash(path: string): string {
	// Deterministic tiny hash (no Node crypto dependency)
	let hash = 5381;
	for (let i = 0; i < path.length; i++) {
		hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0;
	}
	return hash.toString(16).toUpperCase().padStart(6, "0").slice(0, 6);
}

function buildLineSet(content: string): Set<string> {
	const lines = content.split("\n");
	const set = new Set<string>();
	for (const line of lines) {
		set.add(line.replace(/\r$/, ""));
	}
	return set;
}

function pickDelimiter(path: string, index: number, content: string): string {
	const lineSet = buildLineSet(content);
	const word = DELIMITER_WORDS[index - 1] ?? `FILE${index}`;
	const hash = createPathHash(path);
	const base = `${word}_${index}_${hash}`;

	if (!lineSet.has(base)) {
		return base;
	}

	for (let attempt = 1; attempt <= 256; attempt++) {
		const candidate = `${base}_${attempt}`;
		if (!lineSet.has(candidate)) {
			return candidate;
		}
	}

	// Safety fallback: keep deriving deterministic candidates until one is guaranteed free.
	const fallbackBase = `${base}_${content.length.toString(36).toUpperCase()}`;
	if (!lineSet.has(fallbackBase)) {
		return fallbackBase;
	}

	let suffix = 1;
	while (true) {
		const candidate = `${fallbackBase}_${suffix}`;
		if (!lineSet.has(candidate)) {
			return candidate;
		}
		suffix += 1;
	}
}

function formatContentBlock(path: string, body: string, index: number): string {
	const delimiter = pickDelimiter(path, index, body);
	return `@${path}\n<<'${delimiter}'\n${body}\n${delimiter}`;
}

function canFitSection(
	state: { usedBytes: number; usedLines: number; sectionCount: number },
	metrics: TextMetrics,
): boolean {
	const sepBytes = state.sectionCount > 0 ? 2 : 0; // "\n\n"
	const sepLines = state.sectionCount > 0 ? 1 : 0;
	return (
		state.usedBytes + sepBytes + metrics.bytes <= DEFAULT_MAX_BYTES &&
		state.usedLines + sepLines + metrics.lines <= DEFAULT_MAX_LINES
	);
}

function addSection(
	state: { usedBytes: number; usedLines: number; sectionCount: number },
	metrics: TextMetrics,
): void {
	const sepBytes = state.sectionCount > 0 ? 2 : 0;
	const sepLines = state.sectionCount > 0 ? 1 : 0;
	state.usedBytes += sepBytes + metrics.bytes;
	state.usedLines += sepLines + metrics.lines;
	state.sectionCount += 1;
}

function buildPartialSection(candidate: FileCandidate, remainingLines: number, remainingBytes: number): string | undefined {
	if (!candidate.body) {
		return undefined;
	}

	// Wrapper adds 3 structural lines around body in `formatContentBlock`.
	let maxBodyLines = remainingLines - 3;
	if (maxBodyLines < 1 || remainingBytes < 32) {
		return undefined;
	}

	let maxBodyBytes = Math.max(1, remainingBytes - 96); // reserve room for wrapper + delimiter

	for (let attempt = 0; attempt < 16; attempt++) {
		const trunc = truncateHead(candidate.body, {
			maxLines: maxBodyLines,
			maxBytes: maxBodyBytes,
		});

		if (!trunc.content) {
			return undefined;
		}

		const partialText = formatContentBlock(candidate.path, trunc.content, candidate.index + 1);
		const metrics = measureText(partialText);

		if (metrics.lines <= remainingLines && metrics.bytes <= remainingBytes) {
			return partialText;
		}

		if (metrics.lines > remainingLines && maxBodyLines > 1) {
			maxBodyLines = Math.max(1, maxBodyLines - (metrics.lines - remainingLines));
		}
		if (metrics.bytes > remainingBytes && maxBodyBytes > 1) {
			maxBodyBytes = Math.max(1, maxBodyBytes - (metrics.bytes - remainingBytes) - 8);
		}
	}

	return undefined;
}

function buildPlan(strategy: PackingStrategy, order: number[], candidates: FileCandidate[]): PackingPlan {
	const state = { usedBytes: 0, usedLines: 0, sectionCount: 0 };
	const fullIncluded = new Set<number>();
	let fullSuccessCount = 0;

	for (const index of order) {
		const candidate = candidates[index];
		if (canFitSection(state, candidate.fullMetrics)) {
			addSection(state, candidate.fullMetrics);
			fullIncluded.add(index);
			if (candidate.ok) {
				fullSuccessCount += 1;
			}
		} else if (strategy === "request-order") {
			// Strict request-order behavior: once a full block doesn't fit, stop full-block packing.
			break;
		}
	}

	let partialSection: PackedSection | undefined;
	for (let index = 0; index < candidates.length; index++) {
		if (fullIncluded.has(index)) {
			continue;
		}

		const sepBytes = state.sectionCount > 0 ? 2 : 0;
		const sepLines = state.sectionCount > 0 ? 1 : 0;
		const remainingBytes = DEFAULT_MAX_BYTES - state.usedBytes - sepBytes;
		const remainingLines = DEFAULT_MAX_LINES - state.usedLines - sepLines;

		if (remainingBytes <= 0 || remainingLines <= 0) {
			break;
		}

		const partialText = buildPartialSection(candidates[index], remainingLines, remainingBytes);
		if (!partialText) {
			continue;
		}

		const metrics = measureText(partialText);
		partialSection = { index, text: partialText, metrics };
		addSection(state, metrics);
		break;
	}

	const omittedIndexes: number[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (fullIncluded.has(i) || partialSection?.index === i) {
			continue;
		}
		omittedIndexes.push(i);
	}

	return {
		strategy,
		fullIncluded,
		partialSection,
		omittedIndexes,
		usedBytes: state.usedBytes,
		usedLines: state.usedLines,
		sectionCount: state.sectionCount,
		fullCount: fullIncluded.size,
		fullSuccessCount,
	};
}

export function createReadManyTool(readToolFactory: typeof createReadTool = createReadTool): ToolDefinition {
	return {
		name: "read_many",
		label: "read_many",
		description: `Read multiple files in one call with per-file offset/limit. Combined output uses per-file heredoc blocks (DICT_N_HASH); image attachments are summarized in text. Under combined output limits (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}), packing is adaptive: strict request-order by default, switching to smallest-first only when it includes more complete successful files, while rendered section order stays original.`,
		parameters: ReadManySchema,

		async execute(
			toolCallId: string,
			params: ReadManyInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd: string },
		) {
			const readTool = readToolFactory(ctx.cwd);
			const fileDetails: ReadManyFileDetail[] = [];
			const candidates: FileCandidate[] = [];

			for (let i = 0; i < params.files.length; i++) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const request = params.files[i];
				const input: ReadToolInput = {
					path: request.path,
					offset: request.offset,
					limit: request.limit,
				};

				try {
					const result = await readTool.execute(`${toolCallId}:${i}`, input, signal, undefined);
					const details = result.details as ReadToolDetails | undefined;

					const textChunks = result.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text);
					const imageCount = result.content.filter((item) => item.type === "image").length;

					let body = textChunks.join("\n");
					if (!body) {
						body =
							imageCount > 0
								? `[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`
								: "[No text content returned]";
					} else if (imageCount > 0) {
						body += `\n[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`;
					}

					const fullText = formatContentBlock(request.path, body, i + 1);
					candidates.push({
						index: i,
						path: request.path,
						ok: true,
						fullText,
						fullMetrics: measureText(fullText),
						body,
					});

					fileDetails.push({
						path: request.path,
						ok: true,
						imageCount,
						truncation: details?.truncation,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const fullText = formatContentBlock(request.path, `[Error: ${message}]`, i + 1);
					candidates.push({
						index: i,
						path: request.path,
						ok: false,
						fullText,
						fullMetrics: measureText(fullText),
					});

					fileDetails.push({
						path: request.path,
						ok: false,
						error: message,
					});

					if (params.stopOnError) {
						break;
					}
				}
			}

			const requestOrder = candidates.map((_, i) => i);
			const smallestFirstOrder = [...requestOrder].sort((a, b) => {
				const sizeDelta = candidates[a].fullMetrics.bytes - candidates[b].fullMetrics.bytes;
				if (sizeDelta !== 0) {
					return sizeDelta;
				}
				const lineDelta = candidates[a].fullMetrics.lines - candidates[b].fullMetrics.lines;
				if (lineDelta !== 0) {
					return lineDelta;
				}
				return a - b;
			});

			const requestPlan = buildPlan("request-order", requestOrder, candidates);
			const smallestPlan = buildPlan("smallest-first", smallestFirstOrder, candidates);
			const switchedForCoverage = smallestPlan.fullSuccessCount > requestPlan.fullSuccessCount;
			const plan = switchedForCoverage ? smallestPlan : requestPlan;

			const sections: string[] = [];
			for (let i = 0; i < candidates.length; i++) {
				if (plan.fullIncluded.has(i)) {
					sections.push(candidates[i].fullText);
				} else if (plan.partialSection?.index === i) {
					sections.push(plan.partialSection.text);
				}
			}

			const plannedOutputText = sections.join("\n\n");
			const outputTruncation = truncateHead(plannedOutputText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const outputText = outputTruncation.content;

			const details: ReadManyDetails = {
				processedCount: fileDetails.length,
				successCount: fileDetails.filter((f) => f.ok).length,
				errorCount: fileDetails.filter((f) => !f.ok).length,
				files: fileDetails,
				packing: {
					strategy: plan.strategy,
					switchedForCoverage,
					fullIncludedCount: plan.fullCount,
					fullIncludedSuccessCount: plan.fullSuccessCount,
					partialIncludedPath:
						plan.partialSection !== undefined ? candidates[plan.partialSection.index]?.path : undefined,
					omittedPaths: plan.omittedIndexes.map((index) => candidates[index].path),
				},
				combinedTruncation: outputTruncation.truncated ? outputTruncation : undefined,
			};

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	} as unknown as ToolDefinition;
}

export const __test = {
	measureText,
	createPathHash,
	pickDelimiter,
	formatContentBlock,
	buildPartialSection,
	buildPlan,
};

export default function (pi: ExtensionAPI) {
	pi.registerTool(createReadManyTool());
}
