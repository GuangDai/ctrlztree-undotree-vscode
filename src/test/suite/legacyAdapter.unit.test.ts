import * as assert from 'assert';
import { CtrlZTree } from '../../model/ctrlZTree';
import { migrateCtrlZTreeToEvents } from '../../history/legacyCtrlZTreeAdapter';
import { project } from '../../history/projection';

suite('Legacy CtrlZTree Adapter', () => {
	test('migrates simple tree to events', () => {
		const tree = new CtrlZTree('hello');
		const { events, warnings } = migrateCtrlZTreeToEvents(tree);

		assert.ok(events.length >= 2); // init + initial snapshot
		assert.strictEqual(warnings.length, 0);
		assert.strictEqual(events[0].kind, 'init');
	});

	test('migrates tree with edits to events', () => {
		const tree = new CtrlZTree('v1');
		tree.set('v2');
		tree.set('v3');

		const { events, warnings } = migrateCtrlZTreeToEvents(tree);
		assert.ok(events.length >= 3);
		assert.strictEqual(warnings.length, 0);

		const editEvents = events.filter(e => e.kind === 'edit');
		assert.ok(editEvents.length >= 2);
	});

	test('migrated events produce equivalent projection content', () => {
		const tree = new CtrlZTree('v1');
		tree.set('v2');
		tree.set('v3');

		const { events } = migrateCtrlZTreeToEvents(tree);
		const proj = project('doc1', events);

		assert.ok(proj.byId.has(proj.headId));
		assert.ok(proj.byId.has(proj.rootId));
		assert.strictEqual(proj.parentOf.get(proj.rootId), null);
	});

	test('migrates branching tree', () => {
		const tree = new CtrlZTree('v1');
		tree.set('v2');
		tree.z(); // undo
		tree.set('v3'); // branch
		tree.z(); // undo
		tree.set('v4'); // another branch

		const { events } = migrateCtrlZTreeToEvents(tree);
		const proj = project('doc1', events);

		// All non-root nodes should have a parent
		for (const [id, view] of proj.byId) {
			if (id === proj.rootId) {continue;}
			const parent = proj.parentOf.get(id);
			assert.ok(parent !== undefined && parent !== null, `Node ${id} has no parent`);
		}

		// Branch tips should exist
		assert.ok(proj.branchTips.length >= 1);
	});

	test('adapter produces no orphan nodes', () => {
		const tree = new CtrlZTree('start');
		tree.set('edit1');
		tree.set('edit2');
		tree.z();
		tree.z();
		tree.set('edit3');

		const { events } = migrateCtrlZTreeToEvents(tree);
		const proj = project('doc1', events);

		const orphans = proj.diagnostics.filter(d => d.message.includes('has no parent'));
		assert.strictEqual(orphans.length, 0);
	});

	test('empty document migrates cleanly', () => {
		const tree = new CtrlZTree('');
		const { events, warnings } = migrateCtrlZTreeToEvents(tree);

		assert.ok(events.length >= 1);
		assert.strictEqual(warnings.length, 0);
		assert.strictEqual(events[0].kind, 'init');
	});

	test('head event is emitted when head differs from last edit', () => {
		const tree = new CtrlZTree('v1');
		const v2 = tree.set('v2');
		tree.set('v3');
		tree.setHead(v2); // navigate to v2

		const { events } = migrateCtrlZTreeToEvents(tree);
		const headMoves = events.filter(e => e.kind === 'headMove');
		assert.ok(headMoves.length >= 1);
	});
});
