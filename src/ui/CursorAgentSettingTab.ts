import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { CursorAgentPlugin } from "../plugin";
import type { AgentMode } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";
import { getAgentLogPath, revealAgentLogFile } from "../logging/agentFileLog";
import { agentBinaryExists, expandAgentPath, sanitizeModelId } from "../agentModels";

const PLUGIN_REPO = "https://github.com/jspada200/obsidian-cursor-plugin";
const PLUGIN_ISSUES = `${PLUGIN_REPO}/issues`;
const BMC_URL = "https://www.buymeacoffee.com/spadjv";
const BMC_IMG = "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png";

function addExternalLink(parent: HTMLElement, label: string, href: string): HTMLAnchorElement {
	const a = parent.createEl("a", { text: label, href });
	a.classList.add("cursor-agent-settings-header-link");
	a.setAttr("target", "_blank");
	a.setAttr("rel", "noopener noreferrer");
	return a;
}

export class CursorAgentSettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: CursorAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const { manifest } = this.plugin;
		const header = containerEl.createDiv({ cls: "cursor-agent-settings-header" });

		const titleRow = header.createDiv({ cls: "cursor-agent-settings-header-title-row" });
		titleRow.createEl("h2", { cls: "cursor-agent-settings-header-title", text: manifest.name });
		titleRow.createEl("span", { cls: "cursor-agent-settings-header-version", text: `v${manifest.version}` });

		header.createEl("p", {
			cls: "cursor-agent-settings-header-desc",
			text: `${manifest.description} It uses the Cursor CLI (\`agent\` / ACP) with your vault as the workspace. Install the CLI, run \`agent login\` once, then chat from the Cursor Agent view.`,
		});

		const links = header.createDiv({ cls: "cursor-agent-settings-header-links" });
		addExternalLink(links, "GitHub repository", PLUGIN_REPO);
		addExternalLink(links, "Report an issue", PLUGIN_ISSUES);

		const bmc = header.createDiv({ cls: "cursor-agent-settings-header-bmc" });
		const bmcLink = bmc.createEl("a", { href: BMC_URL });
		bmcLink.setAttr("target", "_blank");
		bmcLink.setAttr("rel", "noopener noreferrer");
		bmcLink.createEl("img", {
			cls: "cursor-agent-settings-header-bmc-img",
			attr: {
				src: BMC_IMG,
				alt: "Buy Me A Coffee",
			},
		});

		new Setting(containerEl)
			.setName("Agent binary path")
			.setDesc(
				process.platform === "win32"
					? "Leave empty to use %LOCALAPPDATA%\\cursor-agent\\agent.cmd (Cursor’s Windows shim)."
					: "Leave empty to use ~/.local/bin/agent."
			)
			.addText((t) =>
				t
					.setPlaceholder("~/.local/bin/agent")
					.setValue(this.plugin.settings.agentBinaryPath)
					.onChange(async (v) => {
						this.plugin.settings.agentBinaryPath = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Verify binary").addButton((b) =>
			b.setButtonText("Check").onClick(() => {
				const p = expandAgentPath(this.plugin.settings.agentBinaryPath);
				if (agentBinaryExists(p)) new Notice("Found: " + p);
				else new Notice("Not found or not executable: " + p);
			})
		);

		new Setting(containerEl)
			.setName("Extra agent arguments")
			.setDesc("Split on whitespace; appended before the `acp` subcommand.")
			.addText((t) =>
				t
					.setPlaceholder("")
					.setValue(this.plugin.settings.extraAgentArgs)
					.onChange(async (v) => {
						this.plugin.settings.extraAgentArgs = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default mode")
			.addDropdown((d) =>
				d
					.addOption("ask", "Ask")
					.addOption("agent", "Agent")
					.setValue(this.plugin.settings.defaultMode)
					.onChange(async (v) => {
						this.plugin.settings.defaultMode = v as AgentMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default model")
			.setDesc(
				"Model id for `--model` (e.g. composer-2-fast). Paste from `agent models` if needed — only the id before “ - ” is kept."
			)
			.addText((t) =>
				t.setValue(this.plugin.settings.defaultModel).onChange(async (v) => {
					this.plugin.settings.defaultModel = sanitizeModelId(v);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Trust workspace (--trust)")
			.setDesc("Skips workspace trust prompts for headless ACP.")
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.trustWorkspace).onChange(async (v) => {
					this.plugin.settings.trustWorkspace = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Permission automation")
			.setDesc("Prefer manual review for safety.")
			.addDropdown((d) =>
				d
					.addOption("never", "Never auto-approve")
					.addOption("allow_once_default", "Allow once (testing only)")
					.addOption("allow_always_shell", "Allow always (dangerous)")
					.setValue(this.plugin.settings.autoApprovePermissions)
					.onChange(async (v) => {
						this.plugin.settings.autoApprovePermissions = v as typeof DEFAULT_SETTINGS.autoApprovePermissions;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include open tabs in context")
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.includeOpenTabs).onChange(async (v) => {
					this.plugin.settings.includeOpenTabs = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Include links from active note")
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.includeLinkedNotes).onChange(async (v) => {
					this.plugin.settings.includeLinkedNotes = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max open tabs in preamble")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(this.plugin.settings.maxContextTabs)).onChange(async (v) => {
					this.plugin.settings.maxContextTabs = Number(v) || DEFAULT_SETTINGS.maxContextTabs;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Max linked notes in preamble")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(this.plugin.settings.maxContextLinks)).onChange(async (v) => {
					this.plugin.settings.maxContextLinks = Number(v) || DEFAULT_SETTINGS.maxContextLinks;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Extra skill scan directories")
			.setDesc(
				"One absolute path per line. Each tree is scanned for SKILL.md (in addition to the vault’s .cursor/skills and ~/.cursor/skills)."
			)
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.setPlaceholder("/path/to/more/skills-root");
				t.setValue(this.plugin.settings.extraSkillScanDirs).onChange(async (v) => {
					this.plugin.settings.extraSkillScanDirs = v;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "Diagnostics log" });

		new Setting(containerEl)
			.setName("Write agent log file")
			.setDesc(
				"Append spawn args, ACP JSON-RPC traffic (summarized), stderr, and session/update notifications to cursor-agent.log next to this plugin."
			)
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.agentFileLog).onChange(async (v) => {
					this.plugin.settings.agentFileLog = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Verbose agent log")
			.setDesc(
				"Log longer RPC payloads and prompt excerpts. May include note text from your vault — use only when debugging."
			)
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.agentLogVerbose).onChange(async (v) => {
					this.plugin.settings.agentLogVerbose = v;
					await this.plugin.saveSettings();
				})
			);

		const logPath = getAgentLogPath(this.app, this.plugin.manifest.id);
		new Setting(containerEl)
			.setName("Log file path")
			.setDesc(logPath ?? "Unavailable (desktop vault required).")
			.addButton((b) =>
				b.setButtonText("Reveal in Finder").onClick(() => revealAgentLogFile(this.app, this.plugin.manifest.id))
			);
	}
}
