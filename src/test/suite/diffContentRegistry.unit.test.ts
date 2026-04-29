import * as assert from 'assert';
import { createDiffContentRegistry } from '../../ui/diffContentRegistry';

suite('DiffContentRegistry', () => {
	test('register returns a non-empty string id', () => {
		const registry = createDiffContentRegistry();
		const id = registry.register('abc', 'def');
		assert.ok(typeof id === 'string');
		assert.ok(id.length > 0);
	});

	test('get returns the record for a registered id', () => {
		const registry = createDiffContentRegistry();
		const id = registry.register('original content', 'modified content', 'test.txt');
		const record = registry.get(id);
		assert.ok(record);
		assert.strictEqual(record!.original, 'original content');
		assert.strictEqual(record!.modified, 'modified content');
		assert.strictEqual(record!.title, 'test.txt');
	});

	test('get returns undefined for non-existent id', () => {
		const registry = createDiffContentRegistry();
		assert.strictEqual(registry.get('nonexistent'), undefined);
	});

	test('delete removes a record', () => {
		const registry = createDiffContentRegistry();
		const id = registry.register('a', 'b');
		assert.strictEqual(registry.size, 1);
		registry.delete(id);
		assert.strictEqual(registry.size, 0);
		assert.strictEqual(registry.get(id), undefined);
	});

	test('clear removes all records', () => {
		const registry = createDiffContentRegistry();
		registry.register('a', 'b');
		registry.register('c', 'd');
		assert.strictEqual(registry.size, 2);
		registry.clear();
		assert.strictEqual(registry.size, 0);
	});

	test('size tracks number of records', () => {
		const registry = createDiffContentRegistry();
		assert.strictEqual(registry.size, 0);
		registry.register('a', 'b');
		assert.strictEqual(registry.size, 1);
		registry.register('c', 'd');
		assert.strictEqual(registry.size, 2);
	});

	test('each register call returns a unique id', () => {
		const registry = createDiffContentRegistry();
		const id1 = registry.register('a', 'b');
		const id2 = registry.register('c', 'd');
		assert.notStrictEqual(id1, id2);
	});

	test('evicts oldest entries when exceeding max size', () => {
		const registry = createDiffContentRegistry(3);
		const id1 = registry.register('a1', 'b1');
		const id2 = registry.register('a2', 'b2');
		const id3 = registry.register('a3', 'b3');
		const id4 = registry.register('a4', 'b4');

		assert.strictEqual(registry.size, 3);
		assert.strictEqual(registry.get(id1), undefined);
		assert.ok(registry.get(id2));
		assert.ok(registry.get(id3));
		assert.ok(registry.get(id4));
	});

	test('handles empty string content', () => {
		const registry = createDiffContentRegistry();
		const id = registry.register('', '');
		const record = registry.get(id);
		assert.ok(record);
		assert.strictEqual(record!.original, '');
		assert.strictEqual(record!.modified, '');
	});

	test('handles special characters in content', () => {
		const registry = createDiffContentRegistry();
		const content = 'function test() {\n\treturn "hello world";\n}';
		const id = registry.register(content, content + '\n// comment');
		const record = registry.get(id);
		assert.ok(record);
		assert.strictEqual(record!.original, content);
	});

	test('default title when not provided', () => {
		const registry = createDiffContentRegistry();
		const id = registry.register('a', 'b');
		const record = registry.get(id);
		assert.ok(record);
		assert.strictEqual(record!.title, 'Diff');
	});

	test('concurrent registrations maintain correct ordering for eviction', () => {
		const registry = createDiffContentRegistry(2);
		const id1 = registry.register('a', 'b');
		const id2 = registry.register('c', 'd');
		const id3 = registry.register('e', 'f');

		assert.strictEqual(registry.size, 2);
		assert.strictEqual(registry.get(id1), undefined);
		assert.ok(registry.get(id2));
		assert.ok(registry.get(id3));
	});

	test('delete reduces size correctly', () => {
		const registry = createDiffContentRegistry();
		const id1 = registry.register('a', 'b');
		registry.register('c', 'd');
		assert.strictEqual(registry.size, 2);
		registry.delete(id1);
		assert.strictEqual(registry.size, 1);
	});
});
