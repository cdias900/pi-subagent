/**
 * Interactive live agents panel — overlay Component for the `/agents` command.
 *
 * Shows live-updating rows for every running foreground/background agent with
 * arrow-key selection, Enter to expand an agent's streaming output, `k` to kill
 * the selected agent, and `q`/Escape to close.
 *
 * Two modes:
 *   - "list":     narrow single-column sidebar listing agents.
 *   - "expanded": two-pane layout — agent list on the left, the selected
 *                 agent's streaming output on the right (like pier entering a
 *                 Slack conversation). The caller reopens the overlay wider for
 *                 this mode and narrower again to return to the list.
 */

import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

export interface TranscriptEntry {
	kind: "prompt" | "assistant" | "tool" | "result";
	text: string;
}

export interface PanelAgent {
	id: string;
	origin: "foreground" | "background";
	agentName: string;
	task: string;
	startTime: number;
	lastEventAt?: number;
	currentTool?: string;
	status: string; // "running" | "done" | "error" | "aborted" | "queued" | "waiting"
	output: string; // latest text output, may be empty
	transcript: TranscriptEntry[]; // full conversation history for the expanded pane
}

export type AgentsPanelMode = "list" | "expanded";

export interface AgentsPanelOptions {
	theme: Theme;
	mode: AgentsPanelMode;
	initialSelectedIndex?: number;
	getAgents: () => PanelAgent[];
	onKill: (id: string) => boolean;
	onExpand: () => void;
	onCollapse: () => void;
	onClose: () => void;
	requestRender: () => void;
	getHeight: () => number;
}

const MAX_OUTPUT_LINES = 15;
const COMPACT_WIDTH_THRESHOLD = 64;

/** Status icon for a given agent status. */
function statusIcon(status: string): string {
	switch (status) {
		case "running":
			return "⏳";
		case "done":
			return "✓";
		case "error":
		case "aborted":
			return "✗";
		case "queued":
		case "waiting":
			return "⏸";
		default:
			return "•";
	}
}

/** Status theme color for a given agent status. */
function statusColor(status: string): ThemeColor {
	switch (status) {
		case "running":
			return "warning";
		case "done":
			return "success";
		case "error":
		case "aborted":
			return "error";
		case "queued":
		case "waiting":
			return "muted";
		default:
			return "muted";
	}
}

function formatElapsed(start: number): string {
	const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return m > 0 ? `${m}m${s.toString().padStart(2, "0")}s` : `${s}s`;
}

/**
 * Truncate a (possibly ANSI-styled) string so its visible width is <= maxWidth,
 * appending an ellipsis when it overflows. Returns the string unchanged when it
 * already fits.
 */
function truncateLine(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	return truncateToWidth(text, maxWidth, "…", false);
}

export class AgentsPanel implements Component {
	private readonly theme: Theme;
	private readonly mode: AgentsPanelMode;
	private readonly getAgents: () => PanelAgent[];
	private readonly onKill: (id: string) => boolean;
	private readonly onExpand: () => void;
	private readonly onCollapse: () => void;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly getHeight: () => number;
	private readonly interval: ReturnType<typeof setInterval>;
	private selectedIndex = 0;
	private scrollOffset = 0; // lines scrolled UP from the bottom (expanded mode only)
	private followBottom = true; // when true, pin to newest content regardless of scrollOffset
	private listScrollOffset = 0; // index of the FIRST VISIBLE AGENT in list mode (an agent index, not a line index)

	constructor(opts: AgentsPanelOptions) {
		this.theme = opts.theme;
		this.mode = opts.mode;
		this.getAgents = opts.getAgents;
		this.onKill = opts.onKill;
		this.onExpand = opts.onExpand;
		this.onCollapse = opts.onCollapse;
		this.onClose = opts.onClose;
		this.requestRender = opts.requestRender;
		this.getHeight = opts.getHeight;
		this.selectedIndex = opts.initialSelectedIndex ?? 0;
		this.interval = setInterval(() => this.requestRender(), 500);
	}

	/** Current selection index, so the caller can preserve it across reopens. */
	get selected(): number {
		return this.selectedIndex;
	}

	dispose(): void {
		clearInterval(this.interval);
	}

	/** Theme-aware foreground colour; falls back to the raw string when unavailable. */
	private fg(color: ThemeColor, text: string): string {
		const fn = (this.theme as unknown as { fg?: (c: ThemeColor, t: string) => string }).fg;
		return typeof fn === "function" ? fn.call(this.theme, color, text) : text;
	}

