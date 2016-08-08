
'use strict';

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) 
{
	let disposable = vscode.commands.registerCommand('extension.runDukDebugger', () => {
		//return vscode.window.showInputBox({
		//	placeHolder: "Please enter the name of a text file in the workspace folder",
		//	value: "readme.md"
		//});
		 
        // The code you place here will be executed every time your command is executed

        // Display a message box to the user
        vscode.window.showInformationMessage('Hello World!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
}
