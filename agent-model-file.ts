import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
	getAgentDir,
	parseFrontmatter,
} from "@mariozechner/pi-coding-agent";
import {
	isAlias,
	isMap,
	isScalar,
	parseDocument,
	type Document,
	type Pair,
	type ParsedNode,
	type Scalar,
	type YAMLMap,
} from "yaml";
import type { AgentConfig } from "./agents.js";
import {
	isThinkingLevel,
	normalizeModelString,
	type SubagentThinkingLevel,
} from "./model-normalize.js";

export type AgentModelFileChange =
	| { model: string; thinkingLevel?: SubagentThinkingLevel }
	| { model: undefined };

export interface AgentModelFileResult {
	config: AgentConfig;
	path: string;
	changed: boolean;
}

interface FrontmatterBounds {
	yamlStart: number;
	yamlEnd: number;
	newline: string;
}

interface ParsedFrontmatter {
	document: Document.Parsed<ParsedNode, true>;
	map: YAMLMap.Parsed;
	modelPair: Pair<ParsedNode, ParsedNode | null> | undefined;
	value: Record<string, unknown>;
}

interface FileSnapshot {
	bytes: Buffer;
	stat: fs.Stats;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(filePath: string, message: string): never {
	throw new Error(`Cannot update agent model in ${filePath}: ${message}`);
}

function findFrontmatterBounds(content: string, filePath: string): FrontmatterBounds {
	const opening = /^---(\r\n|\n|\r)/.exec(content);
	if (opening === null) {
		return fail(filePath, "the file does not start with a valid frontmatter delimiter");
	}

	const newline = opening[1];
	const yamlStart = opening[0].length;
	let lineStart = yamlStart;

	while (lineStart <= content.length) {
		let lineEnd = lineStart;
		while (
			lineEnd < content.length &&
			content[lineEnd] !== "\n" &&
			content[lineEnd] !== "\r"
		) {
			lineEnd += 1;
		}

		const line = content.slice(lineStart, lineEnd);
		if (line.startsWith("---")) {
			if (line === "---") {
				return { yamlStart, yamlEnd: lineStart, newline };
			}
			return fail(
				filePath,
				"an ambiguous frontmatter terminator would be interpreted differently by agent discovery",
			);
		}

		if (lineEnd === content.length) break;
		lineStart =
			content[lineEnd] === "\r" && content[lineEnd + 1] === "\n"
				? lineEnd + 2
				: lineEnd + 1;
	}

	return fail(filePath, "the frontmatter has no closing delimiter line");
}

function parseFrontmatterYaml(
	yaml: string,
	filePath: string,
	newline = "\n",
): ParsedFrontmatter {
	// Pi discovery normalizes bare CR newlines before YAML parsing. Replacing CR
	// with LF preserves string length, so YAML source ranges still map exactly
	// back to the original CR-only frontmatter.
	const yamlForParsing = newline === "\r" ? yaml.replace(/\r/g, "\n") : yaml;
	const document = parseDocument(yamlForParsing, {
		keepSourceTokens: true,
		prettyErrors: false,
		strict: true,
		uniqueKeys: true,
	});

	if (document.errors.length > 0) {
		fail(filePath, `invalid frontmatter YAML: ${document.errors[0].message}`);
	}
	if (document.warnings.length > 0) {
		fail(filePath, `ambiguous frontmatter YAML: ${document.warnings[0].message}`);
	}
	if (!isMap(document.contents)) {
		fail(filePath, "frontmatter must be a top-level YAML mapping");
	}

	const map = document.contents;
	if (map.srcToken?.type === "flow-collection") {
		fail(filePath, "flow-style frontmatter mappings are not supported");
	}

	let modelPair: Pair<ParsedNode, ParsedNode | null> | undefined;
	for (const pair of map.items) {
		if (!isScalar(pair.key) || pair.key.value !== "model") continue;
		if (modelPair !== undefined) {
			fail(filePath, 'frontmatter contains duplicate top-level "model" keys');
		}
		modelPair = pair;
	}

	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 100 });
	} catch (error) {
		fail(filePath, `frontmatter cannot be resolved safely: ${errorMessage(error)}`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(filePath, "frontmatter must resolve to a top-level mapping");
	}
	if (
		modelPair === undefined &&
		Object.prototype.hasOwnProperty.call(value, "model")
	) {
		fail(
			filePath,
			'aliased or otherwise non-scalar top-level "model" keys are not editable',
		);
	}

	return {
		document,
		map,
		modelPair,
		value: value as Record<string, unknown>,
	};
}

