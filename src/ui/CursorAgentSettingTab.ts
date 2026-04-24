import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { CursorAgentPlugin } from "../plugin";
import type { AgentMode } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";
import { getAgentLogPath, revealAgentLogFile } from "../logging/agentFileLog";
import { agentBinaryExists, expandAgentPath, sanitizeModelId } from "../agentModels";

export class CursorAgentSettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: CursorAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Cursor Agent" });

		containerEl.createEl("p", {
			text: "Uses the Cursor CLI (`agent acp`). Install the CLI and run `agent login` in a terminal once. Workspace is always your vault folder.",
			cls: "setting-item-description",
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
