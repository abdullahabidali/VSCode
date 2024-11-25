/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../../base/common/arrays.js';
import { IMarkdownString, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { IDecorationOptions } from '../../../../../editor/common/editorCommon.js';
import { Command } from '../../../../../editor/common/languages.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { AnythingQuickAccessProviderRunOptions, IQuickAccessOptions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatWidget } from '../chat.js';
import { ChatWidget, IChatWidgetContrib } from '../chatWidget.js';
import { IChatRequestVariableValue, IChatVariablesService, IDynamicVariable } from '../../common/chatVariables.js';
import { ChatDynamicVariable } from './chatDynamicVariable.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';

export const dynamicVariableDecorationType = 'chat-dynamic-variable';

export class ChatDynamicVariableModel extends Disposable implements IChatWidgetContrib {
	public static readonly ID = 'chatDynamicVariableModel';

	private _variables: ChatDynamicVariable[] = [];
	get variables(): ReadonlyArray<ChatDynamicVariable> {
		return [...this._variables];
	}

	get id() {
		return ChatDynamicVariableModel.ID;
	}

	constructor(
		private readonly widget: IChatWidget,
		@ILabelService private readonly labelService: ILabelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(widget.inputEditor.onDidChangeModelContent(e => {
			e.changes.forEach(c => {
				// Don't mutate entries in _variables, since they will be returned from the getter
				this._variables = coalesce(this._variables.map((ref) => {
					if (c.text === `#file:${ref.filenameWithReferences}`) {
						return ref;
					}

					const intersection = Range.intersectRanges(ref.range, c.range);
					if (intersection && !intersection.isEmpty()) {
						// The reference text was changed, it's broken.
						// But if the whole reference range was deleted (eg history navigation) then don't try to change the editor.
						if (!Range.containsRange(c.range, ref.range)) {
							const rangeToDelete = new Range(ref.range.startLineNumber, ref.range.startColumn, ref.range.endLineNumber, ref.range.endColumn - 1);
							this.widget.inputEditor.executeEdits(this.id, [{
								range: rangeToDelete,
								text: '',
							}]);
							this.widget.refreshParsedInput();
						}
						return null;
					}

					if (Range.compareRangesUsingStarts(ref.range, c.range) > 0) {
						const delta = c.text.length - c.rangeLength;
						ref.range = {
							startLineNumber: ref.range.startLineNumber,
							startColumn: ref.range.startColumn + delta,
							endLineNumber: ref.range.endLineNumber,
							endColumn: ref.range.endColumn + delta,
						};

						return ref;
					}

					return ref;
				}));
			});

			this.updateVariableDecorations();
		}));
	}

	setInputState(s: any): void {
		if (!Array.isArray(s)) {
			s = [];
		}

		this._variables = s;
		this.updateVariableDecorations();
	}

	public addReference(ref: IDynamicVariable): void {
		const variable = this._register(
			this.instantiationService.createInstance(ChatDynamicVariable, ref),
		);

		this._variables.push(variable);
		this.updateVariableDecorations();
		this.widget.refreshParsedInput();

		// if the `prompt snippets` feature is enabled, start resolving
		// nested file references immediatelly and subscribe to updates
		if (variable.isPromptSnippetFile) {
			// subscribe to variable changes
			this._register(variable.onUpdate(() => {
				this.updateVariableTexts();
				this.updateVariableDecorations();
				this.widget.refreshParsedInput();
			}));
			// start resolving the file references
			variable.resolve();
		}
	}

	/**
	 * Update variables text inside input editor to add the `(+N more)`
	 * suffix if the variable has nested child file references.
	 */
	private updateVariableTexts(): void {
		for (const variable of this._variables) {
			const text = `#file:${variable.filenameWithReferences}`;
			const range = variable.range;

			const success = this.widget.inputEditor.executeEdits(
				'chatUpdateFileReference',
				[EditOperation.replaceMove(new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn), text)],
			);

			if (!success) {
				continue;
			}

			variable.range = new Range(
				range.startLineNumber,
				range.startColumn,
				range.endLineNumber,
				range.startColumn + text.length,
			);
		}
	}

	private updateVariableDecorations(): void {
		this.widget.inputEditor.setDecorationsByType(
			'chat',
			dynamicVariableDecorationType,
			this._variables.map((variable): IDecorationOptions => {
				return {
					range: variable.range,
					hoverMessage: this.getHoverForReference(variable),
				};
			}),
		);
	}

	private getHoverForReference(variable: IDynamicVariable): IMarkdownString | IMarkdownString[] {
		const result: IMarkdownString[] = [];
		const { data } = variable;

		if (!URI.isUri(data)) {
			return result;
		}

		result.push(new MarkdownString(
			`${this.labelService.getUriLabel(data, { relative: true })}`,
		));

		// if reference has nested child file references, include them in the label
		for (const childUri of variable.validFileReferenceUris ?? []) {
			result.push(new MarkdownString(
				`  • ${this.labelService.getUriLabel(childUri, { relative: true })}`,
			));
		}

		return result;
	}
}

ChatWidget.CONTRIBS.push(ChatDynamicVariableModel);

interface SelectAndInsertFileActionContext {
	widget: IChatWidget;
	range: IRange;
}

function isSelectAndInsertFileActionContext(context: any): context is SelectAndInsertFileActionContext {
	return 'widget' in context && 'range' in context;
}