function validateSelectedAgent(
	parsed: ParsedFrontmatter,
	agent: AgentConfig,
	filePath: string,
): void {
	if (typeof agent.name !== "string" || agent.name.trim() === "") {
		fail(filePath, "the selected agent has an invalid name");
	}
	if (typeof parsed.value.name !== "string" || parsed.value.name.trim() === "") {
		fail(filePath, 'frontmatter must contain a non-empty string "name"');
	}
	if (parsed.value.name !== agent.name) {
		fail(
			filePath,
			`the file now defines agent "${parsed.value.name}", not the selected agent "${agent.name}"`,
		);
	}
	if (
		parsed.modelPair !== undefined &&
		(typeof parsed.value.model !== "string" || parsed.value.model.trim() === "")
	) {
		fail(filePath, 'the top-level "model" must be a non-empty string');
	}
}

function validateModelPairLayout(
	pair: Pair<ParsedNode, ParsedNode | null>,
	yaml: string,
	filePath: string,
): Pair<Scalar.Parsed, Scalar.Parsed> {
	if (!isScalar(pair.key) || pair.key.anchor || pair.key.tag) {
		fail(filePath, 'anchors and tags on the top-level "model" key are not supported');
	}
	if (pair.value === null || isAlias(pair.value) || !isScalar(pair.value)) {
		fail(filePath, 'the top-level "model" must be a scalar, not an alias or collection');
	}
	if (pair.value.anchor || pair.value.tag) {
		fail(filePath, 'anchors and tags on the top-level "model" value are not supported');
	}
	if (pair.key.range === undefined || pair.value.range === undefined) {
		fail(filePath, 'the top-level "model" has no safe source range');
	}

	const lineStart = Math.max(
		yaml.lastIndexOf("\n", pair.key.range[0] - 1),
		yaml.lastIndexOf("\r", pair.key.range[0] - 1),
	) + 1;
	if (!/^[\t ]*$/.test(yaml.slice(lineStart, pair.key.range[0]))) {
		fail(filePath, 'explicit or otherwise ambiguous top-level "model" keys are not supported');
	}

	const separator = yaml.slice(pair.key.range[2], pair.value.range[0]);
	if (!separator.includes(":") || /[\r\n]/.test(separator)) {
		fail(filePath, 'multiline top-level "model" key syntax is not supported');
	}

	return pair as Pair<Scalar.Parsed, Scalar.Parsed>;
}

function normalizeSelection(
	change: AgentModelFileChange,
	filePath: string,
): string | undefined {
	if (change.model === undefined) return undefined;
	if (typeof change.model !== "string" || change.model.trim() !== change.model || change.model === "") {
		fail(filePath, "model must be a non-empty provider/model string without surrounding whitespace");
	}
	if (/\s/.test(change.model)) {
		fail(filePath, "model must not contain whitespace");
	}
	if (
		change.thinkingLevel !== undefined &&
		!isThinkingLevel(change.thinkingLevel)
	) {
		fail(filePath, `invalid thinking level "${String(change.thinkingLevel)}"`);
	}

	const normalized = normalizeModelString(change.model);
	if (
		normalized.provider === undefined ||
		normalized.provider === "" ||
		normalized.modelId === ""
	) {
		fail(filePath, 'model must include both a provider and model id, as "provider/model"');
	}

	const thinkingLevel = change.thinkingLevel ?? normalized.thinkingLevel;
	return thinkingLevel === undefined
		? normalized.base
		: `${normalized.base}:${thinkingLevel}`;
}

