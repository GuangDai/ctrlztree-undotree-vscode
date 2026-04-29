import * as path from 'path';
import * as fs from 'fs';

import { runTests } from 'vscode-test';

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');
		const localVSCodeExecutablePath = path.resolve(
			__dirname,
			'../../.vscode-test/vscode-linux-x64-1.118.0/VSCode-linux-x64/code'
		);
		const vscodeExecutablePath = fs.existsSync(localVSCodeExecutablePath)
			? localVSCodeExecutablePath
			: undefined;

		// Download VS Code, unzip it and run the integration test.
		// The sandbox flags keep the test runner usable in restricted CI/agent shells.
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			vscodeExecutablePath,
			version: '1.118.0',
			launchArgs: ['--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
			extensionTestsEnv: {
				['ELECTRON_DISABLE_SANDBOX']: '1'
			}
		});
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	}
}

main();