	/** Pad/truncate a (possibly ANSI-styled) line to exactly `w` visible columns. */
	private padTo(text: string, w: number): string {
		const truncated = truncateLine(text, w);
		const pad = Math.max(0, w - visibleWidth(truncated));
		return `${truncated}${" ".repeat(pad)}`;
	}

	render(width: number): string[] {
		const agents = this.getAgents();
		const height = Math.max(6, this.getHeight());

		// innerWidth is the content area between the side borders, minus the single
		// leading/trailing space padding each content line gets ("│ " + text + " │").
		const innerWidth = width - 4; // "│ " + content + " │" => 4 border/padding chars
		// Fall back to the unbordered layout when the terminal is too narrow to hold
		// a bordered box with any usable content area.
		if (innerWidth <= 0) {
			return this.renderUnbordered(width, agents);
		}

		if (this.mode === "expanded") {
			return this.renderExpanded(width, innerWidth, height, agents);
		}
		return this.renderList(width, innerWidth, height, agents);
	}

	/** "list" mode: the narrow single-column sidebar. */
	private renderList(width: number, innerWidth: number, height: number, agents: PanelAgent[]): string[] {
		const compact = innerWidth < COMPACT_WIDTH_THRESHOLD;
		const footerHint = "↑↓/PgUp/PgDn   ⏎ output   k kill   q close";
		const runningCount = agents.filter((a) => a.status === "running").length;

		// Build the content lines (everything between the top and bottom borders).
		// These are raw inner-width strings; padRow wraps them with borders later.
		const content: string[] = [];

		if (agents.length === 0) {
			this.listScrollOffset = 0;
			content.push(this.fg("muted", "No agents running."));
		} else {
			// Clamp selection into bounds each render so a shrunk list can't point past the end.
			if (this.selectedIndex >= agents.length) this.selectedIndex = agents.length - 1;
			if (this.selectedIndex < 0) this.selectedIndex = 0;

			// ── Scrolling viewport ──────────────────────────────────────────────
			// linesPerAgent mirrors the row layout chosen below (2 lines when
			// compact, 1 otherwise). bodySlots matches what composeBordered
			// reserves for content once the footer line is pinned.
			const linesPerAgent = compact ? 2 : 1;
			const available = height - 2;
			const bodySlots = Math.max(1, available - 1);

			// Given a number of reserved indicator lines (0, 1, or 2 — the "↑ N
			// more" / "↓ N more" rows), compute how many agent rows fit, clamp
			// the viewport (this.listScrollOffset) so the current selection stays
			// visible, and report which indicators are actually needed for that
			// viewport. Shrinking the viewport can only ever make more indicators
			// necessary (never fewer), so re-evaluating at most twice always
			// reaches a fixed point — no unbounded loop.
			const settle = (indicatorLines: number) => {
				const visibleCount = Math.max(1, Math.floor((bodySlots - indicatorLines) / linesPerAgent));
				if (this.selectedIndex < this.listScrollOffset) this.listScrollOffset = this.selectedIndex;
				if (this.selectedIndex >= this.listScrollOffset + visibleCount) {
					this.listScrollOffset = this.selectedIndex - visibleCount + 1;
				}
				this.listScrollOffset = Math.max(
					0,
					Math.min(this.listScrollOffset, Math.max(0, agents.length - visibleCount)),
				);
				const hasMoreAbove = this.listScrollOffset > 0;
				const hasMoreBelow = this.listScrollOffset + visibleCount < agents.length;
				return { visibleCount, hasMoreAbove, hasMoreBelow };
			};

			let viewport = settle(0);
			let indicatorLines = (viewport.hasMoreAbove ? 1 : 0) + (viewport.hasMoreBelow ? 1 : 0);
			if (indicatorLines > 0) {
				viewport = settle(indicatorLines);
				const nextIndicatorLines = (viewport.hasMoreAbove ? 1 : 0) + (viewport.hasMoreBelow ? 1 : 0);
				if (nextIndicatorLines !== indicatorLines) {
					viewport = settle(nextIndicatorLines);
				}
			}
			const { visibleCount, hasMoreAbove, hasMoreBelow } = viewport;

			if (hasMoreAbove) {
				content.push(this.fg("muted", `↑ ${this.listScrollOffset} more`));
			}

			const visibleAgents = agents.slice(this.listScrollOffset, this.listScrollOffset + visibleCount);
			for (let i = 0; i < visibleAgents.length; i++) {
				const a = visibleAgents[i];
				const selected = this.listScrollOffset + i === this.selectedIndex;
				const marker = selected ? "▸ " : "  ";
				const icon = this.fg(statusColor(a.status), statusIcon(a.status));
				const id = this.fg("accent", a.id);
				const name = this.fg("text", a.agentName);
				const elapsed = this.fg("dim", formatElapsed(a.startTime));
				const tool = a.currentTool
					? this.fg("toolOutput", `tool:${a.currentTool}`)
					: this.fg("muted", "(awaiting model)");
				const idle = a.lastEventAt !== undefined ? this.fg("dim", `idle:${formatElapsed(a.lastEventAt)}`) : "";

				if (compact) {
					// Two-line compact layout for narrow panels. The elapsed time is
					// right-aligned on line 1; tool/idle go on line 2. Task preview is
					// omitted — there is no room.
					const left = `${marker}${icon} ${id} ${name}`;
					const elapsedStr = formatElapsed(a.startTime);
					const elapsedWidth = visibleWidth(elapsedStr);
					const leftWidth = visibleWidth(left);
					const gap = Math.max(1, innerWidth - leftWidth - elapsedWidth);
					const line1 = `${left}${" ".repeat(gap)}${elapsedStr}`;
					content.push(selected ? this.fg("text", line1) : line1);

					const toolPart = a.currentTool
						? `tool:${a.currentTool}`
						: "(awaiting model)";
					const line2 = `    ${toolPart}${idle ? "  " + `idle:${formatElapsed(a.lastEventAt!)}` : ""}`;
					content.push(selected ? this.fg("text", line2) : line2);
				} else {
					// WIDE layout: single-line row with marker, icon, id, agentName,
					// elapsed, tool, idle, then the task preview filling remaining cols.
					const prefix = `${marker}${icon} ${id} ${name} ${elapsed} ${tool}${idle ? " " + idle : ""}`;
					const prefixWidth = visibleWidth(prefix);
					const remaining = innerWidth - prefixWidth - 1;
					const taskPreview = remaining > 0
						? this.fg("dim", truncateLine(a.task.replace(/\s+/g, " ").trim(), remaining))
						: "";
					const row = taskPreview ? `${prefix} ${taskPreview}` : prefix;
					content.push(selected ? this.fg("text", row) : row);
				}
			}

			if (hasMoreBelow) {
				content.push(this.fg("muted", `↓ ${agents.length - (this.listScrollOffset + visibleCount)} more`));
			}
		}

		const title = agents.length > 0
			? `agents — ${runningCount} running · ${this.selectedIndex + 1}/${agents.length}`
			: `agents — ${runningCount} running`;

		return this.composeBordered(title, footerHint, content, width, innerWidth, height);
	}

