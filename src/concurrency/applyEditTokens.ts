import * as crypto from 'crypto';

export interface ApplyEditToken {
	id: string;
	docId: string;
	reason: 'undo' | 'redo' | 'checkout' | 'navigate' | 'reset';
}

export class ApplyEditTokenSet {
	private tokens = new Map<string, Set<ApplyEditToken>>();

	begin(docId: string, reason: ApplyEditToken['reason']): ApplyEditToken {
		const id = generateTokenId();
		const token: ApplyEditToken = { id, docId, reason };
		let docTokens = this.tokens.get(docId);
		if (!docTokens) {
			docTokens = new Set();
			this.tokens.set(docId, docTokens);
		}
		docTokens.add(token);
		return token;
	}

	end(token: ApplyEditToken): void {
		const docTokens = this.tokens.get(token.docId);
		if (!docTokens) {
			return;
		}
		docTokens.delete(token);
		if (docTokens.size === 0) {
			this.tokens.delete(token.docId);
		}
	}

	isApplying(docId: string): boolean {
		const docTokens = this.tokens.get(docId);
		return docTokens !== undefined && docTokens.size > 0;
	}

	getActive(docId: string): number {
		return this.tokens.get(docId)?.size ?? 0;
	}

	clear(): void {
		this.tokens.clear();
	}
}

function generateTokenId(): string {
	const timestamp = Date.now().toString(36);
	const rand = crypto.randomBytes(4).toString('hex');
	return `at_${timestamp}_${rand}`;
}
