import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityHost } from '../src/game/scenarios/identity.ts';
import { defineScenario, defineBehavior, survive } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';
import { followRoute } from '../src/game/scenarios/route.ts';

function fixture( options = {} ) {

	const first = Object.freeze( { id: 'escort', kind: 'squad', run: 1 } );
	const second = Object.freeze( { id: 'relief', kind: 'squad', run: 1 } );
	const events = [], promoted = [];
	const members = new Map<any, any[]>( [ [ first, [ { key: 1, backend: { person: 1 }, leader: true, status: 'active', position: [ 0, 0 ] } ] ],
		[ second, [ { key: 2, backend: { person: 2 }, leader: true, status: 'active', position: [ 5, 0 ] },
			{ key: 3, backend: { person: 3 }, leader: false, status: 'active', position: [ 6, 0 ] } ] ] ] );
	const actors = new Map<string, any>( [ [ first.id, { handle: first, backend: first } ], [ second.id, { handle: second, backend: second } ] ] );
	const runtime = { run: 1, actors, observation: { sequence: 1 }, writable() {}, actor( handle ) {

		assert.equal( actors.get( handle.id )?.handle, handle );

	}, context: { actors: { resolve: ( id ) => actors.get( id ).handle } },
	adapter: { readPeople: ( backend ) => members.get( backend ), promoteLeader: ( backend ) => promoted.push( backend ) },
	event: ( type, event ) => events.push( { type, ...event } ) };
	const pursuers = Object.freeze( { id: 'pursuers', kind: 'squad', run: 1 } );
	actors.set( 'pursuers', { handle: pursuers, backend: pursuers } ); members.set( pursuers, [] );
	const host = new IdentityHost( runtime );
	const banner = host.create( { id: 'banner', label: 'BANNER', carrier: 'escort', ...options } );
	host.collect( {} ); host.reconcile();
	return { host, banner, first, second, pursuers, members, runtime, events, promoted };

}

test( 'protected identity survives dropping and recovery by a person in another actor', () => {

	const { host, banner, second } = fixture();
	const before = host.get( banner );
	assert.equal( before.state, 'carried' );
	assert.equal( host.drop( banner, { expectedRevision: before.revision, expectedSample: 1 } ).status, 'completed' );
	const dropped = host.get( banner ), carrier = host.members( second )[ 1 ].handle;
	const transfer = host.transfer( banner, { carrier, expectedRevision: dropped.revision, expectedSample: 1, promote: true } );
	assert.equal( transfer.status, 'completed' );
	assert.equal( transfer.value.handle, banner );
	assert.equal( transfer.value.carrier, carrier );
	assert.equal( transfer.value.actor, second );
	assert.equal( host.members( second ).length, 2 );
	assert.equal( transfer.value.revision, before.revision + 2 );
	// @ts-expect-error -- frozen snapshots are readonly in the types too
	assert.throws( () => { transfer.value.position[ 0 ] = 99; }, TypeError );

} );

test( 'downed protected recovery rejoins the bearer to the original actor at the requested speed', () => {

	const { host, banner, first, second, members, runtime } = fixture( { kind: 'person', protection: {
		friendly: [ 'escort', 'relief' ], hostile: [ 'pursuers' ], recoveryMinimum: 1,
	} } );
	const before = host.get( banner ), carrier = host.members( second )[ 0].handle;
	members.get( first )[ 0 ].status = 'injured';
	runtime.observation = { sequence: 2 }; ( runtime as any ).step = 2;
	host.collect( {}, { step: 2 } ); host.reconcile( { elapsed: 1 } );
	const down = host.get( banner ); let transferTarget, configured;
	assert.equal( down.state, 'down' );
	( runtime.adapter as any ).transferPerson = ( backend, target ) => {

		transferTarget = target;
		const source = members.get( second ), index = source.findIndex( ( member ) => member.backend === backend ), [ moved ] = source.splice( index, 1 );
		for ( const member of members.get( first ) ) member.leader = false;
		members.get( first ).push( { ...moved, leader: true } );
		return { status: 'completed', backend: { ...backend, group: target } };

	};
	( runtime.adapter as any ).configureActor = ( backend, options ) => { configured = [ backend, options ]; };
	const generic = host.transferPerson( carrier, { to: first, expectedRevision: 0, expectedSample: 2 } );
	assert.equal( ( generic as any ).code, 'PROTECTED_TARGET' );
	const result = host.transfer( banner, { carrier, expectedRevision: down.revision, expectedSample: 2, joinGroup: { speed: 0.85 } } );
	assert.equal( result.status, 'completed', JSON.stringify( result ) );
	assert.equal( transferTarget, first ); assert.deepEqual( configured, [ first, { speed: 0.85 } ] );
	assert.equal( result.value.actor, first ); assert.equal( result.value.carrier, carrier );
	assert.equal( members.get( second ).length, 1 ); assert.equal( members.get( first ).length, 2 );

} );

