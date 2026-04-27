import type { MarkdownPostProcessor, MarkdownPostProcessorContext } from "obsidian";
import type { CursorAgentPlugin } from "../plugin";

/** Paths and slash-like inner text only; blocks injection via attributes or text. */
const SKILL_ATTR_SAFE = /^[a-zA-Z0-9_.~/\s-]{1,512}$/;
const INNER_SAFE = /^[/a-zA-Z0-9_.\s-]{1,160}$/;

/**
 * - `obsidian://cursoragent?…` markdown links: style as run links (click opens protocol → handler).
 * - Legacy `<cursor-agent>…</cursor-agent>`: replace with the same Run button as before.
 */
export function registerCursorAgentInvokeMarkdown(plugin: CursorAgentPlugin): void {
	const run = Object.assign(
		(el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		el.querySelectorAll("a[href^='obsidian://cursoragent']").forEach((raw) => {
			const a = raw as HTMLElement;
			a.addClass("cursor-agent-md-link");
		});

		el.querySelectorAll("cursor-agent").forEach((raw) => {
			const node = raw as HTMLElement;
			const skillAttr = (node.getAttribute("skill") ?? "").trim();
			const inner = (node.textContent ?? "").trim();
			if (skillAttr && !SKILL_ATTR_SAFE.test(skillAttr)) return;
			if (inner && !INNER_SAFE.test(inner)) return;
			if (!skillAttr && !inner) return;

			const pill = el.createSpan({ cls: "cursor-agent-invoke-pill" });
			const label =
				(inner || skillAttr).length > 72 ? (inner || skillAttr).slice(0, 69) + "…" : inner || skillAttr;
			pill.createEl(
				"button",
				{
					type: "button",
					cls: "cursor-agent-invoke-btn",
					text: "Run: " + label,
				},
				(b) => {
					b.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						const sourcePath = ctx.sourcePath ?? "";
						if (!sourcePath) return;
						void plugin.invokeAgentSkillFromNote({
							sourcePath,
							slashId: inner || undefined,
							skillPath: skillAttr || undefined,
						});
					});
				}
			);
			node.replaceWith(pill);
		});
		},
		{ sortOrder: 0 }
	) as MarkdownPostProcessor;
	plugin.registerMarkdownPostProcessor(run);
}
