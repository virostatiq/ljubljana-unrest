import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceHost, resourceDefinitions } from '../src/game/scenarios/resources.ts';
import { CommandHost, commandDefinitions, policeCommands, protestCommands, scenarioCommand } from '../src/game/scenarios/commands.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';
import { defineScenario, survive } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';

test( 'resources reserve the final unit atomically and release rejected work without spending', () => {

	const runtime = { time: 0 }, resources = new ResourceHost( runtime, { gas: { capacity: 1, cooldown: 10 } } );
	const accepted = resources.reserve( 'gas' );
	assert.equal( accepted.status, 'reserved' );
	assert.equal( ( resources.reserve( 'gas' ) as any ).code, 'RESOURCE_EMPTY' );
	assert.equal( resources.get( 'gas' ).left, 1 ); assert.equal( resources.get( 'gas' ).available, 0 );
	resources.release( accepted.token ); resources.release( accepted.token );
	assert.equal( resources.get( 'gas' ).available, 1 );
	const applied: any = resources.reserve( 'gas' ); resources.commit( applied.token );
	assert.equal( resources.get( 'gas' ).left, 0 ); assert.equal( resources.get( 'gas' ).readyIn, 10 );
	assert.throws( () => resources.commit( applied.token ), /reservation/ );

} );

test( 'resource cooldown follows game time, definitions detach and disposal releases reservations', () => {

	const runtime = { time: 0 }, options = { capacity: 3, initial: 2, cooldown: 15 };
	const resources = new ResourceHost( runtime, { reinforce: options } );
	options.capacity = 99;
	const reserved: any = resources.reserve( 'reinforce' );
	assert.equal( ( resources.reserve( 'reinforce' ) as any ).code, 'RESOURCE_BUSY' );
	resources.commit( reserved.token );
	assert.equal( resources.get( 'reinforce' ).capacity, 3 );
	assert.equal( ( resources.reserve( 'reinforce' ) as any ).code, 'COOLDOWN' );
	runtime.time = 15; assert.equal( resources.get( 'reinforce' ).readyIn, 0 );
	resources.reserve( 'reinforce' ); resources.dispose();
	assert.equal( resources.get( 'reinforce' ).reserved, 0 );
	assert.throws( () => resourceDefinitions( { gas: { capacity: 1, initial: 2 } } ), /initial/ );
	assert.throws( () => resourceDefinitions( { gas: { capacity: 1, cooldown: Infinity } } ), /finite/ );

} );

function commandFixture( definitions: readonly any[] = policeCommands( { gas: 'gas' } ), resources: Record<string, any> = { gas: { capacity: 1 } } ) {

	const events = [], applied = [], pending = [], freed = [];
	const handle = Object.freeze( { id: 'squad', kind: 'squad', run: 1 } );
	const runtime: any = { run: 1, state: 'running', time: 0, timeout: 15000, nextOperation: 1, operations: new Set<any>(),
		definition: { commands: definitions },
		actors: new Map( [ [ 'squad', { handle, backend: {} } ] ] ), actor: () => ( { alive: 24 } ),
		transport: { locked: () => false }, movement: { orders: new Map<any, any>(), player: {}, remove() {} },
		writable() {}, location: ( at ) => Object.freeze( [ ...at ] ), event: ( type, event ) => events.push( { type, ...event } ),
		fail: ( error ) => { runtime.error = error; runtime.state = 'failed'; },
		adapter: { commandEligible: () => false,
			prepareCommand: ( request ) => new Promise( ( resolve ) => pending.push( { request, resolve } ) ),
			applyCommand: ( request, actors, prepared, current ) => { if ( ! current() ) return { status: 'rejected', code: 'STALE' }; applied.push( request ); return { status: 'completed' }; },
			releaseCommand: ( prepared ) => freed.push( prepared ),
		} };
	runtime.resources = new ResourceHost( runtime, resources );
	const commands = new CommandHost( runtime );
	return { commands, runtime, handle, events, pending, applied, freed };

}

