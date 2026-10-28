import assert from 'node:assert/strict';
import test from 'node:test';
import { captureState, personTransition, protectionRules } from '../src/game/scenarios/protection.ts';
import { defineScenario, protect } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';

const rules = protectionRules( { friendly: [ 'escort' ], hostile: [ 'pursuers' ] } );
const subject = { id: 'subject' };
const carrier = { id: 'carrier' };
const available = new Set( [ 'escort', 'pursuers' ] );
const person = ( id, actor, position = [ 0, 0 ], status = 'active' ) => ( { handle: { id }, actor: { id: actor }, position, status } );

test( 'capture pressure accumulates sampled seconds and excludes subject/carrier from support', () => {

	const entity = { state: 'active', subject, carrier, position: [ 0, 0 ], capture: null };
	const people = [ person( 'hostile-1', 'pursuers' ), person( 'hostile-2', 'pursuers' ),
		{ ...person( 'subject', 'escort' ), handle: subject }, { ...person( 'carrier', 'escort' ), handle: carrier } ];
	entity.capture = captureState( entity, rules, people, available, 1.5 );
	assert.equal( entity.capture.held, 1.5 ); assert.equal( entity.capture.friendly, 0 );
	entity.capture = captureState( entity, rules, people, available, 0 );
	assert.equal( entity.capture.held, 1.5 );
	entity.capture = captureState( entity, rules, people, available, 3 );
	assert.equal( entity.capture.held, 4 ); assert.equal( entity.capture.required, 4 );

} );

test( 'standing capture pressure decays while downed capture resets without enough hostiles', () => {

	const entity = { state: 'active', position: [ 0, 0 ], capture: { held: 3 } };
	assert.equal( captureState( entity, rules, [], available, 1 ).held, 2 );
	entity.state = 'down';
	assert.equal( captureState( entity, rules, [], available, 1 ).held, 0 );
	assert.equal( captureState( entity, rules, [], available, 1 ).required, 8 );

} );

test( 'protection capture rate scales with officer count and slows under shield wall', () => {

	const captureRules = protectionRules( { friendly: [ 'escort' ], hostile: [ 'pursuers' ],
		captureRate: { perHostile: 0.5, maximum: 2, shieldMultiplier: 0.5 } } );
	const entity = { state: 'active', position: [ 0, 0 ], capture: null };
	const twoOfficers = [ person( 'police-1', 'pursuers' ), person( 'police-2', 'pursuers' ) ];
	const fourOfficers = [ ...twoOfficers, person( 'police-3', 'pursuers' ), person( 'police-4', 'pursuers' ) ];
	assert.equal( captureState( entity, captureRules, twoOfficers, available, 1 ).held, 1 );
	assert.equal( captureState( entity, captureRules, fourOfficers, available, 1 ).held, 2 );
	assert.equal( captureState( entity, captureRules, fourOfficers, available, 1, true ).held, 1 );
	entity.state = 'down';
	assert.equal( captureState( entity, captureRules, fourOfficers, available, 1 ).held, 1 );

} );

test( 'unavailable actors freeze pressure rather than being treated as empty', () => {

	const entity = { state: 'down', position: [ 0, 0 ], capture: { held: 5 } };
	const result = captureState( entity, rules, [], new Set( [ 'escort' ] ), 10 );
	assert.equal( result.available, false ); assert.equal( result.held, 5 );
	assert.throws( () => captureState( entity, rules, [], available, - 1 ), /non-negative/ );

} );

test( 'injury downs a protected person while detention/death are terminal facts', () => {

	const entity = { state: 'active' };
	assert.deepEqual( personTransition( entity, { status: 'injured' }, { status: 'injured' } ), { state: 'down', reason: 'carrier injured' } );
	assert.equal( personTransition( entity, null, null ), null );
	assert.equal( personTransition( entity, { status: 'detained' }, { status: 'active' } ).state, 'captured' );
	assert.equal( personTransition( entity, { status: 'dead' }, { status: 'active' } ).state, 'dead' );
	assert.equal( personTransition( { state: 'captured' }, { status: 'active' }, { status: 'active' } ), null );

} );