	/** "expanded" mode: two-pane layout with the agent list and the selected agent's output. */
	private renderExpanded(width: number, innerWidth: number, height: number, agents: PanelAgent[]): string[] {
		const runningCount = agents.filter((a) => a.status === "running").length;
		const title = `agents — ${runningCount} running`;
		const footerHint = "↑↓/PgUp/PgDn scroll   ⇥ next   ⏎/esc back   k kill   q close";

		// List width: ~36% of the content area, clamped to [22, innerWidth-12],
		// and never wider than innerWidth-2 (leave room for the separator + right pane).
		const listWidth = Math.max(
			1,
			Math.min(
				innerWidth - 2,
				Math.max(22, Math.min(innerWidth - 12, Math.floor(innerWidth * 0.36))),
			),
		);
		const rightWidth = Math.max(1, innerWidth - listWidth - 1); // 1 col for the separator
		const separator = this.fg("border", "│");

		// Available content slots = total height minus top & bottom borders (2 lines).
		const available = height - 2;

		// ── Left pane: the agent rows, forced into the COMPACT layout since the
		//    column is always narrow here. ──
		const leftLines: string[] = [];
		if (agents.length === 0) {
			leftLines.push(this.fg("muted", "No agents running."));
		} else {
			if (this.selectedIndex >= agents.length) this.selectedIndex = agents.length - 1;
			if (this.selectedIndex < 0) this.selectedIndex = 0;

			for (let i = 0; i < agents.length; i++) {
				const a = agents[i];
				const selected = i === this.selectedIndex;
				const marker = selected ? "▸ " : "  ";
				const icon = this.fg(statusColor(a.status), statusIcon(a.status));
				const id = this.fg("accent", a.id);
				const name = this.fg("text", a.agentName);

				const left = `${marker}${icon} ${id} ${name}`;
				const elapsedStr = formatElapsed(a.startTime);
				const elapsedWidth = visibleWidth(elapsedStr);
				const leftWidth = visibleWidth(left);
				const gap = Math.max(1, listWidth - leftWidth - elapsedWidth);
				const line1 = `${left}${" ".repeat(gap)}${elapsedStr}`;
				leftLines.push(selected ? this.fg("text", line1) : line1);

				const toolPart = a.currentTool ? `tool:${a.currentTool}` : "(awaiting model)";
				const idlePart = a.lastEventAt !== undefined ? `  idle:${formatElapsed(a.lastEventAt)}` : "";
				const line2 = `    ${toolPart}${idlePart}`;
				leftLines.push(selected ? this.fg("text", line2) : line2);
			}
		}

		// ── Right pane: header line with the selected agent's id + agentName, a
		//    blank line, then the full conversation transcript (prompt → assistant
		//    turns → tool calls → tool results), auto-scrolled to the bottom. ──
		let rightLines: string[] = [];
		const selectedAgent = agents.length > 0
			? agents[Math.min(this.selectedIndex, agents.length - 1)]
			: undefined;
		if (selectedAgent) {
			const header = `${this.fg("accent", selectedAgent.id)} ${this.fg("text", selectedAgent.agentName)}`;
			rightLines.push(truncateLine(header, rightWidth));
			rightLines.push(""); // blank separator line

			for (const entry of selectedAgent.transcript) {
				if (entry.kind === "tool") {
					// The tool line IS the label — no separate body.
					rightLines.push(truncateLine(this.fg("toolOutput", `→ ${entry.text}`), rightWidth));
				} else {
					const label =
						entry.kind === "prompt"
							? this.fg("accent", "▸ prompt")
							: entry.kind === "assistant"
								? this.fg("success", "● agent")
								: this.fg("muted", "  ⤷ result");
					rightLines.push(truncateLine(label, rightWidth));
					for (const line of wrapTextWithAnsi(entry.text, rightWidth)) {
						rightLines.push(line);
					}
				}
				rightLines.push(""); // blank line between blocks
			}

			// Drop the trailing blank line so it doesn't waste a slot.
			if (rightLines[rightLines.length - 1] === "") rightLines.pop();
		} else {
			rightLines.push(this.fg("muted", "(no agent selected)"));
		}

		// ── Merge: pad both panes to the same number of lines (the available
		//    content height minus the pinned footer), join with the separator, and
		//    truncate to the full inner width so the right border stays aligned. ──
		const bodySlots = Math.max(0, available - 1); // last slot reserved for footer

		// Scroll window for the right pane. scrollOffset is lines scrolled UP from
		// the bottom; offset 0 == pinned to the newest content. followBottom forces
		// offset 0 so a growing transcript keeps showing the latest turn. The
		// transcript grows live, so clamp scrollOffset against maxScroll every
		// render — a stale offset (e.g. after the agent emitted new lines, or the
		// terminal was resized) must never point past the oldest content.
		const maxScroll = Math.max(0, rightLines.length - bodySlots);
		if (this.followBottom) {
			this.scrollOffset = 0;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const start = Math.max(0, rightLines.length - bodySlots - this.scrollOffset);
		rightLines = rightLines.slice(start, start + bodySlots);

		const leftPadded = this.padLines(leftLines, bodySlots, listWidth);
		const rightPadded = this.padLines(rightLines, bodySlots, rightWidth);

		const content: string[] = [];
		for (let i = 0; i < bodySlots; i++) {
			const left = leftPadded[i] ?? "";
			const right = rightPadded[i] ?? "";
			content.push(truncateLine(`${this.padTo(left, listWidth)}${separator}${this.padTo(right, rightWidth)}`, innerWidth));
		}
		content.push(this.fg("dim", footerHint));

		return this.composeBordered(title, footerHint, content, width, innerWidth, height, true);
	}

	/** Pad an array of inner-width lines up to `count` lines with blank lines. */
	private padLines(lines: string[], count: number, _w: number): string[] {
		const out = lines.slice(0, count);
		while (out.length < count) out.push("");
		return out;
	}

	/**
	 * Wrap a content array with the bordered box (top border with title, padded
	 * rows, pinned footer hint, bottom border) and ensure the result has exactly
	 * `height` lines.
	 *
	 * When `alreadyFooter` is true, `content` already contains the footer hint as
	 * its last line (used by the expanded two-pane layout, which merges its own
	 * rows + footer) — so we skip the separate footer pinning logic.
	 */
	private composeBordered(
		title: string,
		footerHint: string,
		content: string[],
		width: number,
		innerWidth: number,
		height: number,
		alreadyFooter = false,
	): string[] {
		const available = height - 2;
		const lines: string[] = [];
		lines.push(this.makeTopBorder(title, width, innerWidth));

		if (alreadyFooter) {
			// `content` already contains exactly `available` lines (body + footer).
			for (let i = 0; i < available; i++) {
				lines.push(this.padRow(content[i] ?? "", innerWidth));
			}
		} else if (content.length + 1 <= available) {
			// Few agents: content top-aligned, blank padding fills the middle, and the
			// footer hint is pinned to the last slot above the bottom border.
			for (const c of content) {
				lines.push(this.padRow(c, innerWidth));
			}
			const blankCount = Math.max(0, available - content.length - 1);
			for (let i = 0; i < blankCount; i++) {
				lines.push(this.padRow("", innerWidth));
			}
			lines.push(this.padRow(this.fg("dim", footerHint), innerWidth));
		} else {
			// More agents than fit: reserve the last slot for the footer hint, slice the rest.
			const bodySlots = available - 1; // last slot reserved for footer
			for (let i = 0; i < bodySlots; i++) {
				lines.push(this.padRow(content[i], innerWidth));
			}
			lines.push(this.padRow(this.fg("dim", footerHint), innerWidth));
		}

		lines.push(this.makeBottomBorder(width));
		// Defensive: guarantee exactly `height` lines.
		while (lines.length < height) lines.push(this.padRow("", innerWidth));
		if (lines.length > height) lines.length = height;
		return lines;
	}

	/** Unbordered layout used when the terminal is too narrow for a box. */
	private renderUnbordered(width: number, agents: PanelAgent[]): string[] {
		const lines: string[] = [];
		const runningCount = agents.filter((a) => a.status === "running").length;
		lines.push(truncateLine(this.fg("toolTitle", `agents — ${runningCount} running`), width));

		if (agents.length === 0) {
			lines.push(truncateLine(this.fg("muted", "No agents running."), width));
			lines.push(truncateLine(this.fg("dim", "↑↓ select   ⏎ output   k kill   q close"), width));
			return lines;
		}

		if (this.selectedIndex >= agents.length) this.selectedIndex = agents.length - 1;
		if (this.selectedIndex < 0) this.selectedIndex = 0;

		for (let i = 0; i < agents.length; i++) {
			const a = agents[i];
			const selected = i === this.selectedIndex;
			const marker = selected ? "▸ " : "  ";
			const icon = this.fg(statusColor(a.status), statusIcon(a.status));
			const id = this.fg("accent", a.id);
			const name = this.fg("text", a.agentName);
			const elapsed = this.fg("dim", formatElapsed(a.startTime));
			const tool = a.currentTool
				? this.fg("toolOutput", `tool:${a.currentTool}`)
				: this.fg("muted", "(awaiting model)");
			const idle = a.lastEventAt !== undefined ? this.fg("dim", `idle:${formatElapsed(a.lastEventAt)}`) : "";

			const prefix = `${marker}${icon} ${id} ${name} ${elapsed} ${tool}${idle ? " " + idle : ""}`;
			const prefixWidth = visibleWidth(prefix);
			const remaining = width - prefixWidth - 1;
			const taskPreview = remaining > 0
				? this.fg("dim", truncateLine(a.task.replace(/\s+/g, " ").trim(), remaining))
				: "";
			const row = taskPreview ? `${prefix} ${taskPreview}` : prefix;
			lines.push(truncateLine(selected ? this.fg("text", row) : row, width));
		}

		lines.push(truncateLine(this.fg("dim", "↑↓ select   ⏎ output   k kill   q close"), width));
		return lines;
	}

	/** Build the top border with the title embedded: "╭─ <title> ──…─╮" */
	private makeTopBorder(title: string, width: number, innerWidth: number): string {
		const titleText = ` ${truncateLine(this.fg("toolTitle", title), innerWidth)} `;
		const titleW = visibleWidth(titleText);
		const dashes = Math.max(0, width - 2 - titleW); // 2 corner chars
		return `╭${titleText}${"─".repeat(dashes)}╮`;
	}

	/** Build the bottom border: "╰──…──╯" */
	private makeBottomBorder(width: number): string {
		const dashes = Math.max(0, width - 2);
		return `╰${"─".repeat(dashes)}╯`;
	}

	/** Wrap a content line as "│ <content> │", truncating to innerWidth first, then padding to align the right border. */
	private padRow(content: string, innerWidth: number): string {
		const truncated = truncateLine(content, innerWidth);
		const pad = Math.max(0, innerWidth - visibleWidth(truncated));
		return `│ ${truncated}${" ".repeat(pad)} │`;
	}

	handleInput(data: string): void {
		// Named special keys are matched first via matchesKey, which understands
		// both legacy CSI sequences and the Kitty keyboard protocol CSI-u form.
		// Escape is matched explicitly (not via a bare "\x1b" literal) so arrow
		// keys can never be mistaken for a close.

		// In expanded mode, arrow/page/home/end keys scroll the right-pane
		// transcript instead of changing agent selection. Tab switches agents.
		if (this.mode === "expanded") {
			if (matchesKey(data, "up")) {
				this.scrollOffset += 1;
				this.followBottom = false;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				if (this.scrollOffset === 0) this.followBottom = true;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.scrollOffset += 10;
				this.followBottom = false;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.scrollOffset = Math.max(0, this.scrollOffset - 10);
				if (this.scrollOffset === 0) this.followBottom = true;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "home")) {
				// Jump to the OLDEST content. Set a large value and let the per-render
				// clamp pin it to maxScroll.
				this.scrollOffset = Number.MAX_SAFE_INTEGER;
				this.followBottom = false;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "end")) {
				this.scrollOffset = 0;
				this.followBottom = true;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "tab")) {
				const count = this.getAgents().length;
				if (count > 0) {
					this.selectedIndex = (this.selectedIndex + 1) % count;
				}
				this.scrollOffset = 0;
				this.followBottom = true;
				this.requestRender();
				return;
			}
		}

		// In list mode, PageUp/PageDown/Home/End move the SELECTION; the viewport
		// (listScrollOffset) follows automatically in renderList since it's
		// clamped to keep the selection in view every render.
		if (this.mode === "list") {
			if (matchesKey(data, "pageUp")) {
				const count = this.getAgents().length;
				if (count === 0) return;
				this.selectedIndex = Math.max(0, this.selectedIndex - 10);
				this.requestRender();
				return;
			}
			if (matchesKey(data, "pageDown")) {
				const count = this.getAgents().length;
				if (count === 0) return;
				this.selectedIndex = Math.min(count - 1, this.selectedIndex + 10);
				this.requestRender();
				return;
			}
			if (matchesKey(data, "home")) {
				const count = this.getAgents().length;
				if (count === 0) return;
				this.selectedIndex = 0;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "end")) {
				const count = this.getAgents().length;
				if (count === 0) return;
				this.selectedIndex = Math.max(0, count - 1);
				this.requestRender();
				return;
			}
		}

		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			const count = this.getAgents().length;
			this.selectedIndex = Math.min(count - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			if (this.mode === "list") {
				if (this.getAgents().length > 0) {
					this.dispose();
					this.onExpand();
				}
			} else {
				// "expanded" — Enter returns to the narrow list.
				this.dispose();
				this.onCollapse();
			}
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.mode === "expanded") {
				this.dispose();
				this.onCollapse();
			} else {
				this.dispose();
				this.onClose();
			}
			return;
		}
		// Plain letters normally arrive literally; fall back to parseKey for any
		// terminal that wraps them in a protocol sequence.
		const letter = parseKey(data);
		if (data === "k" || letter === "k") {
			const agents = this.getAgents();
			if (agents.length > 0) {
				const a = agents[Math.min(this.selectedIndex, agents.length - 1)];
				this.onKill(a.id);
				this.requestRender();
			}
			return;
		}
		if (data === "q" || letter === "q") {
			this.dispose();
			this.onClose();
			return;
		}
	}

	invalidate(): void {
		// No cached state to clear.
	}
}
