import * as assert from 'assert';
import { escapeHtml } from '../../utils/htmlEscape';

suite('HTML Escape', () => {
	test('escapes ampersand', () => {
		assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
	});

	test('escapes less-than', () => {
		assert.strictEqual(escapeHtml('a < b'), 'a &lt; b');
	});

	test('escapes greater-than', () => {
		assert.strictEqual(escapeHtml('a > b'), 'a &gt; b');
	});

	test('escapes double quote', () => {
		assert.strictEqual(escapeHtml('a " b'), 'a &quot; b');
	});

	test('escapes single quote', () => {
		assert.strictEqual(escapeHtml("a ' b"), 'a &#39; b');
	});

	test('escapes multiple special characters', () => {
		assert.strictEqual(escapeHtml('<script>alert("XSS")</script>'), '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
	});

	test('returns empty string unchanged', () => {
		assert.strictEqual(escapeHtml(''), '');
	});

	test('returns plain text unchanged', () => {
		assert.strictEqual(escapeHtml('hello world'), 'hello world');
	});

	test('handles filenames with special chars', () => {
		assert.strictEqual(escapeHtml('"><script>alert(1)</script>'), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	test('handles unicode text', () => {
		assert.strictEqual(escapeHtml('你好 < 世界'), '你好 &lt; 世界');
	});
});