test( 'protest commands accept crowd handles, reject squads and validate umbrella inventory', async () => {

	const definitions = commandDefinitions( protestCommands( { umbrella: 'umbrella' } ), { umbrella: {} } );
	const fixture = commandFixture( definitions, { umbrella: { capacity: 1 } } );
	const crowd = Object.freeze( { id: 'crowd', kind: 'crowd', run: 1 } );
	fixture.runtime.actors.set( crowd.id, { handle: crowd, backend: {} } );
	assert.equal( ( await fixture.commands.execute( null, 'hold', { at: [ 0, 0 ], selection: [ fixture.handle ] } ).settled as any ).code, 'INVALID_SELECTION' );
	const hold = fixture.commands.execute( null, 'hold', { at: [ 0, 0 ], selection: [ crowd ] } );
	await Promise.resolve(); fixture.pending[ 0 ].resolve( {} ); assert.equal( ( await hold.settled as any ).status, 'completed' );
	assert.ok( fixture.commands.list().every( ( command ) => command.side === 'protest' ) );
	assert.throws( () => commandDefinitions( protestCommands( { umbrella: 'missing' } ), {} ), /resource/ );

} );

test( 'scenario-owned orders retain validated metadata and spend only on issue receipts', async () => {

	const definitions = commandDefinitions( [ scenarioCommand( { id: 'dispersal-order', key: 'b', label: 'Dispersal order', resource: 'order' } ) ], { order: {} } );
	assert.deepEqual( commandDefinitions( definitions, { order: {} } ), definitions );
	const fixture = commandFixture( definitions, { order: { capacity: 1, cooldown: 12 } } );
	const operation = fixture.commands.execute( null, 'dispersal-order', { at: [ 1, 2 ] } ); await Promise.resolve();
	assert.equal( fixture.pending[ 0 ].request.custom, true ); assert.equal( fixture.runtime.resources.get( 'order' ).reserved, 1 );
	fixture.pending[ 0 ].resolve( { custom: true } ); assert.equal( ( await operation.settled as any ).status, 'completed' );
	assert.equal( fixture.runtime.resources.get( 'order' ).left, 0 ); assert.equal( fixture.commands.list()[ 0 ].key, 'b' );
	assert.throws( () => scenarioCommand( { id: 'gas', key: 'b', label: 'Override' } ), /non-standard/ );

} );

test( 'command resources spend only after application; duplicate final-unit requests reject', async () => {

	const { commands, runtime, pending, events, applied } = commandFixture();
	const first = commands.execute( null, 'gas', { at: [ 10, 20 ] } );
	assert.equal( runtime.resources.get( 'gas' ).reserved, 1 );
	assert.equal( ( await commands.execute( null, 'gas', { at: [ 10, 20 ] } ).settled as any ).code, 'RESOURCE_EMPTY' );
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	assert.equal( ( await first.settled as any ).status, 'completed' );
	assert.equal( runtime.resources.get( 'gas' ).left, 0 ); assert.equal( applied.length, 1 );
	assert.equal( commands.escalation, 2 );
	assert.deepEqual( events.filter( ( event ) => event.operation === first.id ).map( ( event ) => event.type ),
		[ 'command.attempted', 'command.accepted', 'command.applied', 'command.completed' ] );

} );

test( 'applied behavior commands invoke the shared adapter side-effect hook exactly once', async () => {

	const { commands, runtime, pending } = commandFixture(), applied = [];
	runtime.adapter.commandApplied = ( request, receipt ) => applied.push( { request, receipt } );
	const owner = { id: 'ai-director', state: 'active', operations: new Set<any>() };
	const operation = commands.execute( owner, 'gas', { at: [ 10, 20 ], opinion: { delta: 1, reason: 'AI volley' } } );
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	assert.equal( ( await operation.settled as any ).status, 'completed' );
	assert.equal( applied.length, 1 );
	assert.equal( applied[ 0 ].request.source, 'behavior' );
	assert.equal( applied[ 0 ].receipt.command, 'gas' );
	assert.deepEqual( applied[ 0 ].request.opinion, { delta: 1, reason: 'AI volley' } );

	const opinion = [], mission = { counters: { gas: 0 }, gasOpinion: - 2, waterOpinion: - 3,
		nudgeOpinion: ( delta, reason ) => opinion.push( [ delta, reason ] ) };
	const adapter = new ScenarioEngine( mission );
	adapter.commandApplied( { id: 'gas', opinion: { delta: 1, reason: 'AI volley' } } ); adapter.commandApplied( { id: 'water' } );
	assert.equal( mission.counters.gas, 1 );
	assert.deepEqual( opinion, [ [ 1, 'AI volley' ], [ - 3, 'water cannon' ] ] );

} );

