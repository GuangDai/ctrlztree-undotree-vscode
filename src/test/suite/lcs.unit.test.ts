import * as assert from 'assert';
import { applyDiff, deserializeDiff, generateDiff, serializeDiff } from '../../lcs';

suite('LCS Diff Schema', () => {
	test('round-trips generated add/remove/keep operations', () => {
		const original = 'abc';
		const next = 'aXYc';
		const operations = generateDiff(original, next);
		const serialized = serializeDiff(operations);
		const deserialized = deserializeDiff(serialized);

		assert.deepStrictEqual(deserialized, operations);
		assert.strictEqual(applyDiff(original, deserialized), next);
	});

	test('rejects non-JSON input', () => {
		assert.throws(
			() => deserializeDiff('not-json'),
			/Failed to deserialize diff: Unexpected token/
		);
	});

	test('rejects JSON values that are not arrays', () => {
		assert.throws(
			() => deserializeDiff('{"type":"keep","position":0,"length":1}'),
			/Deserialized diff is not an array/
		);
	});

	test('rejects non-object operations', () => {
		assert.throws(
			() => deserializeDiff('[null]'),
			/Diff operation at index 0 is not an object/
		);
	});

	test('rejects operations with invalid type', () => {
		assert.throws(
			() => deserializeDiff('[{"type":"copy","position":0,"length":1}]'),
			/Diff operation at index 0 has invalid type/
		);
	});

	test('rejects operations with invalid position', () => {
		assert.throws(
			() => deserializeDiff('[{"type":"keep","position":"0","length":1}]'),
			/Diff operation at index 0 has invalid position/
		);
	});

	test('rejects add operations without string content', () => {
		assert.throws(
			() => deserializeDiff('[{"type":"add","position":0,"content":42}]'),
			/Diff add operation at index 0 requires string content/
		);
	});

	test('rejects add operations with length', () => {
		assert.throws(
			() => deserializeDiff('[{"type":"add","position":0,"content":"x","length":1}]'),
			/Diff add operation at index 0 must not include length/
		);
	});

	test('rejects keep operations without valid length', () => {
		assert.throws(
			() => deserializeDiff('[{"type":"keep","position":0}]'),
			/Diff keep operation at index 0 requires valid length/
		);
	});

	test('rejects remove operations with content', () => {
		assert.throws(
			() => deserializeDiff('[{"type":"remove","position":0,"length":1,"content":"x"}]'),
			/Diff remove operation at index 0 must not include content/
		);
	});
});