function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

function trailingLineBreaks(value: string): string {
	return /((?:\r\n|\n|\r)(?:[\t ]*(?:\r\n|\n|\r))*)$/.exec(value)?.[1] ?? "";
}

function replacementForBlockScalar(
	pair: Pair<Scalar.Parsed, Scalar.Parsed>,
	yaml: string,
	quotedModel: string,
	filePath: string,
): { start: number; end: number; text: string } {
	const value = pair.value;
	if (value === null) fail(filePath, 'the top-level "model" must have a value');
	const range = value.range;
	if (range === undefined) fail(filePath, 'the top-level "model" has no safe source range');
	const token = value.srcToken;
	if (token?.type !== "block-scalar") {
		return { start: range[0], end: range[1], text: quotedModel };
	}

	const raw = yaml.slice(range[0], range[1]);
	const ending = trailingLineBreaks(raw);
	if (ending === "") {
		fail(filePath, "a multiline model value has no safe terminating newline");
	}

	const headerTail = token.props
		.slice(1)
		.filter((part) => part.type !== "newline")
		.map((part) => {
			if (!("source" in part)) {
				return fail(filePath, "a multiline model header contains unsupported syntax");
			}
			return part.source;
		})
		.join("");
	return {
		start: range[0],
		end: range[1],
		text: `${quotedModel}${headerTail}${ending}`,
	};
}

function rootMappingIndentation(
	parsed: ParsedFrontmatter,
	yaml: string,
	filePath: string,
): string {
	for (const item of parsed.map.items) {
		if (!isScalar(item.key) || item.key.range === undefined) continue;
		const lineStart = Math.max(
			yaml.lastIndexOf("\n", item.key.range[0] - 1),
			yaml.lastIndexOf("\r", item.key.range[0] - 1),
		) + 1;
		const indentation = yaml.slice(lineStart, item.key.range[0]);
		if (!/^[\t ]*$/.test(indentation)) {
			fail(filePath, "the root mapping uses unsupported key indentation");
		}
		return indentation;
	}
	return "";
}

function patchYaml(
	yaml: string,
	parsed: ParsedFrontmatter,
	model: string | undefined,
	newline: string,
	filePath: string,
): string {
	const pair = parsed.modelPair;
	if (pair === undefined) {
		if (model === undefined) return yaml;
		if (yaml !== "" && !/[\r\n]$/.test(yaml)) {
			fail(filePath, "frontmatter does not end at a safe line boundary");
		}
		const indentation = rootMappingIndentation(parsed, yaml, filePath);
		return `${yaml}${indentation}model: ${quoteYamlString(model)}${newline}`;
	}

	const scalarPair = validateModelPairLayout(pair, yaml, filePath);
	const keyRange = scalarPair.key.range;
	const valueRange = scalarPair.value?.range;
	if (keyRange === undefined || valueRange === undefined) {
		return fail(filePath, 'the top-level "model" has no safe source range');
	}

	if (model !== undefined) {
		const replacement = replacementForBlockScalar(
			scalarPair,
			yaml,
			quoteYamlString(model),
			filePath,
		);
		return `${yaml.slice(0, replacement.start)}${replacement.text}${yaml.slice(replacement.end)}`;
	}

	const lineStart = Math.max(
		yaml.lastIndexOf("\n", keyRange[0] - 1),
		yaml.lastIndexOf("\r", keyRange[0] - 1),
	) + 1;
	return `${yaml.slice(0, lineStart)}${yaml.slice(valueRange[2])}`;
}

function withoutModel(value: Record<string, unknown>): Record<string, unknown> {
	const copy = { ...value };
	delete copy.model;
	return copy;
}

