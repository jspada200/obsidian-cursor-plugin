import { App, Modal, Setting } from "obsidian";

export type PermissionChoice = "allow-once" | "allow-always" | "reject-once";

export class PermissionModal extends Modal {
	constructor(
		app: App,
		readonly summary: string,
		readonly onChoose: (choice: PermissionChoice) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Tool permission" });
		contentEl.createEl("pre", { cls: "cursor-agent-perm-pre", text: this.summary });

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Allow once").onClick(() => {
				this.onChoose("allow-once");
				this.close();
			})
		);
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Allow always").onClick(() => {
				this.onChoose("allow-always");
				this.close();
			})
		);
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Deny").onClick(() => {
				this.onChoose("reject-once");
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class CreatePlanModal extends Modal {
	constructor(
		app: App,
		readonly overview: string,
		readonly planMd: string,
		readonly onOutcome: (accepted: boolean) => void
	) {
		super(app);
		this.modalEl.addClass("cursor-agent-plan-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.overview) contentEl.createEl("p", { text: this.overview });
		contentEl.createEl("pre", { cls: "cursor-agent-plan-md", text: this.planMd });

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Accept").setCta().onClick(() => {
				this.onOutcome(true);
				this.close();
			})
		);
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Reject").onClick(() => {
				this.onOutcome(false);
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

interface AskQ {
	id: string;
	prompt: string;
	options: Array<{ id: string; label: string }>;
	allowMultiple?: boolean;
}

export class AskQuestionModal extends Modal {
	constructor(
		app: App,
		readonly title: string | undefined,
		readonly questions: AskQ[],
		readonly onAnswer: (answers: Array<{ questionId: string; selectedOptionIds: string[] }>) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.title) contentEl.createEl("h3", { text: this.title });

		const selections = this.questions.map((q) => ({
			questionId: q.id,
			selectedOptionIds: [] as string[],
			allowMultiple: !!q.allowMultiple,
		}));

		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			contentEl.createEl("p", { text: q.prompt, cls: "cursor-agent-ask-q" });
			for (const opt of q.options) {
				new Setting(contentEl).addButton((b) =>
					b.setButtonText(opt.label).onClick(() => {
						const sel = selections[i].selectedOptionIds;
						if (selections[i].allowMultiple) {
							const ix = sel.indexOf(opt.id);
							if (ix >= 0) sel.splice(ix, 1);
							else sel.push(opt.id);
						} else {
							sel.length = 0;
							sel.push(opt.id);
						}
					})
				);
			}
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Submit").setCta().onClick(() => {
				this.onAnswer(
					selections.map((s) => ({
						questionId: s.questionId,
						selectedOptionIds: [...s.selectedOptionIds],
					}))
				);
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
