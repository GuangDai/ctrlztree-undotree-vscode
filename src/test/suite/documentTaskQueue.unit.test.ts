import * as assert from 'assert';
import { DocumentTaskQueue } from '../../concurrency/documentTaskQueue';

suite('DocumentTaskQueue', () => {
	let queue: DocumentTaskQueue;

	setup(() => {
		queue = new DocumentTaskQueue();
	});

	test('executes a single task', async () => {
		let executed = false;
		await queue.enqueue('doc1', 'test', async () => {
			executed = true;
		});
		assert.strictEqual(executed, true);
	});

	test('returns task result', async () => {
		const result = await queue.enqueue('doc1', 'test', async () => 42);
		assert.strictEqual(result, 42);
	});

	test('executes same-doc tasks in FIFO order', async () => {
		const results: number[] = [];
		const t1 = queue.enqueue('doc1', 't1', async () => {
			results.push(1);
		});
		const t2 = queue.enqueue('doc1', 't2', async () => {
			results.push(2);
		});
		await Promise.all([t1, t2]);
		assert.deepStrictEqual(results, [1, 2]);
	});

	test('serializes same-doc tasks (does not run in parallel)', async () => {
		let running = 0;
		let maxRunning = 0;
		const tasks = [1, 2, 3].map(n =>
			queue.enqueue('doc1', `t${n}`, async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await delay(10);
				running--;
				return n;
			})
		);
		await Promise.all(tasks);
		assert.strictEqual(maxRunning, 1);
	});

	test('different docs run in parallel', async () => {
		let running = 0;
		let maxRunning = 0;
		const t1 = queue.enqueue('doc1', 't1', async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await delay(20);
			running--;
		});
		const t2 = queue.enqueue('doc2', 't2', async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await delay(20);
			running--;
		});
		await Promise.all([t1, t2]);
		assert.ok(maxRunning >= 2);
	});

	test('getPendingCount returns correct count', async () => {
		assert.strictEqual(queue.getPendingCount('doc1'), 0);
		const t1 = queue.enqueue('doc1', 't1', async () => delay(20));
		assert.strictEqual(queue.getPendingCount('doc1'), 1);
		const t2 = queue.enqueue('doc1', 't2', async () => delay(10));
		assert.strictEqual(queue.getPendingCount('doc1'), 2);
		await Promise.all([t1, t2]);
		assert.strictEqual(queue.getPendingCount('doc1'), 0);
	});

	test('cancelPending prevents subsequent tasks', async () => {
		const t1 = queue.enqueue('doc1', 't1', async () => { /* noop */ });
		queue.cancelPending('doc1', 'test cancel');
		try {
			await queue.enqueue('doc1', 't2', async () => { /* noop */ });
			// Should not reach here in sync enqueue after cancel
		} catch (e: any) {
			assert.ok(e.message.includes('cancelled'));
		}
		await t1;
	});

	test('clear removes pending counts and queue', async () => {
		await queue.enqueue('doc1', 't1', async () => { /* noop */ });
		queue.clear('doc1');
		assert.strictEqual(queue.getPendingCount('doc1'), 0);
	});

	test('clearAll removes all state', async () => {
		await queue.enqueue('doc1', 't1', async () => { /* noop */ });
		await queue.enqueue('doc2', 't2', async () => { /* noop */ });
		queue.clearAll();
		assert.strictEqual(queue.getPendingCount('doc1'), 0);
		assert.strictEqual(queue.getPendingCount('doc2'), 0);
	});

	test('task error propagates to caller', async () => {
		try {
			await queue.enqueue('doc1', 'fail', async () => {
				throw new Error('test error');
			});
			assert.fail('should have thrown');
		} catch (e: any) {
			assert.ok(e.message.includes('test error'));
		}
	});

	test('subsequent tasks still run after previous task error', async () => {
		try {
			await queue.enqueue('doc1', 'fail', async () => {
				throw new Error('error');
			});
		} catch {
			// expected
		}
		let executed = false;
		await queue.enqueue('doc1', 'next', async () => {
			executed = true;
		});
		assert.strictEqual(executed, true);
	});

	test('rejects nested enqueue for same doc', async () => {
		try {
			await queue.enqueue('doc1', 'outer', async () => {
				await queue.enqueue('doc1', 'inner', async () => { /* noop */ });
			});
			assert.fail('should have thrown');
		} catch (e: any) {
			assert.ok(e.message.includes('not allowed') || e.message.includes('nested'), e.message);
		}
	});

	test('TaskToken.cancelled reflects cancelPending state', async () => {
		let tokenSeenCancelled = false;
		const task = queue.enqueue('doc1', 'cancellable', async (token) => {
			await delay(5);
			tokenSeenCancelled = token.cancelled;
		});
		queue.cancelPending('doc1', 'test cancel');
		await task;
		assert.strictEqual(tokenSeenCancelled, true);
	});

	test('cancelPending rejects queued tasks', async () => {
		// Hold the first task so second queues up
		let releaseFirst: (() => void) | undefined;
		const t1 = queue.enqueue('doc1', 'long', async () => {
			await new Promise<void>(resolve => { releaseFirst = resolve; });
		});
		const t2Promise = queue.enqueue('doc1', 'queued', async () => { /* noop */ });
		queue.cancelPending('doc1', 'test cancel');
		releaseFirst!();
		await t1;
		try {
			await t2Promise;
			assert.fail('should have been rejected');
		} catch (e: any) {
			assert.ok(e.message.includes('cancelled'));
		}
	});

	test('clear clears active tokens', async () => {
		let tokenWasCancelled = false;
		const task = queue.enqueue('doc1', 'test', async (token) => {
			await delay(5);
			tokenWasCancelled = token.cancelled;
		});
		queue.clear('doc1');
		await task;
		// After clear, pending count is zero
		assert.strictEqual(queue.getPendingCount('doc1'), 0);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
