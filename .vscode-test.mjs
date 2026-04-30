import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@vscode/test-cli';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(rootDir, '.vscode-test', 'isolated');
const workspaceFolder = path.join(rootDir, 'test-fixtures', 'workspace');
const userDataDir = path.join(testDataDir, 'user-data');
const extensionsDir = path.join(testDataDir, 'extensions');
const crashReporterDir = path.join(testDataDir, 'crashes');
const requestedVersion = process.env.VSCODE_TEST_VERSION || '1.117.0';
const downloadedVSCodeExecutablePath = getDownloadedVSCodeExecutablePath(requestedVersion);
const systemVSCodeExecutablePath = process.env.VSCODE_TEST_USE_SYSTEM_CODE === '0'
	? undefined
	: findVSCodeExecutableInPath();

const useInstallation = process.env.VSCODE_TEST_EXECUTABLE
	? { fromPath: process.env.VSCODE_TEST_EXECUTABLE }
	: downloadedVSCodeExecutablePath && fs.existsSync(downloadedVSCodeExecutablePath)
		? { fromPath: downloadedVSCodeExecutablePath }
		: systemVSCodeExecutablePath
			? { fromPath: systemVSCodeExecutablePath }
			: undefined;

const verboseArgs = process.env.VSCODE_TEST_VERBOSE === '1' ? ['--verbose'] : [];
const crashReporterArgs = process.env.VSCODE_TEST_CRASH_REPORTER === '1'
	? [`--crash-reporter-directory=${crashReporterDir}`]
	: ['--disable-crash-reporter'];

export default defineConfig({
	files: 'out/test/**/*.test.js',
	version: requestedVersion,
	extensionDevelopmentPath: rootDir,
	workspaceFolder,
	useInstallation,
	skipExtensionDependencies: true,
	launchArgs: [
		'--disable-extensions',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--no-sandbox',
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		...verboseArgs,
		...crashReporterArgs
	],
	env: {
		CI: process.env.CI || '1',
		ELECTRON_DISABLE_SANDBOX: '1',
		VSCODE_TEST_ENV: '1'
	},
	mocha: {
		ui: 'tdd',
		color: true,
		timeout: 10000,
		slow: 250,
		forbidOnly: true
	}
});

function getDownloadedVSCodeExecutablePath(version) {
	if (process.platform !== 'linux') {
		return undefined;
	}

	return path.join(
		rootDir,
		'.vscode-test',
		`vscode-linux-${os.arch()}-${version}`,
		`VSCode-linux-${os.arch()}`,
		'code'
	);
}

function findVSCodeExecutableInPath() {
	const pathValue = process.env.PATH;
	if (!pathValue) {
		return undefined;
	}

	const executableNames = process.platform === 'win32'
		? ['code.cmd', 'code.exe', 'code-insiders.cmd', 'code-insiders.exe']
		: ['code', 'code-insiders'];

	for (const directory of pathValue.split(path.delimiter)) {
		for (const executableName of executableNames) {
			const candidate = path.join(directory, executableName);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}
