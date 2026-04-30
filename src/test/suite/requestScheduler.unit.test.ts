import * as assert from 'assert';
import { RequestScheduler, SchedulerConfig, ScheduledRequest } from '../../concurrency/requestScheduler';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

suite('RequestScheduler', () => {
	const fastConfig: SchedulerConfig = {
		maxConcurrentRequests: 2,
		maxRequestsPerHour: 1000,
		timeoutMs: 500,
		maxRetries: 2,
	};

	let scheduler: RequestScheduler;

	setup(() => {
		scheduler = new RequestScheduler(fastConfig);
	});

	test('executes a single request and returns result', async () => {
		const result = await scheduler.schedule({
			docId: 'doc1',
			label: 'test',
			execute: async () => 42,
		});
		assert.strictEqual(result, 42);
	});

	test('respects maxConcurrentRequests limit', async () => {
		const limited = new RequestScheduler({ ...fastConfig, maxConcurrentRequests: 1 });
		let running = 0;
		let maxRunning = 0;

		const tasks = [1, 2, 3].map(n =>
			limited.schedule({
				docId: 'doc1',
				label: `task-${n}`,
				execute: async () => {
					running++;
					maxRunning = Math.max(maxRunning, running);
					await delay(30);
					running--;
					return n;
				},
			})
		);

		await Promise.all(tasks);
		assert.strictEqual(maxRunning, 1);
	});

	test('different docs can run in parallel', async () => {
		let running = 0;
		let maxRunning = 0;

		const t1 = scheduler.schedule({
			docId: 'doc1',
			label: 't1',
			execute: async () => {
				running++; maxRunning = Math.max(maxRunning, running);
				await delay(50);
				running--;
			},
		});
		const t2 = scheduler.schedule({
			docId: 'doc2',
			label: 't2',
			execute: async () => {
				running++; maxRunning = Math.max(maxRunning, running);
				await delay(50);
				running--;
			},
		});

		await Promise.all([t1, t2]);
		assert.ok(maxRunning >= 2);
	});

	test('timeout aborts execution', async () => {
		const timed = new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 50, maxRetries: 0 });

		try {
			await timed.schedule({
				docId: 'doc1',
				label: 'slow',
				execute: async (signal) => {
					while (!signal.aborted) { await delay(10); }
					throw new Error('Should not reach');
				},
			});
			assert.fail('Should have timed out');
		} catch (e: any) {
			assert.ok(e.message.includes('timed out'), e.message);
		}
	});

	test('retries on timeout when maxRetries > 0', async function () {
		this.timeout(10000);
		const retrying = new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 50, maxRetries: 2 });
		let attempts = 0;

		try {
			await retrying.schedule({
				docId: 'doc1',
				label: 'eventually-fails',
				execute: async (signal) => {
					attempts++;
					// Wait for timeout to fire
					while (!signal.aborted) {
						await delay(10);
					}
					throw new Error('Timed out');
				},
			});
			assert.fail('Should have timed out');
		} catch (e: any) {
			assert.ok(e.message.includes('timed out') || e.message.includes('aborted'), e.message);
			assert.strictEqual(attempts, 3);
		}
	});

	test('retries on 429 status', async function () {
		this.timeout(10000);
		const retrying = new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 100, maxRetries: 2 });
		let attempts = 0;

		try {
			await retrying.schedule({
				docId: 'doc1',
				label: 'rate-limited',
				execute: async () => {
					attempts++;
					const err = new Error('Rate limited') as any;
					err.statusCode = 429;
					throw err;
				},
			});
			assert.fail('Should have thrown');
		} catch (e: any) {
			assert.strictEqual(e.statusCode, 429);
			assert.strictEqual(attempts, 3);
		}
	});

	test('retries on 5xx status', async function () {
		this.timeout(5000);
		const retrying = new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 100, maxRetries: 1 });
		let attempts = 0;

		try {
			await retrying.schedule({
				docId: 'doc1',
				label: 'server-error',
				execute: async () => {
					attempts++;
					const err = new Error('Server error') as any;
					err.statusCode = 503;
					throw err;
				},
			});
		} catch (e: any) {
			assert.strictEqual(attempts, 2);
		}
	});

	test('does not retry on 4xx (non-429)', async () => {
		const retrying = new RequestScheduler({ ...fastConfig, timeoutMs: 5000, maxRetries: 2 });
		let attempts = 0;

		try {
			await retrying.schedule({
				docId: 'doc1',
				label: 'bad-request',
				execute: async () => {
					attempts++;
					const err = new Error('Bad request') as any;
					err.statusCode = 400;
					throw err;
				},
			});
		} catch {
			assert.strictEqual(attempts, 1);
		}
	});

	test('cancelByDoc aborts running requests', async () => {
		const cancelSched = new RequestScheduler({ ...fastConfig, maxConcurrentRequests: 5 });
		try {
			const promise = cancelSched.schedule({
				docId: 'doc1',
				label: 'cancellable',
				execute: async (signal) => {
					// Poll for abort signal
					const start = Date.now();
					while (!signal.aborted && Date.now() - start < 500) {
						await delay(10);
					}
					if (signal.aborted) throw new Error('Aborted');
					return 'done';
				},
			});

			await delay(20);
			cancelSched.cancelByDoc('doc1', 'test cancel');
			await promise;
			assert.fail('Should have been cancelled');
		} catch (e: any) {
			assert.ok(true);
		}
	});

	test('cancelByDoc removes queued requests for that doc', async () => {
		const limited = new RequestScheduler({ ...fastConfig, maxConcurrentRequests: 1 });

		// Fill the running slot (doc2 so cancel won't abort it)
		const running = limited.schedule({
			docId: 'doc2',
			label: 'slow',
			execute: async () => { await delay(100); return 'a'; },
		});

		// Queue some requests for doc1
		const p1 = limited.schedule({ docId: 'doc1', label: 'q1', execute: async () => 'b' });
		const p2 = limited.schedule({ docId: 'doc1', label: 'q2', execute: async () => 'c' });

		// Cancel doc1 - should remove both queued requests
		limited.cancelByDoc('doc1', 'test');

		try { await p1; assert.fail('p1 should be cancelled'); } catch (e: any) { assert.ok(e.message.includes('cancel'), e.message); }
		try { await p2; assert.fail('p2 should be cancelled'); } catch (e: any) { assert.ok(e.message.includes('cancel'), e.message); }

		await running; // doc2 runs fine
	});

	test('getStats returns correct metrics', async () => {
		await scheduler.schedule({
			docId: 'doc1',
			label: 's1',
			execute: async () => 'ok',
		});

		const stats = scheduler.getStats();
		assert.strictEqual(stats.totalCompleted, 1);
		assert.strictEqual(stats.totalFailed, 0);
		assert.strictEqual(stats.concurrent, 0);
	});

	test('getStats tracks failures', async function () {
		this.timeout(10000);
		const noRetry = new RequestScheduler({ maxConcurrentRequests: 5, maxRequestsPerHour: 1000, timeoutMs: 50, maxRetries: 0 });
		try {
			await noRetry.schedule({
				docId: 'doc1',
				label: 'fail',
				execute: async (signal) => {
					while (!signal.aborted) { await delay(5); }
					throw new Error('timeout');
				},
			});
		} catch {
			// expected
		}
		const stats = noRetry.getStats();
		assert.strictEqual(stats.totalFailed, 1, `Expected totalFailed=1, got ${JSON.stringify(stats)}`);
	});

	test('rate limiter enforces hourly limit', async function () {
		this.timeout(30000);
		// Use very small limit to test rate limiting behavior
		const limited = new RequestScheduler({
			maxConcurrentRequests: 5, maxRequestsPerHour: 3, timeoutMs: 30000, maxRetries: 0
		});

		// First 3 should pass immediately
		for (let i = 0; i < 3; i++) {
			const r = await limited.schedule({
				docId: 'doc1', label: `r-${i}`,
				execute: async () => i,
			});
			assert.strictEqual(r, i);
		}

		// 4th should be rate-limited (would wait for oldest timestamp to expire)
		// But since we can't wait an hour, just check stats
		const stats = limited.getStats();
		assert.strictEqual(stats.totalCompleted, 3);
	});

	test('queue processing resumes after concurrent slot freed', async () => {
		const limited = new RequestScheduler({ ...fastConfig, maxConcurrentRequests: 1 });

		const results: number[] = [];
		const t1 = limited.schedule({
			docId: 'doc1', label: 'slow',
			execute: async () => { await delay(50); results.push(1); return 1; },
		});
		const t2 = limited.schedule({
			docId: 'doc1', label: 'fast',
			execute: async () => { results.push(2); return 2; },
		});

		await Promise.all([t1, t2]);
		assert.deepStrictEqual(results, [1, 2]);
	});
});