test( 'stale requests and duplicate transfers do not promote or change relationships', () => {

	const { host, banner, second, runtime, promoted } = fixture();
	const carrier = host.members( second )[ 1 ].handle, before = host.get( banner );
	assert.equal( ( host.transfer( banner, { carrier, expectedRevision: before.revision - 1, expectedSample: 1, promote: true } ) as any ).code, 'STALE_REVISION' );
	runtime.observation = { sequence: 2 };
	assert.equal( ( host.transfer( banner, { carrier, expectedRevision: before.revision, expectedSample: 1, promote: true } ) as any ).code, 'STALE_OBSERVATION' );
	assert.equal( promoted.length, 0 );
	assert.equal( host.get( banner ).carrier, before.carrier );
	const options = { carrier, expectedRevision: before.revision, expectedSample: 2, promote: true };
	assert.equal( host.transfer( banner, options ).status, 'completed' );
	assert.equal( ( host.transfer( banner, options ) as any ).code, 'STALE_REVISION' );
	assert.equal( promoted.length, 1 );

} );

test( 'carrier injury drops the object once at its last sampled position', () => {

	const { host, banner, first, members } = fixture();
	members.get( first )[ 0 ].status = 'injured';
	members.get( first )[ 0 ].position = [ 12, 9 ];
	host.collect( {} );
	const events = host.reconcile(), revision = host.get( banner ).revision;
	assert.equal( events.length, 1 ); assert.equal( events[ 0 ].type, 'protected.dropped' );
	assert.deepEqual( host.get( banner ).position, [ 12, 9 ] );
	assert.equal( host.get( banner ).carrier, null );
	host.collect( {} ); assert.deepEqual( host.reconcile(), [] );
	assert.equal( host.get( banner ).revision, revision );

} );

test( 'people and entity handles cannot be forged or reused from another run', () => {

	const { host, banner, second } = fixture();
	const carrier = host.members( second )[ 0 ].handle;
	assert.throws( () => host.getPerson( { ...carrier } ), /foreign/ );
	assert.throws( () => host.get( { ...banner, run: 2 } ), /foreign/ );
	assert.throws( () => host.create( { id: 'banner', carrier: 'relief' } ), /already allocated/ );

} );

test( 'distant, unavailable and occupied carriers reject before promotion', () => {

	const { host, banner, second, members, promoted } = fixture();
	const carrier = host.members( second )[ 0 ].handle;
	members.get( second )[ 0 ].position = [ 500, 0 ]; host.collect( {} ); host.reconcile();
	const options = { carrier, expectedRevision: host.get( banner ).revision, expectedSample: 1, promote: true };
	assert.equal( ( host.transfer( banner, options ) as any ).code, 'OUT_OF_RANGE' );
	members.get( second )[ 0 ].status = 'injured'; host.collect( {} ); host.reconcile();
	assert.equal( ( host.transfer( banner, options ) as any ).code, 'CARRIER_UNAVAILABLE' );
	members.get( second )[ 0 ].position = [ 5, 0 ]; members.get( second )[ 0 ].status = 'active'; host.collect( {} ); host.reconcile();
	host.create( { id: 'other-banner', carrier: second } );
	assert.equal( ( host.transfer( banner, options ) as any ).code, 'CARRIER_BUSY' );
	assert.equal( promoted.length, 0 );

} );

test( 'actor cleanup detaches relationships and invalidates unavailable people', () => {

	const { host, banner, first, members } = fixture();
	const person = host.members( first )[ 0 ].handle;
	members.set( first, null ); host.collect( {} );
	assert.equal( host.getPerson( person ), null );
	host.releaseActor( first );
	assert.equal( host.get( banner ).state, 'dropped' );
	assert.equal( host.get( banner ).actor, null );
	assert.throws( () => host.getPerson( person ), /unknown/ );
	host.dispose(); assert.equal( host.entities.size, 0 ); assert.equal( host.people.size, 0 );

} );