test( 'protection configuration is detached and rejects overlap, holes and non-finite timings', () => {

	const friendly = [ 'escort' ];
	const result = protectionRules( { friendly, hostile: [ 'pursuers' ] } );
	friendly.push( 'changed' ); assert.deepEqual( result.friendly, [ 'escort' ] );
	assert.throws( () => protectionRules( { friendly: [ 'same' ], hostile: [ 'same' ] } ), /overlap/ );
	assert.throws( () => protectionRules( { friendly: new Array( 1 ), hostile: [ 'pursuers' ] } ), /dense/ );
	assert.throws( () => protectionRules( { friendly: [ 'escort' ], hostile: [ 'pursuers' ], seconds: Infinity } ), /finite/ );

} );

test( 'protection objective loses on capture before its duration and freezes result state', async () => {

	const definition = defineScenario( { id: 'protect-proof', title: 'Proof', subtitle: 'Capture', brief: 'Proof.', locations: { start: [ 0, 0 ] },
		setup( ctx ) {

			ctx.spawn.squad( { id: 'escort', at: 'start', people: 1 } ); ctx.spawn.crowd( { id: 'pursuers', at: 'start', people: 2 } );
			ctx.protected.create( { id: 'subject', kind: 'person', carrier: 'escort', protection: { friendly: [ 'escort' ], hostile: [ 'pursuers' ] } } );

		}, objectives: [ protect( { id: 'save', protected: 'subject', seconds: 60 } ) ] } );
	const results = [];
	const runtime = new ScenarioRuntime( definition, {
		spawn: async ( kind, options ) => options,
		readActor: ( backend ) => ( { alive: backend.people, center: [ 0, 0 ] } ),
		readPeople: ( backend ) => Array.from( { length: backend.people }, ( _, index ) => ( {
			key: `${backend.id}-${index}`, backend: {}, leader: index === 0, status: 'active', position: [ 0, 0 ],
		} ) ), release() {}, stopMove() {},
	}, { onFinish: ( result ) => results.push( result ) } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	runtime.update( 2 ); runtime.observe( {} ); runtime.pause( true );
	runtime.observe( {} ); assert.equal( runtime.identity.snapshots[ 0 ].capture.held, 2 );
	runtime.pause( false ); runtime.update( 2 ); runtime.observe( {} ); runtime.update( 1 / 60 );
	assert.equal( runtime.state, 'finished' ); assert.equal( results.length, 1 );
	assert.equal( runtime.result.win, false ); assert.equal( runtime.result.stars, 0 );
	assert.match( runtime.result.reason, /captured/ ); assert.ok( runtime.time < 5 );
	runtime.update( 100 ); assert.equal( results.length, 1 ); runtime.dispose();

} );

test( 'protection cannot award victory from incomplete observations at its deadline', async () => {

	const definition = defineScenario( { id: 'unknown-proof', title: 'Proof', subtitle: 'Unavailable', brief: 'Proof.', locations: { start: [ 0, 0 ] },
		setup( ctx ) {

			ctx.spawn.squad( { id: 'escort', at: 'start', people: 1 } ); ctx.spawn.crowd( { id: 'pursuers', at: 'start', people: 2 } );
			ctx.protected.create( { id: 'subject', kind: 'person', carrier: 'escort', protection: { friendly: [ 'escort' ], hostile: [ 'pursuers' ] } } );

		}, objectives: [ protect( { id: 'save', protected: 'subject', seconds: 1 } ) ] } );
	const runtime = new ScenarioRuntime( definition, {
		spawn: async ( kind, options ) => options, readActor: () => ( { alive: 1, center: [ 0, 0 ] } ),
		readPeople: ( backend ) => backend.id === 'pursuers' ? null : [ { key: 'subject', backend: {}, leader: true, status: 'active', position: [ 0, 0 ] } ], release() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' ); assert.equal( runtime.result, null );
	assert.match( runtime.error.message, /observation unavailable/ ); runtime.dispose();

} );