export class SelectAndInsertFileAction extends Action2 {
	static readonly Name = 'files';
	static readonly Item = {
		label: localize('allFiles', 'All Files'),
		description: localize('allFilesDescription', 'Search for relevant files in the workspace and provide context from them'),
	};
	static readonly ID = 'workbench.action.chat.selectAndInsertFile';

	constructor() {
		super({
			id: SelectAndInsertFileAction.ID,
			title: '' // not displayed
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		const textModelService = accessor.get(ITextModelService);
		const logService = accessor.get(ILogService);
		const quickInputService = accessor.get(IQuickInputService);
		const chatVariablesService = accessor.get(IChatVariablesService);

		const context = args[0];
		if (!isSelectAndInsertFileActionContext(context)) {
			return;
		}

		const doCleanup = () => {
			// Failed, remove the dangling `file`
			context.widget.inputEditor.executeEdits('chatInsertFile', [{ range: context.range, text: `` }]);
		};

		let options: IQuickAccessOptions | undefined;
		// If we have a `files` variable, add an option to select all files in the picker.
		// This of course assumes that the `files` variable has the behavior that it searches
		// through files in the workspace.
		if (chatVariablesService.hasVariable(SelectAndInsertFileAction.Name)) {
			const providerOptions: AnythingQuickAccessProviderRunOptions = {
				additionPicks: [SelectAndInsertFileAction.Item, { type: 'separator' }]
			};
			options = { providerOptions };
		}
		// TODO: have dedicated UX for this instead of using the quick access picker
		const picks = await quickInputService.quickAccess.pick('', options);
		if (!picks?.length) {
			logService.trace('SelectAndInsertFileAction: no file selected');
			doCleanup();
			return;
		}

		const editor = context.widget.inputEditor;
		const range = context.range;

		// Handle the special case of selecting all files
		if (picks[0] === SelectAndInsertFileAction.Item) {
			const text = `#${SelectAndInsertFileAction.Name}`;
			const success = editor.executeEdits('chatInsertFile', [{ range, text: text + ' ' }]);
			if (!success) {
				logService.trace(`SelectAndInsertFileAction: failed to insert "${text}"`);
				doCleanup();
			}
			return;
		}

		// Handle the case of selecting a specific file
		const resource = (picks[0] as unknown as { resource: unknown }).resource as URI;
		if (!textModelService.canHandleResource(resource)) {
			logService.trace('SelectAndInsertFileAction: non-text resource selected');
			doCleanup();
			return;
		}

		const fileName = basename(resource);
		const text = `#file:${fileName}`;
		const success = editor.executeEdits('chatInsertFile', [{ range, text: text + ' ' }]);
		if (!success) {
			logService.trace(`SelectAndInsertFileAction: failed to insert "${text}"`);
			doCleanup();
			return;
		}

		context.widget.getContrib<ChatDynamicVariableModel>(ChatDynamicVariableModel.ID)?.addReference({
			id: 'vscode.file',
			isFile: true,
			prefix: 'file',
			range: {
				startLineNumber: range.startLineNumber,
				startColumn: range.startColumn,
				endLineNumber: range.endLineNumber,
				endColumn: range.startColumn + text.length,
			},
			data: resource,
		});
	}
}
registerAction2(SelectAndInsertFileAction);

export interface IAddDynamicVariableContext {
	id: string;
	widget: IChatWidget;
	range: IRange;
	variableData: IChatRequestVariableValue;
	command?: Command;
}

function isAddDynamicVariableContext(context: any): context is IAddDynamicVariableContext {
	return 'widget' in context &&
		'range' in context &&
		'variableData' in context;
}

export class AddDynamicVariableAction extends Action2 {
	static readonly ID = 'workbench.action.chat.addDynamicVariable';

	constructor() {
		super({
			id: AddDynamicVariableAction.ID,
			title: '' // not displayed
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		const context = args[0];
		if (!isAddDynamicVariableContext(context)) {
			return;
		}

		let range = context.range;
		const variableData = context.variableData;

		const doCleanup = () => {
			// Failed, remove the dangling variable prefix
			context.widget.inputEditor.executeEdits('chatInsertDynamicVariableWithArguments', [{ range: context.range, text: `` }]);
		};

		// If this completion item has no command, return it directly
		if (context.command) {
			// Invoke the command on this completion item along with its args and return the result
			const commandService = accessor.get(ICommandService);
			const selection: string | undefined = await commandService.executeCommand(context.command.id, ...(context.command.arguments ?? []));
			if (!selection) {
				doCleanup();
				return;
			}

			// Compute new range and variableData
			const insertText = ':' + selection;
			const insertRange = new Range(range.startLineNumber, range.endColumn, range.endLineNumber, range.endColumn + insertText.length);
			range = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn + insertText.length);
			const editor = context.widget.inputEditor;
			const success = editor.executeEdits('chatInsertDynamicVariableWithArguments', [{ range: insertRange, text: insertText + ' ' }]);
			if (!success) {
				doCleanup();
				return;
			}
		}

		context.widget.getContrib<ChatDynamicVariableModel>(ChatDynamicVariableModel.ID)?.addReference({
			id: context.id,
			range: range,
			isFile: true,
			prefix: 'file',
			data: variableData,
		});
	}
}
registerAction2(AddDynamicVariableAction);