test( 'carrier change keeps identity and remaining route but stops the old actor', async () => {

	const installed = [], stopped = [], promoted = [], samples = new Map<any, any>();
	let banner, context;
	const watcher = defineBehavior( { id: 'watcher', create: () => ( { start( ctx ) { context = ctx; } } ) } );
	const definition = defineScenario( { id: 'handoff', title: 'Handoff', subtitle: 'Proof', brief: 'Proof.', locations: { start: [ 0, 0 ] },
		setup( ctx ) {

			ctx.spawn.squad( { id: 'escort', at: 'start' } ); ctx.spawn.squad( { id: 'relief', at: 'start' } );
			banner = ctx.protected.create( { id: 'banner', carrier: 'escort' } );

		}, behaviors: [ followRoute( { id: 'route', protected: 'banner', waypoints: [ [ 20, 0 ], [ 30, 0 ] ] } ), watcher( { id: 'watcher' } ) ],
		objectives: [ survive( { id: 'hold', seconds: 60 } ) ] } );
	const runtime = new ScenarioRuntime( definition, {
		spawn: async ( kind, options ) => { const backend = { id: options.id }; samples.set( backend, { key: options.id, backend, leader: true, status: 'active', position: [ 0, 0 ] } ); return backend; },
		readActor: () => ( { alive: 1, center: [ 0, 0 ] } ), readPeople: ( backend ) => [ samples.get( backend ) ],
		prepareMove: async () => ( {} ), applyMove: ( backend ) => installed.push( backend.id ), releaseMove() {},
		stopMove: ( backend ) => stopped.push( backend.id ), release() {}, promoteLeader: ( backend ) => promoted.push( backend.id ),
	} );
	await runtime.setup(); runtime.observe( {} ); const initial = runtime.observation;
	await runtime.start();
	const firstCarrier = context.protected.get( banner ).carrier;
	const nextCarrier = context.people.members( 'relief' )[ 0 ].handle;
	context.protected.drop( banner, { expectedRevision: 1, expectedSample: initial.sequence } );
	assert.deepEqual( stopped, [ 'escort' ] );
	context.protected.transfer( banner, { carrier: nextCarrier, expectedRevision: 2, expectedSample: initial.sequence, promote: true } );
	await runtime.movement.orders.get( 'relief' ).operation.settled;
	assert.deepEqual( installed, [ 'escort', 'relief' ] );
	assert.deepEqual( promoted, [ 'relief' ] );
	assert.equal( context.protected.get( banner ).handle, banner );
	assert.equal( context.protected.get( banner ).revision, 3 );
	assert.equal( initial.protected[ 0 ].carrier, firstCarrier );
	assert.equal( initial.protected[ 0 ].revision, 1 );
	context.complete();
	assert.throws( () => context.protected.drop( banner, { expectedRevision: 3, expectedSample: 1 } ), /cannot mutate/ );
	runtime.dispose(); assert.equal( runtime.identity.entities.size, 0 );

} );

test( 'removing an owned object emits removal and invalidates only its identity', () => {

	const { host, second, events } = fixture();
	const owner = {};
	const temporary = host.create( { id: 'temporary', carrier: second }, owner );
	host.collect( {} ); host.reconcile();
	host.stopOwner( owner );
	assert.throws( () => host.get( temporary ), /unknown/ );
	assert.equal( host.entities.size, 1 ); assert.equal( host.members( second ).length, 2 );
	assert.equal( events.at( - 1 ).type, 'protected.removed' );

} );