test( 'cancellation releases reservations and late preparation cannot apply or leak', async () => {

	const { commands, runtime, pending, applied, freed } = commandFixture();
	const operation = commands.execute( null, 'gas', { at: [ 10, 20 ] } );
	await Promise.resolve(); operation.cancel( 'cancelled' );
	assert.equal( ( await operation.settled as any ).status, 'cancelled' );
	assert.equal( runtime.resources.get( 'gas' ).available, 1 );
	pending[ 0 ].resolve( {} ); await Promise.resolve(); await Promise.resolve();
	assert.equal( applied.length, 0 ); assert.equal( freed.length, 1 );

} );

test( 'selection is captured and validated, player override invalidates late force', async () => {

	const { commands, handle, pending, applied } = commandFixture();
	assert.equal( ( await commands.execute( null, 'charge', { at: [ 1, 2 ] } ).settled as any ).code, 'SELECTION_REQUIRED' );
	assert.equal( ( await commands.execute( null, 'shield-push', { at: [ 1, 2 ], selection: [ handle ] } ).settled as any ).code, 'CORDON_REQUIRED' );
	const selection = [ handle ];
	const operation = commands.execute( null, 'charge', { at: [ 1, 2 ], selection }, 'player' );
	selection.length = 0; await Promise.resolve();
	assert.equal( pending[ 0 ].request.selection.length, 1 );
	commands.playerOverride( [ handle ] ); pending[ 0 ].resolve( {} );
	assert.equal( ( await operation.settled as any ).status, 'cancelled' );
	await Promise.resolve(); assert.equal( applied.length, 0 );
	assert.throws( () => commandDefinitions( policeCommands( { gas: 'missing' } ), {} ), /declared resource/ );

} );