function validateCandidate(
	original: ParsedFrontmatter,
	candidateYaml: string,
	agent: AgentConfig,
	model: string | undefined,
	filePath: string,
): void {
	const newline = candidateYaml.includes("\r") && !candidateYaml.includes("\n")
		? "\r"
		: "\n";
	const candidate = parseFrontmatterYaml(candidateYaml, filePath, newline);
	validateSelectedAgent(candidate, agent, filePath);

	if (model === undefined) {
		if (Object.prototype.hasOwnProperty.call(candidate.value, "model")) {
			fail(filePath, 'failed to remove the top-level "model"');
		}
	} else if (candidate.value.model !== model) {
		fail(filePath, 'the saved top-level "model" would not match the requested value');
	}

	if (!isDeepStrictEqual(withoutModel(original.value), withoutModel(candidate.value))) {
		fail(filePath, "the edit would change frontmatter fields other than model");
	}
}

function parseDiscoveryView(
	content: string,
	filePath: string,
): { frontmatter: Record<string, unknown>; body: string } {
	try {
		return parseFrontmatter<Record<string, unknown>>(content);
	} catch (error) {
		return fail(
			filePath,
			`agent discovery cannot parse the frontmatter: ${errorMessage(error)}`,
		);
	}
}

function validateDiscoveryAgreement(
	content: string,
	parsed: ParsedFrontmatter,
	agent: AgentConfig,
	model: string | undefined,
	originalBody: string | undefined,
	filePath: string,
): string {
	const discovery = parseDiscoveryView(content, filePath);
	if (discovery.frontmatter.name !== agent.name) {
		fail(filePath, "the editor and agent discovery disagree about the selected agent name");
	}
	const discoveredModel = discovery.frontmatter.model;
	if (model === undefined) {
		if (Object.prototype.hasOwnProperty.call(discovery.frontmatter, "model")) {
			fail(filePath, "the editor and agent discovery disagree about the absence of model");
		}
	} else if (discoveredModel !== model) {
		fail(filePath, "the editor and agent discovery disagree about the model value");
	}
	if (parsed.value.name !== discovery.frontmatter.name) {
		fail(filePath, "the YAML editor and agent discovery use different frontmatter boundaries");
	}
	if (originalBody !== undefined && discovery.body !== originalBody) {
		fail(filePath, "the edit would change the prompt body seen by agent discovery");
	}
	return discovery.body;
}

function readRegularFile(filePath: string): FileSnapshot {
	let initial: fs.Stats;
	try {
		initial = fs.lstatSync(filePath);
	} catch (error) {
		fail(filePath, `cannot inspect the selected file: ${errorMessage(error)}`);
	}
	if (initial.isSymbolicLink()) {
		fail(filePath, "symbolic-link agent files are not editable; create a regular user-owned copy first");
	}
	if (!initial.isFile()) {
		fail(filePath, "the selected path is not a regular file");
	}

	let fd: number | undefined;
	try {
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino) {
			fail(filePath, "the selected file changed while it was being opened");
		}
		return { bytes: fs.readFileSync(fd), stat };
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Cannot update agent model")) {
			throw error;
		}
		return fail(filePath, `cannot read the selected file safely: ${errorMessage(error)}`);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function validateDestination(agent: AgentConfig): { filePath: string; snapshot: FileSnapshot } {
	if (agent.source !== "user") {
		throw new Error(
			`Cannot update agent "${agent.name}": only user-source agents are editable; create a user-owned copy first`,
		);
	}

	const userAgentsDir = path.resolve(getAgentDir(), "agents");
	const filePath = path.resolve(agent.filePath);
	if (path.dirname(filePath) !== userAgentsDir) {
		fail(filePath, `the selected file is outside the user agents directory ${userAgentsDir}`);
	}

	let realUserAgentsDir: string;
	try {
		realUserAgentsDir = fs.realpathSync(userAgentsDir);
	} catch (error) {
		fail(filePath, `cannot resolve the user agents directory ${userAgentsDir}: ${errorMessage(error)}`);
	}

	const snapshot = readRegularFile(filePath);
	let realFilePath: string;
	try {
		realFilePath = fs.realpathSync(filePath);
	} catch (error) {
		fail(filePath, `cannot resolve the selected file: ${errorMessage(error)}`);
	}
	if (path.dirname(realFilePath) !== realUserAgentsDir) {
		fail(filePath, `the selected file resolves outside the real user agents directory ${realUserAgentsDir}`);
	}
	if ((snapshot.stat.mode & 0o222) === 0) {
		fail(filePath, "the selected file is read-only");
	}

	return { filePath, snapshot };
}