test( 'a protected route waits for an active observed carrier before moving', async () => {

	let status = 'injured', moves = 0;
	const definition = defineScenario( { id: 'waiting', title: 'Waiting', subtitle: 'Readiness', brief: 'Readiness.', locations: { start: [ 0, 0 ] },
		setup( ctx ) { ctx.spawn.squad( { id: 'escort', at: 'start' } ); ctx.protected.create( { id: 'banner', carrier: 'escort' } ); },
		behaviors: [ followRoute( { id: 'route', protected: 'banner', waypoints: [ [ 10, 0 ] ] } ) ],
		objectives: [ survive( { id: 'hold', seconds: 60 } ) ] } );
	const runtime = new ScenarioRuntime( definition, {
		spawn: async () => ( {} ), readActor: () => ( { alive: status === 'active' ? 1 : 0, center: [ 0, 0 ] } ),
		readPeople: () => [ { key: 0, backend: 0, leader: true, status, position: [ 0, 0 ] } ],
		prepareMove: async () => ( {} ), applyMove: () => { moves ++; }, releaseMove() {}, stopMove() {}, release() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.equal( runtime.identity.snapshots[ 0 ].state, 'pending' ); assert.equal( moves, 0 );
	status = 'active'; runtime.update( 1 ); runtime.observe( {} );
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	assert.equal( moves, 1 ); assert.equal( runtime.identity.snapshots[ 0 ].state, 'carried' );
	runtime.dispose();

} );

test( 'person transfer keeps stable identity and protected attachment until readback confirms membership', () => {

	const { host, runtime, first, second, members, banner } = fixture();
	const original = host.members( first )[ 0 ], handle = original.handle;
	( runtime as any ).step = 4; ( runtime as any ).lastSample = {};
	let commits = 0;
	( runtime.adapter as any ).transferPerson = ( backend, target ) => {

		commits ++;
		const person = members.get( first )[ 0 ];
		members.set( first, [] ); members.get( target ).push( person );
		return { status: 'completed', backend };

	};
	const options = { to: second, expectedRevision: 0, expectedSample: 1, promote: true };
	const result = host.transferPerson( handle, options );
	assert.equal( result.status, 'completed' ); assert.equal( result.value.handle, handle );
	assert.equal( result.value.actor, second ); assert.equal( result.value.revision, 1 );
	assert.notEqual( result.value.pending, null );
	assert.equal( host.getPerson( handle ), original ); assert.equal( original.actor, first );
	assert.equal( host.get( banner ).carrier, handle ); assert.equal( host.get( banner ).actor, second );
	assert.equal( ( host.transferPerson( handle, options ) as any ).code, 'STALE_REVISION' );
	assert.equal( ( host.transferPerson( handle, { ...options, expectedRevision: 1, to: first } ) as any ).code, 'MEMBERSHIP_PENDING' );
	assert.equal( commits, 1 );
	host.collect( {}, { step: 4 } ); assert.equal( host.getPerson( handle ), null );
	assert.notEqual( host.personState( handle ).pending, null );
	host.collect( {}, { step: 5 } ); host.reconcile();
	assert.equal( host.personState( handle ).pending, null ); assert.equal( host.getPerson( handle ).actor, second );
	assert.equal( host.getPerson( handle ).handle, handle );
	assert.equal( host.members( first ).length, 0 ); assert.equal( host.members( second ).length, 3 );

} );

test( 'membership transfer validates all preconditions before invoking the adapter', () => {

	const { host, runtime, first, second, banner } = fixture();
	const person = host.members( first )[ 0 ].handle;
	let calls = 0;
	( runtime.adapter as any ).transferPerson = () => { calls ++; return { status: 'rejected', code: 'INCOMPATIBLE_FACTION' }; };
	const options = { to: second, expectedRevision: 0, expectedSample: 1 };
	assert.equal( ( host.transferPerson( person, { ...options, expectedRevision: 1 } ) as any ).code, 'STALE_REVISION' );
	assert.equal( ( host.transferPerson( person, { ...options, expectedSample: 2 } ) as any ).code, 'STALE_OBSERVATION' );
	assert.equal( calls, 0 );
	assert.equal( ( host.transferPerson( person, options ) as any ).code, 'INCOMPATIBLE_FACTION' );
	assert.equal( host.personState( person ).actor, first ); assert.equal( host.personState( person ).revision, 0 );
	assert.equal( host.get( banner ).actor, first );
	assert.equal( ( host.transferPerson( person, { ...options, to: first } ) as any ).code, 'ALREADY_MEMBER' );
	assert.equal( calls, 1 );

} );

test( 'a stale GPU membership does not confirm a pending transfer even on a later sample', () => {

	const { host, runtime, first, second, members } = fixture();
	const handle = host.members( first )[ 0 ].handle;
	( runtime as any ).step = 1;
	( runtime.adapter as any ).transferPerson = ( backend, target ) => {

		const person: any = members.get( first )[ 0 ]; person.membershipMatches = false;
		members.set( first, [] ); members.get( target ).push( person );
		return { status: 'completed', backend };

	};
	host.transferPerson( handle, { to: second, expectedRevision: 0, expectedSample: 1 } );
	host.collect( {}, { step: 2 } );
	assert.equal( host.getPerson( handle ), null ); assert.notEqual( host.personState( handle ).pending, null );
	assert.equal( host.reconcile().some( ( event ) => event.type === 'person.membership-confirmed' ), false );
	( members.get( second ).at( - 1 ) as any ).membershipMatches = true;
	host.collect( {}, { step: 3 } );
	const events = host.reconcile();
	assert.equal( host.personState( handle ).pending, null );
	assert.equal( events.filter( ( event ) => event.type === 'person.membership-confirmed' ).length, 1 );
	host.collect( {}, { step: 4 } ); assert.deepEqual( host.reconcile(), [] );

} );

test( 'protected person keeps original subject through injury, recovery, carrier loss and death', () => {

	const { host, banner, first, second, members } = fixture( { kind: 'person', protection: {
		friendly: [ 'escort', 'relief' ], hostile: [ 'pursuers' ], recoveryMinimum: 2,
	} } );
	const initial = host.get( banner ), subject = initial.subject;
	assert.equal( initial.state, 'active' ); assert.equal( subject, initial.carrier );
	members.get( first )[ 0 ].status = 'injured'; host.collect( {} );
	assert.equal( host.reconcile( { elapsed: 5 } )[ 0 ].state, 'down' );
	const down = host.get( banner ); assert.equal( down.capture.held, 0 );
	const carrier = host.members( second )[ 0 ].handle;
	const receipt = host.transfer( banner, { carrier, expectedRevision: down.revision, expectedSample: 1 } );
	assert.equal( receipt.status, 'completed' ); assert.equal( receipt.value.state, 'carried' );
	assert.equal( receipt.value.subject, subject ); assert.notEqual( receipt.value.carrier, subject );
	assert.equal( host.getPerson( subject ).status, 'injured' );
	members.get( second )[ 0 ].status = 'injured'; host.collect( {} ); host.reconcile( { elapsed: 1 } );
	assert.equal( host.get( banner ).state, 'down' );
	members.get( first )[ 0 ].status = 'dead'; host.collect( {} );
	assert.equal( host.reconcile()[ 0 ].state, 'dead' );
	assert.equal( host.get( banner ).subject, subject );
	const terminal = host.get( banner );
	assert.equal( ( host.transfer( banner, { carrier, expectedRevision: terminal.revision, expectedSample: 1 } ) as any ).code, 'TERMINAL_STATE' );

} );

test( 'capture pressure uses sampled elapsed time and captured state cannot be recovered', () => {

	const { host, banner, second, pursuers, members } = fixture( { kind: 'person', protection: {
		friendly: [ 'escort', 'relief' ], hostile: [ 'pursuers' ], seconds: 4,
	} } );
	members.set( pursuers, [ 10, 11 ].map( ( key ) => ( { key, backend: key, leader: key === 10, status: 'active', position: [ 0, 0 ] } ) ) );
	host.collect( {} ); host.reconcile( { elapsed: 2 } );
	assert.equal( host.get( banner ).capture.held, 2 );
	host.collect( {} ); host.reconcile( { elapsed: 0 } );
	assert.equal( host.get( banner ).capture.held, 2 );
	host.collect( {} ); const events = host.reconcile( { elapsed: 2 } );
	assert.equal( events[ 0 ].state, 'captured' );
	const current = host.get( banner );
	assert.equal( current.actor, null ); assert.equal( current.carrier, null );
	const carrier = host.members( second )[ 0 ].handle;
	assert.equal( ( host.transfer( banner, { carrier, expectedRevision: current.revision, expectedSample: 1 } ) as any ).code, 'TERMINAL_STATE' );
	host.collect( {} ); assert.deepEqual( host.reconcile( { elapsed: 10 } ), [] );

} );

test( 'an initially injured protected person binds to the real subject and becomes down', () => {

	const { host, first, members } = fixture();
	host.remove( host.entities.get( 'banner' ) );
	members.get( first )[ 0 ].status = 'injured'; host.collect( {} );
	const handle = host.create( { id: 'speaker', kind: 'person', carrier: first,
		protection: { friendly: [ 'escort', 'relief' ], hostile: [ 'pursuers' ] } } );
	host.reconcile();
	const current = host.get( handle );
	assert.equal( current.state, 'down' ); assert.notEqual( current.subject, null );
	assert.equal( host.getPerson( current.subject ).status, 'injured' );
	assert.equal( current.carrier, null );

} );