test( 'scenario definitions validate resources and commands; runtime cleanup releases pending costs', async () => {

	let context, resolvePreparation;
	const definition = defineScenario( { id: 'orders', title: 'Orders', subtitle: 'Proof', brief: 'Proof.',
		resources: { gas: { capacity: 2, cooldown: 10 } }, commands: policeCommands( { gas: 'gas' } ),
		setup( ctx ) { context = ctx; }, objectives: [ survive( { id: 'hold', seconds: 60 } ) ] } );
	const runtime = new ScenarioRuntime( definition, {
		prepareCommand: () => new Promise( ( resolve ) => { resolvePreparation = resolve; } ),
		applyCommand: () => ( { status: 'completed' } ), releaseCommand() {}, release() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const operation = context.commands.execute( 'gas', { at: [ 0, 0 ] } );
	await Promise.resolve();
	assert.equal( context.resources.get( 'gas' ).reserved, 1 );
	runtime.dispose(); resolvePreparation( {} );
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	assert.equal( context.resources.get( 'gas' ).left, 2 );
	assert.equal( context.resources.get( 'gas' ).reserved, 0 );
	assert.throws( () => defineScenario( { ...definition, commands: policeCommands( { gas: 'unknown' } ) } ), /unsupported field|declared resource/ );

} );

test( 'application is a synchronous commit and cannot be canceled from its applied event', async () => {

	const { commands, runtime, pending } = commandFixture();
	let result;
	const emit = runtime.event;
	const operation = commands.execute( null, 'gas', { at: [ 0, 0 ] } );
	runtime.event = ( type, event ) => { emit( type, event ); if ( type === 'command.applied' ) result = operation.cancel(); };
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	assert.equal( ( await operation.settled as any ).status, 'completed' );
	assert.equal( result.status, 'too-late' ); assert.equal( runtime.resources.get( 'gas' ).left, 0 );

} );

test( 'owner stop during attempted/accepted events leaves no reservation or engine work', async () => {

	for ( const phase of [ 'command.attempted', 'command.accepted' ] ) {

		const { commands, runtime, pending } = commandFixture();
		const owner = { id: 'owner', state: 'active', operations: new Set<any>() };
		const emit = runtime.event;
		runtime.event = ( type, value ) => {

			emit( type, value );
			if ( type === phase ) { owner.state = 'stopped'; for ( const operation of [ ...owner.operations ] ) operation.cancel( 'owner stopped' ); }

		};
		const operation = commands.execute( owner, 'gas', { at: [ 0, 0 ] } );
		const outcome: any = await operation.settled;
		assert.equal( outcome.status, phase === 'command.attempted' ? 'rejected' : 'cancelled' );
		assert.equal( runtime.resources.get( 'gas' ).available, 1 );
		assert.equal( runtime.operations.size, 0 ); assert.equal( owner.operations.size, 0 );
		await Promise.resolve(); assert.equal( pending.length, 0 );

	}

} );

test( 'command locks are hidden, reject direct execution and release only with their owner', async () => {

	const { commands, runtime, handle } = commandFixture();
	runtime.behaviors = { writable: ( owner ) => assert.ok( [ 'starting', 'active' ].includes( owner.state ) ) };
	const first = { id: 'first', state: 'active', operations: new Set<any>() }, second = { id: 'second', state: 'active', operations: new Set<any>() };
	const firstCommands = commands.context( first ), secondCommands = commands.context( second );
	firstCommands.lock( 'charge' ); secondCommands.lock( 'charge' );
	assert.equal( commands.list().some( ( command ) => command.id === 'charge' ), false );
	assert.equal( ( await commands.execute( null, 'charge', { at: [ 0, 0 ], selection: [ handle ] } ).settled as any ).code, 'COMMAND_LOCKED' );
	commands.releaseOwner( first );
	assert.equal( commands.list().some( ( command ) => command.id === 'charge' ), false );
	secondCommands.unlock( 'charge' );
	assert.equal( commands.list().some( ( command ) => command.id === 'charge' ), true );
	assert.throws( () => firstCommands.lock( 'unknown' ), /unknown command/ );

} );

test( 'shield push yields the line order without dismantling its applied cordon', async () => {

	const { commands, runtime, handle, pending } = commandFixture();
	const removed = [];
	runtime.adapter.commandEligible = () => true;
	runtime.movement.orders.set( handle.id, { owner: runtime.movement.player } );
	runtime.movement.remove = ( order, reason, options ) => { removed.push( options ); runtime.movement.orders.delete( handle.id ); };
	const operation = commands.execute( null, 'shield-push', { at: [ 0, 10 ], selection: [ handle ] }, 'player' );
	assert.deepEqual( removed, [ { preserveState: true } ] );
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	assert.equal( ( await operation.settled as any ).status, 'completed' );

} );

test( 'expected preparation/application rejection releases resources without escalation', async () => {

	for ( const phase of [ 'prepare', 'apply' ] ) {

		const { commands, runtime, pending } = commandFixture();
		if ( phase === 'apply' ) runtime.adapter.applyCommand = () => ( { status: 'rejected', code: 'CAPACITY' } );
		const operation = commands.execute( null, 'gas', { at: [ 0, 0 ] } );
		await Promise.resolve(); pending[ 0 ].resolve( phase === 'prepare' ? { status: 'rejected', code: 'CAPACITY' } : {} );
		assert.equal( ( await operation.settled as any ).code, 'CAPACITY' );
		assert.equal( runtime.resources.get( 'gas' ).available, 1 ); assert.equal( runtime.resources.get( 'gas' ).left, 1 );
		assert.equal( commands.escalation, 0 );

	}

} );

test( 'snatch captures the nearest observed identified leader and returns its opaque person handle', async () => {

	const { commands, runtime, handle, pending } = commandFixture();
	const crowd = Object.freeze( { id: 'march', kind: 'crowd', run: 1 } );
	const nearLeader = Object.freeze( { id: 'person-near', kind: 'person', run: 1 } );
	const farLeader = Object.freeze( { id: 'person-far', kind: 'person', run: 1 } );
	const hiddenLeader = Object.freeze( { id: 'person-hidden', kind: 'person', run: 1 } );
	runtime.actors.set( crowd.id, { handle: crowd, backend: [] } );
	runtime.identity = { members: ( actor ) => actor === crowd ? [
		{ handle: farLeader, actor: crowd, leader: true, identified: true, status: 'active', faction: 'protester', position: [ 30, 0 ] },
		{ handle: nearLeader, actor: crowd, leader: true, identified: true, status: 'active', faction: 'counter', position: [ 8, 0 ] },
		{ handle: hiddenLeader, actor: crowd, leader: true, identified: false, status: 'active', faction: 'protester', position: [ 1, 0 ] },
	] : [] };
	const operation = commands.execute( null, 'snatch', { at: [ 0, 0 ], selection: [ handle ] }, 'player' );
	await Promise.resolve();
	assert.equal( pending[ 0 ].request.target.person, nearLeader );
	pending[ 0 ].resolve( {} );
	const outcome: any = await operation.settled;
	assert.equal( outcome.status, 'completed' ); assert.equal( outcome.value.target, nearLeader );
	assert.equal( outcome.value.selection[ 0 ], handle );

} );

test( 'snatch rejects when no active identified leader is within cursor range', async () => {

	const { commands, runtime, handle, pending } = commandFixture();
	const crowd = Object.freeze( { id: 'march', kind: 'crowd', run: 1 } );
	runtime.actors.set( crowd.id, { handle: crowd, backend: [] } );
	runtime.identity = { members: () => [ { leader: true, identified: true, status: 'injured', faction: 'protester', position: [ 1, 0 ] } ] };
	const outcome: any = await commands.execute( null, 'snatch', { at: [ 0, 0 ], selection: [ handle ] }, 'player' ).settled;
	assert.equal( outcome.code, 'TARGET_NOT_FOUND' ); assert.equal( pending.length, 0 );
	assert.equal( runtime.operations.size, 0 );

} );

test( 'water cannon requires a selected water vehicle and reserves its declared resource', async () => {

	const { commands, runtime, handle, pending } = commandFixture( policeCommands( { water: 'water' } ), { water: { capacity: 2 } } );
	assert.equal( ( await commands.execute( null, 'water', { at: [ 5, 0 ], selection: [ handle ] }, 'player' ).settled as any ).code, 'INVALID_SELECTION' );
	const vehicle = Object.freeze( { id: 'water-truck', kind: 'vehicle', run: 1 } );
	const backend = { isCar: true, water: true, x: 0, y: 0, sprayUntil: 0 };
	runtime.actors.set( vehicle.id, { handle: vehicle, backend } );
	const operation = commands.execute( null, 'water', { at: [ 5, 0 ], selection: [ vehicle ] }, 'player' );
	assert.equal( runtime.resources.get( 'water' ).reserved, 1 );
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	const outcome: any = await operation.settled;
	assert.equal( outcome.status, 'completed' ); assert.equal( outcome.value.affected[ 0 ], vehicle );
	assert.equal( runtime.resources.get( 'water' ).left, 1 ); assert.equal( commands.escalation, 3 );

} );

test( 'crew command accepts only one registered police-patrol vehicle', async () => {

	const { commands, runtime, handle, pending } = commandFixture( policeCommands( { crew: true } ), {} );
	assert.equal( ( await commands.execute( null, 'crew', { at: [ 0, 0 ], selection: [ handle ] }, 'player' ).settled as any ).code, 'INVALID_SELECTION' );
	const vehicle = Object.freeze( { id: 'patrol-car', kind: 'vehicle', run: 1 } );
	runtime.actors.set( vehicle.id, { handle: vehicle, backend: { isCar: true, crew: { members: [ 1 ] } } } );
	const operation = commands.execute( null, 'crew', { at: [ 0, 0 ], selection: [ vehicle ] }, 'player' );
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	assert.equal( ( await operation.settled as any ).status, 'completed' );
	assert.equal( commands.list().find( ( command ) => command.id === 'crew' ).immediate, true );

} );

test( 'firearms cannot be invoked by a behavior without player confirmation', async () => {

	const { commands, handle, pending } = commandFixture( policeCommands( { firearms: true } ), {} );
	const outcome = await commands.execute( { id: 'behavior', state: 'active', operations: new Set<any>() }, 'firearms',
		{ at: [ 0, 0 ], selection: [ handle ] }, 'behavior' ).settled;
	assert.deepEqual( outcome, { status: 'rejected', code: 'CONFIRMATION_REQUIRED' } );
	assert.equal( ( await commands.execute( null, 'firearms', { at: [ 0, 0 ], selection: [ handle ] }, 'player' ).settled as any ).code, 'CONFIRMATION_REQUIRED' );
	const confirmed = commands.execute( null, 'firearms', { at: [ 0, 0 ], selection: [ handle ] }, 'confirmed-player' );
	await Promise.resolve(); pending[ 0 ].resolve( {} );
	assert.equal( ( await confirmed.settled as any ).status, 'completed' );
	assert.equal( pending.length, 1 );

} );

test( 'firearms are opt-in and appear as an explicit confirmed standard command', () => {

	assert.equal( policeCommands().some( ( command ) => command.id === 'firearms' ), false );
	const command = policeCommands( { firearms: true } ).find( ( entry ) => entry.id === 'firearms' );
	assert.equal( command.resource, null );
	assert.equal( Object.hasOwn( command, 'danger' ), false );

} );