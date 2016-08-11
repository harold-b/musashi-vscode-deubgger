
'use strict';

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) 
{
	let disposable = vscode.commands.registerCommand('extension.runDukDebugger', () => {
        // The code you place here will be executed every time your command is executed
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
}
