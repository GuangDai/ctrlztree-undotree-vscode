import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	off: 4,
};

export class Logger {
	private level: LogLevel = 'info';

	constructor(private channel: vscode.OutputChannel) {}

	setLevel(level: LogLevel): void {
		this.level = level;
		if (level !== 'off') {
			this.channel.appendLine(`CtrlZTree: log level set to ${level}`);
		}
	}

	debug(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.debug) {
			this.channel.appendLine(msg);
		}
	}

	info(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.info) {
			this.channel.appendLine(msg);
		}
	}

	warn(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.warn) {
			this.channel.appendLine(msg);
		}
	}

	error(msg: string): void {
		if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.error) {
			this.channel.appendLine(msg);
		}
	}

	getChannel(): vscode.OutputChannel {
		return this.channel;
	}
}
