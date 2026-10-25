import assert from 'node:assert/strict';
import test from 'node:test';
import { EffectHost } from '../src/game/scenarios/effects.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';

test( 'person effects reject stale, duplicate and transported requests and confirm only later sampled facts', () => {

	const handle = Object.freeze( { id: 'person-1', kind: 'person', run: 1 } ), events = [], queued = [];
	const record: any = { sample: { status: 'active' }, backend: {} };
	const runtime = { step: 10, observation: { sequence: 2 }, writable() {}, event: ( ...args ) => events.push( args ),
		identity: { personRecord: () => record, getPerson: () => record.sample }, adapter: { applyPersonEffect: ( ...args ) => { queued.push( args ); return { status: 'queued' }; } } };
	const effects = new EffectHost( runtime );
	assert.equal( ( effects.apply( handle, { status: 'injured', expectedSample: 1 } ) as any ).code, 'STALE_OBSERVATION' );
	record.transport = {}; assert.equal( ( effects.apply( handle, { status: 'injured', expectedSample: 2 } ) as any ).code, 'CONTROL_BUSY' ); record.transport = null;
	const accepted: any = effects.apply( handle, { status: 'injured', source: 'other', expectedSample: 2 } );
	assert.equal( accepted.status, 'queued' ); assert.ok( Object.isFrozen( accepted.value ) );
	assert.equal( ( effects.apply( handle, { status: 'dead', expectedSample: 2 } ) as any ).code, 'EFFECT_PENDING' );
	effects.observe( { step: 10 } ); assert.equal( events.length, 1 );
	record.sample = { status: 'injured' }; effects.observe( { step: 11 } );
	assert.equal( events.at( - 1 )[ 0 ], 'effect.confirmed' ); assert.equal( effects.pending.size, 0 ); assert.equal( queued.length, 1 );
	runtime.step = 11; effects.apply( handle, { status: 'dead', expectedSample: 2 } ); record.sample = { status: 'detained' }; effects.observe( { step: 12 } );
	assert.equal( events.at( - 1 )[ 0 ], 'effect.rejected' );
	assert.equal( ( effects.apply( handle, { status: 'injured', expectedSample: 2 } ) as any ).code, 'PERSON_UNAVAILABLE' );

} );

test( 'person effect adapter queues conditional faction edits without reviving terminal people', () => {

	const edits = [], group = { id: 4, members: [ 9 ] }; let faction = 1;
	const adapter = new ScenarioEngine( { world: { intel: { faction: () => faction, group: () => 4 } },
		crowd: { pendingEdits: [], compareFaction: ( ...args ) => edits.push( args ) } } );
	assert.deepEqual( adapter.applyPersonEffect( { member: 9, group }, 'injured', 'other' ), { status: 'queued' } );
	assert.deepEqual( edits, [ [ 9, 1, 21, 4 ] ] );
	faction = 31; assert.equal( adapter.applyPersonEffect( { member: 9, group }, 'injured', 'other' ).status, 'rejected' ); assert.equal( edits.length, 1 );
	faction = - 2; assert.equal( adapter.applyPersonEffect( { member: 9, group }, 'dead', 'other' ).status, 'rejected' );

} );