function sameIdentityAndMode(left: fs.Stats, right: fs.Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.gid === right.gid
	);
}

function writeAtomically(
	filePath: string,
	candidate: Buffer,
	original: FileSnapshot,
): void {
	const mode = original.stat.mode & 0o7777;
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
	let tempExists = false;
	let fd: number | undefined;

	try {
		fd = fs.openSync(tempPath, "wx", mode);
		tempExists = true;
		fs.writeFileSync(fd, candidate);
		fs.fchmodSync(fd, mode);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;

		const current = readRegularFile(filePath);
		if (
			!sameIdentityAndMode(original.stat, current.stat) ||
			!current.bytes.equals(original.bytes)
		) {
			fail(filePath, "the file changed concurrently; no update was saved");
		}

		fs.renameSync(tempPath, filePath);
		tempExists = false;
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Preserve the primary failure; cleanup below still removes the path.
			}
		}
		if (tempExists) {
			try {
				fs.unlinkSync(tempPath);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Failed to update ${filePath} and clean up temporary file ${tempPath}`,
				);
			}
		}
		throw error;
	}
}

/**
 * Persist a selected user agent's model in its existing Markdown frontmatter.
 *
 * The original is re-read and validated, only the top-level model entry is
 * patched, and a complete sibling temporary file is atomically renamed into
 * place after an identity/content conflict check. The final check narrows the
 * race window but cannot provide a transaction against arbitrary external
 * editors between that check and rename.
 */
export function persistAgentModelFile(
	agent: AgentConfig,
	change: AgentModelFileChange,
): AgentModelFileResult {
	const { filePath, snapshot } = validateDestination(agent);
	if (!isUtf8(snapshot.bytes)) {
		fail(filePath, "the selected file is not valid UTF-8");
	}

	const content = snapshot.bytes.toString("utf8");
	const bounds = findFrontmatterBounds(content, filePath);
	const yaml = content.slice(bounds.yamlStart, bounds.yamlEnd);
	const parsed = parseFrontmatterYaml(yaml, filePath, bounds.newline);
	validateSelectedAgent(parsed, agent, filePath);
	const originalModel = parsed.modelPair === undefined
		? undefined
		: parsed.value.model as string;
	const originalBody = validateDiscoveryAgreement(
		content,
		parsed,
		agent,
		originalModel,
		undefined,
		filePath,
	);
	if (parsed.modelPair !== undefined) {
		validateModelPairLayout(parsed.modelPair, yaml, filePath);
	}

	const model = normalizeSelection(change, filePath);
	const candidateYaml = patchYaml(yaml, parsed, model, bounds.newline, filePath);
	validateCandidate(parsed, candidateYaml, agent, model, filePath);
	const candidateContent = `${content.slice(0, bounds.yamlStart)}${candidateYaml}${content.slice(bounds.yamlEnd)}`;
	validateDiscoveryAgreement(
		candidateContent,
		parseFrontmatterYaml(candidateYaml, filePath, bounds.newline),
		agent,
		model,
		originalBody,
		filePath,
	);
	const candidate = Buffer.from(candidateContent, "utf8");

	if (!candidate.equals(snapshot.bytes)) {
		writeAtomically(filePath, candidate, snapshot);
	}

	return {
		config: { ...agent, filePath, model },
		path: filePath,
		changed: !candidate.equals(snapshot.bytes),
	};
}
