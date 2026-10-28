import assert from 'node:assert/strict';
import test from 'node:test';
import defenseScenario from '../examples/defense-scenario.ts';
import governmentScenario from '../examples/government-scenario.ts';
import trainingScenario from '../examples/training-scenario.ts';
import courtScenario from '../examples/court-scenario.ts';
import * as sdkBuilders from '../src/game/scenarios/index.ts';
import { CourtMission } from '../src/game/missions/court.ts';
import prideScenario from '../examples/pride-scenario.ts';
import blackBlocScenario from '../examples/blackbloc-scenario.ts';
import massacreScenario from '../examples/massacre-scenario.ts';
import resnicaScenario from '../examples/resnica-scenario.ts';
import rescueScenario from '../examples/rescue-scenario.ts';
import { ClashMission, clashScenario as clashMission } from '../src/game/missions/clash.ts';
import { RallyMission } from '../src/game/missions/rally.ts';
import { MAX_EDITS, STAT } from '../src/sim/crowd.ts';
import { advanceClash } from '../src/game/scenarios/clash.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';
import { scenarioMission } from '../src/game/scenarios/mission.ts';
import { defineBehavior, defineOutcome, defineScenario, escortConvoy, holdCrowd, place, preventClash, survive } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';
import { followRoute } from '../src/game/scenarios/route.ts';
import { SpatialHost } from '../src/game/scenarios/spatial.ts';
import { createScenarioPlaytest } from '../src/game/scenarios/playtest.ts';

test( 'developer playtest bounds advancement, rejects concurrency and exposes copied navigation counts', async () => {

	let finish;
	const { runtime } = fixture(); await runtime.setup(); runtime.observation = { actors: [], people: [], sampledAt: 0 }; await runtime.start();
	const game = { mission: { runtime }, paused: false, world: { flow: { layers: 32, slots: [ { refs: 1 }, null, { refs: 0 } ], pending: new Map(), queue: [] } },
		advance: async () => { await new Promise( ( resolve ) => { finish = resolve; } ); runtime.update( 1 ); } };
	const control = createScenarioPlaytest( game );
	for ( const seconds of [ 0, - 1, 31, Infinity, NaN ] ) await assert.rejects( control.advance( seconds ), /seconds/ );
	const work = control.advance( 1 );
	await assert.rejects( control.advance( 1 ), /progress/ ); finish();
	const snapshot = await work;
	assert.equal( snapshot.time, 1 ); assert.equal( game.paused, true );
	assert.equal( runtime.state, 'paused' );
	assert.deepEqual( snapshot.navigation, { capacity: 32, allocated: 2, referenced: 1, pending: 0, queued: 0 } );
	assert.ok( Object.isFrozen( snapshot.navigation ) ); assert.equal( 'slots' in snapshot.navigation, false ); runtime.dispose();

} );

test( 'developer fast-forward waits for asynchronous allocation before accepting another time chunk', async () => {

	let settle;
	const { runtime } = fixture(); await runtime.setup(); runtime.observation = { actors: [], people: [], sampledAt: 0 }; await runtime.start();
	const operation: any = { settled: new Promise( ( resolve ) => { settle = resolve; } ) };
	runtime.operations.add( operation );
	operation.settled.then( () => runtime.operations.delete( operation ) );
	const game = { mission: { runtime }, paused: false, world: { flow: { layers: 32, slots: [], pending: new Map(), queue: [] } }, advance: async () => runtime.update( 1 ) };
	const control = createScenarioPlaytest( game ); let finished = false;
	const advancing = control.advance( 1 ).then( ( snapshot ) => { finished = true; return snapshot; } );
	await new Promise( ( resolve ) => setImmediate( resolve ) ); assert.equal( finished, false );
	await assert.rejects( control.advance( 1 ), /progress/ ); settle( { status: 'completed' } );
	const snapshot = await advancing; assert.equal( snapshot.pendingOperations, 0 ); assert.equal( snapshot.paused, true ); runtime.dispose();

} );

test( 'timed-out developer advances reject reuse until a page reload', async () => {

	const { runtime } = fixture(); await runtime.setup(); runtime.observation = { actors: [], people: [], sampledAt: 0 }; await runtime.start();
	const game = { mission: { runtime }, paused: false, advance: () => new Promise( () => {} ) };
	const control = createScenarioPlaytest( game, { timeout: 5 } );
	await assert.rejects( control.advance( 1 ), /wall-clock limit/ );
	await assert.rejects( control.advance( 1 ), /reload required/ ); assert.equal( game.paused, true ); runtime.dispose();

} );

function scenario( overrides = {} ) {

	return defineScenario( { id: 'hello-scenario', title: 'Hello', subtitle: 'A scenario', brief: 'Hold.',
		locations: { square: place( 'Square' ) }, objectives: [ survive( { id: 'hold', seconds: 60 } ) ], ...overrides } );

}

function fixture( definition = scenario(), overrides = {} ) {

	const released = [], finished = [], failures = [], spawns = [];
	const adapter = {
		place: () => [ 10, 20 ], focus() {},
		spawn: async ( kind, options ) => { const backend = { kind, options }; spawns.push( backend ); return backend; },
		readActor: () => ( { alive: 10, center: [ 10, 20 ] } ),
		release: ( backend ) => released.push( backend ), ...overrides,
	};
	const runtime = new ScenarioRuntime( definition, adapter, { onFinish: ( result ) => finished.push( result ), onFailure: ( error ) => failures.push( error ) } );
	return { runtime, released, finished, failures, spawns };

}

test( 'map markers validate atomically and detach coordinates from caller data', async () => {

	const { runtime } = fixture(); await runtime.setup();
	const at = [ 10, 20 ], marker = { id: 'arrival', at, radius: 40, label: 'Students', kind: 'warn', countdownTo: 8 };
	runtime.context.presentation.markers( [ marker ] ); at[ 0 ] = 999; marker.label = 'changed';
	assert.equal( runtime.markers()[ 0 ].label, 'Students · 0:08' );
	assert.deepEqual( runtime.markers()[ 0 ].at, [ 10, 20 ] );
	assert.ok( Object.isFrozen( runtime.markers()[ 0 ].at ) );
	for ( const invalid of [ new Array( 1 ), [ { ...marker, radius: 0 } ], [ { ...marker, radius: Infinity } ],
		[ { ...marker, countdownTo: NaN } ], [ { ...marker, kind: 'purple' } ], [ { ...marker, label: '' } ],
		[ { ...marker, privateState: true } ], [ marker, marker ], Array.from( { length: 65 }, ( _, index ) => ( { ...marker, id: `marker-${index}` } ) ) ] ) {

		assert.throws( () => runtime.context.presentation.markers( invalid ), /presentation.markers/ );
		assert.equal( runtime.markers()[ 0 ].label, 'Students · 0:08' );

	}
	runtime.context.presentation.markers( [] ); assert.deepEqual( runtime.markers(), [] ); runtime.dispose();

} );

test( 'map markers own their lifetime and countdowns follow game time, not pause or wall time', async () => {

	const contexts = [];
	const markers = defineBehavior( { id: 'marker-owner', create: () => ( { start( ctx ) {

		contexts.push( ctx ); ctx.presentation.markers( [ { id: 'arrival', at: [ 0, 0 ], radius: 40, label: ctx.id, countdownTo: 8 } ] );

	} } ) } );
	const { runtime } = fixture( scenario( { behaviors: [ markers( { id: 'first' } ), markers( { id: 'second' } ) ] } ) );
	await runtime.setup(); runtime.observation = { actors: [], people: [] }; await runtime.start();
	assert.deepEqual( runtime.markers().map( ( marker ) => marker.label ), [ 'first · 0:08', 'second · 0:08' ] );
	runtime.update( 2 ); runtime.pause( true ); runtime.update( 20 );
	assert.equal( runtime.markers()[ 0 ].label, 'first · 0:06' );
	contexts[ 0 ].complete(); assert.equal( runtime.markers().length, 1 );
	assert.throws( () => contexts[ 0 ].presentation.markers( [] ), /owner|cannot mutate/ );
	runtime.pause( false ); runtime.update( 58 );
	assert.deepEqual( runtime.markers(), [] );
	assert.throws( () => contexts[ 1 ].presentation.markers( [] ), /owner|cannot mutate/ ); runtime.dispose();

} );

function governmentRouteHooks() {

	let routes;
	const defineBehavior = ( definition ) => {
		if ( definition.id === 'government-route-columns' ) routes = definition.create();
		return ( options ) => ( { kind: 'behavior', id: options.id } );
	};
	( governmentScenario as any )( { defineScenario: ( options ) => options, defineBehavior, defineOutcome: ( rule ) => rule,
		holdBuilding: ( options ) => options, landmark: ( name ) => name, place: ( name ) => name,
		policeCommands: () => [], target: ( name ) => name } );
	return routes;

}

function trainingCurriculum() {

	let curriculum;
	const definition = ( trainingScenario as any )( { defineBehavior: ( value ) => {
		if ( value.id === 'training-curriculum' ) curriculum = value.create();
		return ( options ) => ( { kind: 'behavior', id: options.id } );
	}, defineOutcome: ( rule ) => rule, defineScenario: ( options ) => options, landmark: ( name ) => name,
		place: ( name ) => name, policeCommands: () => [ 'arrest', 'charge', 'snatch', 'kettle', 'shield-push', 'crew', 'gas', 'reinforce', 'water' ]
			.map( ( id ) => ( { id } ) ), survive: ( options ) => ( { ...options, kind: 'survive' } ), target: ( name ) => name } );
	return { definition, curriculum };

}

test( 'definitions detach configuration and reject unsupported or malformed values', () => {

	const goals = [ 'Hold' ], location = [ 1, 2 ];
	const definition = scenario( { goals, locations: { square: location } } );
	assert.equal( definition.menu, true );
	goals.push( 'Changed' ); location[ 0 ] = 99;
	assert.deepEqual( definition.goals, [ 'Hold' ] );
	assert.deepEqual( definition.locations.square, [ 1, 2 ] );
	assert.throws( () => scenario( { goals: new Array( 1 ) } ), /dense array/ );
	assert.equal( scenario( { side: 'protest' } ).side, 'protest' );
	assert.throws( () => scenario( { unsupported: [] } ), /unsupported field/ );
	assert.throws( () => survive( { id: 'hold', seconds: NaN } ), /finite/ );
	assert.throws( () => holdCrowd( { id: 'crowd', at: 'square', radius: 0, minimumPeople: 5, holdSeconds: 3, timeoutSeconds: 10 } ), /radius/ );
	assert.throws( () => holdCrowd( { id: 'crowd', at: 'square', radius: 20, minimumPeople: 5, holdSeconds: 3, timeoutSeconds: 2 } ), /at least holdSeconds/ );
	assert.throws( () => scenario( { seed: - 1 } ), /unsigned 32-bit/ );
	assert.throws( () => scenario( { locations: { square: [ Infinity, 0 ] } } ), /finite/ );
	const charge = { kind: 'police-command', id: 'charge', resource: null };
	assert.throws( () => scenario( { commands: [ charge ], initiallyLockedCommands: [ 'gas' ] } ), /declared command IDs/ );
	assert.throws( () => scenario( { commands: [ charge ], initiallyLockedCommands: [ 'charge', 'charge' ] } ), /IDs must be unique/ );
	assert.equal( scenario( { side: 'protest', commands: [ charge ] } ).commands.length, 1 );

} );

test( 'spatial road spans validate host endpoints and return an immutable measured width', () => {

	const calls = [], spatial = new SpatialHost( { location: ( at ) => at === 'street' ? [ 10, 20 ] : at,
		adapter: { roadSpan: ( at, distance ) => { calls.push( [ at, distance ] ); return [ [ 4, 20 ], [ 16, 20 ] ]; } } } );
	const span = spatial.roadSpan( 'street', 16 );
	assert.deepEqual( calls, [ [ [ 10, 20 ], 16 ] ] );
	assert.deepEqual( span, { a: [ 4, 20 ], b: [ 16, 20 ], width: 12 } );
	assert.equal( Object.isFrozen( span ), true ); assert.equal( Object.isFrozen( span.a ), true );
	assert.throws( () => spatial.roadSpan( 'street', 0 ), /maxDistance/ );

} );

test( 'road routes snap destinations and return detached measured paths', () => {

	const source = [ [ 0, 0 ], [ 3, 4 ], [ 6, 6 ] ], calls = [];
	const engine = Object.create( ScenarioEngine.prototype );
	engine.mission = { world: { patrols: {
		snap: ( x, y ) => [ x + 1, y + 1 ],
		route: ( from, to ) => { calls.push( [ from, to ] ); return source; },
	} } };
	const spatial = new SpatialHost( { location: ( at ) => at, adapter: { roadRoute: ( from, to ) => engine.roadRoute( from, to ) } } );
	const route = spatial.roadRoute( [ 0, 0 ], [ 5, 5 ] );
	assert.deepEqual( calls, [ [ [ 0, 0 ], [ 6, 6 ] ] ] );
	assert.deepEqual( route, { points: source, length: 5 + Math.hypot( 3, 2 ) } );
	assert.ok( Object.isFrozen( route ) && Object.isFrozen( route.points ) && Object.isFrozen( route.points[ 1 ] ) );
	source[ 1 ][ 0 ] = 99; assert.deepEqual( route.points[ 1 ], [ 3, 4 ] );
	engine.mission.world.patrols.route = () => null;
	assert.equal( spatial.roadRoute( [ 0, 0 ], [ 5, 5 ] ), null );

} );

test( 'crowd-hold objective matches Rally cumulative occupancy, pauses below threshold and wins at the hold boundary', async () => {

	const definition = scenario( { objectives: [ holdCrowd( { id: 'square', at: 'square', radius: 60, minimumPeople: 6,
		holdSeconds: 3, timeoutSeconds: 10 } ) ] } );
	const { runtime } = fixture( definition );
	assert.equal( runtime.phase(), '0:10 left' );
	runtime.locations.set( 'square', [ 0, 0 ] );
	const handle = { id: 'protest', kind: 'crowd', run: runtime.run };
	runtime.actors.set( handle.id, { handle, backend: [] } );
	const observation = ( inSquare, total = 12 ) => ( { actors: [ { handle, alive: total, center: [ 0, 0 ] } ], people: Array.from( { length: total }, ( _, index ) => ( {
		faction: 'protester', status: 'active', agitation: 0, position: index < inSquare ? [ 0, 0 ] : [ 100, 100 ],
	} ) ) } );
	runtime.observation = observation( 6 ); runtime.state = 'briefing'; runtime.start();
	const nativeResult = [];
	let headcount = 6;
	const native = { ai: { tick() {} }, goal: 6, holdNeed: 3, held: 0, flags: {}, target: [ 0, 0 ], t: 0,
		stats: new Uint32Array( 16 ), get headcount() { return headcount; }, event() {}, end: ( win, reason ) => nativeResult.push( { win, reason } ) };
	native.stats[ STAT.PROT ] = 12;
	for ( const [ people, dt ] of [ [ 6, 1 ], [ 6, 1 ], [ 4, 2 ], [ 6, 1 ], [ 6, 1 ] ] ) {

		headcount = people; native.t += dt;
		RallyMission.prototype.tick.call( native, dt );
		runtime.observation = observation( people ); runtime.update( dt );
		assert.equal( runtime.heldCrowdSeconds, native.held );
		if ( nativeResult.length ) break;

	}
	assert.deepEqual( nativeResult, [ { win: true, reason: 'Trg republike belongs to the people tonight.' } ] );
	assert.equal( runtime.result.win, true ); assert.equal( runtime.time, 5 );
	runtime.dispose();

} );

test( 'crowd-hold objective loses on population collapse and times out without awarding an incomplete hold', async () => {

	const objective = holdCrowd( { id: 'square', at: [ 0, 0 ], radius: 60, minimumPeople: 5, holdSeconds: 4, timeoutSeconds: 5,
		minimumAlive: 5, minimumAliveAfter: 1 } );
	const { runtime } = fixture( scenario( { objectives: [ objective ] } ) );
	const handle = { id: 'protest', kind: 'crowd', run: runtime.run };
	runtime.actors.set( handle.id, { handle, backend: [] } );
	const observation = ( inSquare, total ) => ( { actors: [ { handle, alive: total, center: [ 0, 0 ] } ],
		people: Array.from( { length: total }, ( _, index ) => ( { faction: 'protester', status: 'active', agitation: 0,
			position: index < inSquare ? [ 0, 0 ] : [ 100, 100 ] } ) ) } );
	runtime.observation = observation( 0, 4 ); runtime.state = 'briefing'; runtime.start();
	runtime.update( 1 ); assert.equal( runtime.result, null );
	runtime.update( 0.1 ); assert.equal( runtime.result.win, false );
	runtime.dispose();

	const timeoutObjective = holdCrowd( { id: 'square', at: [ 0, 0 ], radius: 60, minimumPeople: 5, holdSeconds: 4, timeoutSeconds: 5 } );
	const timed = fixture( scenario( { objectives: [ timeoutObjective ] } ) ).runtime;
	const timedHandle = { id: 'protest', kind: 'crowd', run: timed.run };
	timed.actors.set( timedHandle.id, { handle: timedHandle, backend: [] } );
	timed.observation = { actors: [ { handle: timedHandle, alive: 5, center: [ 100, 100 ] } ],
		people: Array.from( { length: 5 }, () => ( { faction: 'protester', status: 'active', agitation: 0, position: [ 100, 100 ] } ) ) };
	timed.state = 'briefing'; timed.start(); timed.update( 5 ); assert.equal( timed.result, null );
	timed.update( 0.1 ); assert.equal( timed.result.win, false );
	timed.dispose();

} );

test( 'split and merge preserve person handles while protected actors reject restructuring', async () => {

	let nextGroup = 1;
	const groups = new Map<string, any>();
	const adapter = {
		place: () => [ 0, 0 ], focus() {},
		spawn: async ( kind, options ) => {
			const group = { id: nextGroup ++, faction: 0, members: Array.from( { length: options.people }, ( _, index ) => `${options.id}-${index}` ), leader: `${options.id}-0` };
			groups.set( options.id, group ); return [ group ];
		},
		readActor: ( backend ) => ( { alive: backend.reduce( ( total, group ) => total + group.members.length, 0 ), center: [ 0, 0 ] } ),
		readPeople: ( backend ) => backend.flatMap( ( group ) => group.members.map( ( key ) => ( { key, backend: { group, member: key }, faction: 'protester', position: [ 0, 0 ], status: 'active', leader: key === group.leader } ) ) ),
		splitActor: ( backend ) => {
			const group = backend[ 0 ]; if ( group.members.length < 8 ) return { groups: backend, newGroups: [] };
			const members = group.members.splice( Math.floor( group.members.length / 2 ) ), child = { id: nextGroup ++, faction: group.faction, members, leader: members[ 0 ] };
			group.leader = group.members[ 0 ]; for ( const key of members ) groups.set( key, child ); return { groups: backend, newGroups: [ child ] };
		},
		mergeActors: ( collections ) => {
			const all = collections.flat(), target = all.reduce( ( first, second ) => first.members.length >= second.members.length ? first : second );
			for ( const group of all ) if ( group !== target ) { target.members.push( ...group.members ); group.members = []; }
			return { status: 'completed', groups: [ target ], destination: collections.findIndex( ( collection ) => collection.includes( target ) ) };
		},
		release() {},
	};
	const definition = scenario( { setup( ctx ) {

		ctx.spawn.crowd( { id: 'alpha', at: [ 0, 0 ], people: 20 } ); ctx.spawn.crowd( { id: 'beta', at: [ 0, 0 ], people: 12 } );
		ctx.spawn.crowd( { id: '1234567890123456789012345678901234567890', at: [ 0, 0 ], people: 8 } );
		ctx.spawn.crowd( { id: 'protected-group', at: [ 0, 0 ], people: 8 } ); ctx.protected.create( { id: 'banner', carrier: 'protected-group' } );

	} } );
	const runtime = new ScenarioRuntime( definition, adapter ); await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const protectedHandle = runtime.context.actors.resolve( 'protected-group' );
	assert.equal( runtime.context.actors.split( protectedHandle ).status, 'rejected' );
	const longIdHandle = runtime.context.actors.resolve( '1234567890123456789012345678901234567890' );
	assert.throws( () => runtime.context.actors.split( longIdHandle ), /actor ID capacity exceeded/ );
	assert.equal( runtime.context.people.members( longIdHandle ).length, 8 );
	const parent = runtime.context.actors.resolve( 'alpha' ), people = runtime.context.people.members( parent ), split = runtime.context.actors.split( parent );
	runtime.observe( {} );
	assert.equal( split.status, 'completed' ); assert.equal( runtime.context.people.members( parent ).length, 10 );
	assert.equal( runtime.context.people.members( split.value ).length, 10 );
	assert.equal( runtime.context.actors.merge( [ parent, split.value, 'beta' ] ).status, 'completed' );
	runtime.observe( {} );
	const beta = runtime.context.actors.resolve( 'beta' ); assert.equal( runtime.context.people.members( beta ).length, 32 );
	for ( const original of people ) assert.equal( runtime.context.people.get( original.handle ).actor, beta );
	assert.equal( runtime.context.protected.get( runtime.context.protected.resolve( 'banner' ) ).actor, protectedHandle );
	runtime.dispose();

} );

test( 'protest-side scenarios route selected crowd movement through the SDK without police orders', () => {

	const definition = scenario( { side: 'protest' } ), ScenarioMission = scenarioMission( definition );
	const group = { id: 7 }, crowd = { id: 'crowd-1', kind: 'crowd', run: 1 }, moves = [], actions = [];
	const runtime = { state: 'running', actors: new Map( [ [ crowd.id, { handle: crowd, backend: [ group ] } ] ] ),
		commands: { list: () => [ { id: 'gas', key: 'g', label: 'Gas', needsSelection: false } ] },
		playerMove: ( ...args ) => moves.push( args ), playerAction: ( action ) => actions.push( action ) };
	const mission = Object.assign( Object.create( ScenarioMission.prototype ), { runtime, game: { selected: [ group ] } } );
	assert.equal( mission.onPlayerMovement( { type: 'line', units: [ group ], a: [ 0, 0 ], at: [ 10, 20 ] } ), true );
	assert.deepEqual( moves, [ [ crowd, [ 10, 20 ], {} ] ] );
	assert.deepEqual( mission.commands().map( ( command ) => command.key ), [ 'rmb' ] );
	mission.onAction( { type: 'move', units: [ group ], at: [ 10, 20 ] } );
	assert.deepEqual( actions[ 0 ].selection, [ crowd ] );

} );

test( 'per-step clash pressure keeps the native mission formula', () => {

	// the formula of the native Clash mission before it moved to the SDK: rises with contacts (capped), decays without
	let native = 0, pressure = 0;
	for ( const [ contacts, dt ] of [ [ 1, 0.25 ], [ 600, 0.25 ], [ 2400, 0.5 ], [ 0, 1 ], [ 0, 2 ], [ 4000, 0.25 ] ] ) {

		native = Math.max( 0, Math.min( 1, native + ( contacts > 0 ? Math.min( 0.028, contacts / 2400 ) : - 0.012 ) * dt ) );
		pressure = advanceClash( pressure, contacts, dt );
		assert.equal( pressure, native );

	}

} );

test( 'Clash: a calm rally on Trg republike, a fired-up counter-protest on Kongresni trg, cordons between', async () => {

	assert.equal( ClashMission.id, 'clash' );
	assert.equal( ( ClashMission as any ).sdkScenario, true );
	const { runtime, spawns } = fixture( clashMission( sdkBuilders as any ) as any, { landmark: () => [ 30, 40 ] } );
	await runtime.setup();
	const crowds = spawns.filter( ( s ) => s.kind === 'crowd' ), squads = spawns.filter( ( s ) => s.kind === 'squad' );
	const rally = crowds.find( ( s ) => s.options.id === 'rally' ), counters = crowds.filter( ( s ) => s.options.id.startsWith( 'counter-' ) );
	assert.equal( rally.options.mode, 'hold' );
	assert.equal( rally.options.standoff, null );
	assert.ok( rally.options.agitation[ 1 ] < 0.2 );
	assert.equal( counters.length, 15 );
	for ( const c of counters ) {

		assert.equal( c.options.faction, 'counter' );
		assert.deepEqual( c.options.standoff, { level: 2, ceiling: 4, blows: true } );

	}
	assert.equal( squads.filter( ( s ) => s.options.id.startsWith( 'cordon-' ) ).length, 4 );
	runtime.dispose();

} );

test( 'clash objective exposes semantic GPU contacts and resolves brawl loss before timeout', async () => {

	let contacts = 2400;
	const objective = preventClash( { id: 'separate-crowds', seconds: 60 } );
	const { runtime } = fixture( scenario( { objectives: [ objective ] } ), { readMetrics: () => ( { opinion: 60, clashContacts: contacts, counters: {} } ) } );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 20 );
	assert.equal( runtime.metrics().clashContacts, 2400 );
	assert.equal( runtime.metrics().clashPressure, 0.56 );
	assert.equal( runtime.objectives()[ 1 ].text, '56%' );
	runtime.update( 20 );
	assert.equal( runtime.result.win, false );
	assert.equal( runtime.result.reason, objective.failureReason );
	runtime.dispose();

	contacts = 0;
	const win = fixture( scenario( { objectives: [ preventClash( { id: 'separate-crowds', seconds: 2 } ) ] } ),
		{ readMetrics: () => ( { opinion: 60, clashContacts: contacts, counters: {} } ) } ).runtime;
	await win.setup(); win.observe( {} ); win.start(); win.update( 2 );
	assert.equal( win.result.win, true ); win.dispose();

} );

test( 'escort convoy objective exposes immutable route state and wins on arrival or loses on integrity/blockage', async () => {

	let state = { distance: 10, progress: 0.1, speed: 5, integrity: 1, blockedFor: 0, blockers: 0, attackers: 0, moving: false, arrived: false }, released = 0, moving = false;
	const create = ( seconds = 900, maxBlocked = 75 ) => {
		let handle;
		const definition = scenario( { setup: ( ctx ) => { handle = ctx.convoys.create( { id: 'vip' } ); },
			objectives: [ escortConvoy( { id: 'escort', convoy: 'vip', seconds, maxBlocked } ) ] } );
		const runtime = new ScenarioRuntime( definition, { place: () => [ 10, 20 ], createConvoy: () => ( { length: 100 } ),
			readConvoy: () => ( { ...state, moving } ), convoyPoint: ( _convoy, distance ) => ( { x: distance, y: 0, heading: 0 } ),
			departConvoy() { moving = true; }, updateConvoy() {}, updateConvoyWalls() {}, releaseConvoy: () => { released ++; } } );
		return { runtime, get handle() { return handle; } };
	};
	const arrival = create(), runtime = arrival.runtime;
	await runtime.setup(); runtime.observe( {} ); runtime.start();
	assert.equal( runtime.context.convoys.get( arrival.handle ).progress, 0.1 );
	assert.deepEqual( runtime.context.convoys.at( arrival.handle, 15 ), { position: [ 15, 0 ], heading: 0 } );
	assert.throws( () => runtime.context.convoys.at( arrival.handle, 101 ), /within the route length/ );
	assert.deepEqual( runtime.context.convoys.depart( arrival.handle ), { status: 'completed' } );
	assert.deepEqual( runtime.context.convoys.depart( arrival.handle ), { status: 'rejected', code: 'ALREADY_MOVING' } );
	state = { ...state, arrived: true, progress: 1, distance: 100 };
	runtime.update( 1 );
	assert.equal( runtime.result.win, true ); runtime.dispose();

	state = { distance: 10, progress: 0.1, speed: 0, integrity: 0.5, blockedFor: 3, blockers: 12, attackers: 0, moving: true, arrived: false };
	const blocked = create( 900, 2 );
	await blocked.runtime.setup(); blocked.runtime.observe( {} ); blocked.runtime.start(); blocked.runtime.update( 1 );
	assert.equal( blocked.runtime.result.win, false ); assert.match( blocked.runtime.result.reason, /stuck too long/ );
	blocked.runtime.dispose();

	state = { distance: 10, progress: 0.1, speed: 0, integrity: 0, blockedFor: 0, blockers: 0, attackers: 30, moving: true, arrived: false };
	const destroyed = create();
	await destroyed.runtime.setup(); destroyed.runtime.observe( {} ); destroyed.runtime.start(); destroyed.runtime.update( 1 );
	assert.equal( destroyed.runtime.result.win, false ); assert.match( destroyed.runtime.result.reason, /overrun/ );
	destroyed.runtime.dispose(); assert.equal( released, 3 );

} );

test( 'private engine maps only the semantic per-step clash count from aggregate stats', () => {

	const stats = new Uint32Array( 48 ); stats[ STAT.CLASH ] = 7;
	const engine = new ScenarioEngine( { opinion: 60, escalation: 0, counters: { injByPolice: 0, injOther: 0, injPolice: 0,
		arrested: 0, arrestedSitters: 0, gone: 0, gas: 0 }, stats } );
	assert.equal( engine.readMetrics().clashContacts, 7 );

} );

test( 'all locations preflight before setup can spawn', async () => {

	const { runtime, spawns } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.crowd( { id: 'crowd', at: 'square' } ) } ), { place: () => undefined } );
	await assert.rejects( runtime.setup(), /scenario.locations.square/ );
	assert.equal( runtime.state, 'failed' );
	assert.equal( spawns.length, 0 );

} );

test( 'setup awaits owned work and actors expose immutable observations, not backend state', async () => {

	let operation, context;
	const { runtime } = fixture( scenario( { setup: ( ctx ) => { context = ctx; operation = ctx.spawn.crowd( { id: 'crowd', at: 'square', people: 300 } ); } } ) );
	await runtime.setup();
	const outcome = await operation.settled;
	assert.equal( outcome.status, 'completed' );
	assert.equal( operation.state, 'completed' );
	assert.equal( context.actors.get( outcome.value ), null );
	const sample = {};
	runtime.observe( sample );
	const actor = context.actors.get( outcome.value );
	assert.equal( actor.alive, 10 );
	assert.equal( 'backend' in actor, false );
	assert.throws( () => { actor.center[ 0 ] = 99; }, TypeError );
	runtime.observe( sample );
	assert.equal( runtime.observation.sequence, 1 );
	assert.throws( () => context.actors.get( { ...outcome.value } ), /foreign/ );

} );

test( 'clock starts after briefing and only advances while running; result seals once', async () => {

	const { runtime, finished } = fixture();
	await runtime.setup();
	runtime.update( 100 );
	assert.equal( runtime.time, 0 );
	assert.throws( () => runtime.start(), /initial observation/ );
	runtime.observe( {} ); runtime.start();
	runtime.update( 20 ); runtime.pause( true ); runtime.update( 100 );
	assert.equal( runtime.time, 20 );
	runtime.pause( false ); runtime.update( 40 ); runtime.update( 100 );
	assert.equal( runtime.time, 60 );
	assert.equal( finished.length, 1 );
	assert.equal( runtime.objectives()[ 0 ].state, 'done' );
	assert.throws( () => { runtime.result.lines[ 0 ][ 0 ] = 'changed'; }, TypeError );
	assert.throws( () => runtime.context.spawn.squad( { id: 'late', at: 'square' } ), /cannot mutate/ );

} );

test( 'scenario-owned random streams are repeatable for a seed and remain bounded', () => {

	const draw = ( seed ) => {
		const runtime = new ScenarioRuntime( scenario( { seed } ), {} );
		return Array.from( { length: 8 }, () => runtime.context.random() );
	};
	const first = draw( 42 ), repeated = draw( 42 ), other = draw( 43 );
	assert.deepEqual( first, repeated ); assert.notDeepEqual( first, other );
	assert.ok( first.every( ( value ) => value >= 0 && value < 1 ) );

} );

test( 'setup failure releases applied actors and reports failure rather than a scored defeat', async () => {

	const { runtime, released, finished, failures } = fixture( scenario( { setup: async ( ctx ) => {

		await ctx.spawn.squad( { id: 'squad', at: 'square' } ).settled;
		throw new Error( 'setup broke' );

	} } ) );
	await assert.rejects( runtime.setup(), /setup broke/ );
	assert.equal( released.length, 1 );
	assert.equal( failures.length, 1 );
	assert.equal( finished.length, 0 );
	runtime.dispose(); runtime.dispose();
	assert.equal( released.length, 1 );

} );

test( 'unawaited spawn failure still fails setup', async () => {

	const { runtime } = fixture( scenario( { setup: ( ctx ) => { ctx.spawn.crowd( { id: 'crowd', at: 'square' } ); } } ),
		{ spawn: async () => { throw new Error( 'capacity exhausted' ); } } );
	await assert.rejects( runtime.setup(), /capacity exhausted/ );
	assert.equal( runtime.result, null );

} );

test( 'dispose cancels owned work and releases late allocations without resurrecting actors', async () => {

	let resolveSpawn, operation;
	const { runtime, released } = fixture( scenario( { setup: ( ctx ) => { operation = ctx.spawn.crowd( { id: 'crowd', at: 'square' } ); } } ),
		{ spawn: () => new Promise( ( resolve ) => { resolveSpawn = resolve; } ) } );
	const setup = runtime.setup();
	await Promise.resolve(); await Promise.resolve();
	runtime.dispose();
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	resolveSpawn( { allocation: 1 } );
	await assert.rejects( setup, /interrupted/ );
	await Promise.resolve();
	assert.equal( runtime.state, 'disposed' );
	assert.equal( runtime.actors.size, 0 );
	assert.equal( released.length, 1 );

} );

test( 'instances do not share clocks, actor identities or disposal', async () => {

	const definition = scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'squad', at: 'square' } ) } );
	const first = fixture( definition ), second = fixture( definition );
	await Promise.all( [ first.runtime.setup(), second.runtime.setup() ] );
	first.runtime.observe( {} ); second.runtime.observe( {} );
	first.runtime.start(); first.runtime.update( 15 ); first.runtime.dispose();
	assert.equal( second.runtime.state, 'briefing' );
	assert.equal( second.runtime.time, 0 );
	assert.equal( second.released.length, 0 );
	second.runtime.dispose();

} );

test( 'cancel before adapter work starts does not allocate; completed work cannot be cancelled', async () => {

	let cancelled, completed;
	const { runtime, spawns } = fixture( scenario( { setup: ( ctx ) => {

		cancelled = ctx.spawn.crowd( { id: 'cancelled', at: 'square' } );
		assert.equal( cancelled.cancel().status, 'requested' );
		completed = ctx.spawn.squad( { id: 'completed', at: 'square' } );

	} } ) );
	await runtime.setup();
	assert.equal( ( await cancelled.settled ).status, 'cancelled' );
	assert.equal( ( await completed.settled ).status, 'completed' );
	assert.equal( completed.cancel().status, 'already-settled' );
	assert.equal( spawns.length, 1 );
	runtime.dispose();

} );

test( 'missing adapter allocations fail rather than publishing false actor handles', async () => {

	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.crowd( { id: 'crowd', at: 'square' } ) } ), { spawn: async () => undefined } );
	await assert.rejects( runtime.setup(), /no actor allocation/ );
	assert.equal( runtime.actors.size, 0 );

} );

test( 'fixed-step accumulation reports the complete minute, not 0:59', async () => {

	const { runtime } = fixture();
	await runtime.setup(); runtime.observe( {} ); runtime.start();
	for ( let step = 0; step < 3600; step ++ ) runtime.update( 1 / 60 );
	assert.equal( runtime.time, 60 );
	assert.deepEqual( runtime.result.lines[ 0 ], [ 'Time held', '1:00' ] );

} );

test( 'behavior attachments validate and detach per-instance configuration', () => {

	const behavior = defineBehavior( { id: 'custom', create: () => ( {} ), validate: ( options ) => {

		assert.equal( typeof options.actor, 'string' );

	} } );
	const options = { id: 'first', actor: 'escort', route: [ [ 1, 2 ] ] };
	const attachment = behavior( options );
	options.route[ 0 ][ 0 ] = 99;
	assert.deepEqual( attachment.options.route, [ [ 1, 2 ] ] );
	assert.throws( () => { attachment.options.route.push( [ 3, 4 ] ); }, TypeError );
	assert.throws( () => behavior( { id: 'invalid', actor: 'escort', route: new Array( 1 ) } ), /dense/ );
	assert.throws( () => behavior( { id: 'invalid', actor: 'escort', callback: () => {} } ), /configuration/ );
	assert.throws( () => scenario( { behaviors: [ attachment, attachment ] } ), /unique/ );
	assert.throws( () => defineBehavior( { id: 'invalid', create: {} } ), /fresh hooks/ );
	assert.equal( scenario( { behaviors: [ attachment ] } ).behaviors[ 0 ].type, 'custom' );

} );

test( 'behavior instances have private state, owned timers, and exactly-once stop', async () => {

	const events = [], contexts = [];
	const behavior = defineBehavior( { id: 'counter', create: ( options ) => {

		let count = 0;
		return {
			start( ctx ) { contexts.push( ctx ); ctx.timeline.after( 2, () => events.push( `${options.id}:timer` ) ); },
			update() { events.push( `${options.id}:${++ count}` ); },
			stop( ctx, reason ) { events.push( `${options.id}:stop:${reason}` ); assert.equal( ctx.signal.aborted, true ); },
		};

	} } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'first' } ), behavior( { id: 'second' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	runtime.update( 1 ); runtime.pause( true ); runtime.update( 100 );
	assert.deepEqual( events, [ 'first:1', 'second:1' ] );
	contexts[ 0 ].complete();
	assert.throws( () => contexts[ 0 ].timeline.after( 0, () => {} ), /cannot mutate/ );
	runtime.pause( false ); runtime.update( 1 ); runtime.dispose(); runtime.dispose();
	assert.deepEqual( events, [ 'first:1', 'second:1', 'first:stop:completed', 'second:timer', 'second:2', 'second:stop:disposed' ] );

} );

test( 'fresh observations report sampled elapsed time, not receipt or frame duration', async () => {

	const samples = [];
	const observer = defineBehavior( { id: 'observer', create: () => ( { observe( ctx, sample ) { samples.push( sample ); } } ) } );
	const { runtime } = fixture( scenario( { behaviors: [ observer( { id: 'observer' } ) ] } ) );
	await runtime.setup(); runtime.observe( {}, { sampledAt: 0, step: 0 } ); await runtime.start();
	runtime.update( 1 ); runtime.update( 1 );
	const sample = {};
	runtime.observe( sample, { sampledAt: 1, step: 1 } );
	runtime.observe( sample, { sampledAt: 1, step: 1 } );
	runtime.observe( {}, { sampledAt: 0.5, step: 0 } );
	assert.equal( samples.length, 2 );
	assert.equal( samples[ 1 ].sampledAt, 1 );
	assert.equal( samples[ 1 ].receivedAt, 2 );
	assert.equal( samples[ 1 ].elapsed, 1 );
	runtime.pause( true ); runtime.observe( {}, { sampledAt: 2, step: 2 } );
	assert.equal( samples[ 2 ].elapsed, 1 );
	runtime.observe( {}, { sampledAt: 2, step: 2 } );
	assert.equal( samples[ 3 ].elapsed, 0 );
	runtime.dispose();

} );

test( 'behavior hook failure is attributed and stops peers without scoring a defeat', async () => {

	const stops = [];
	const broken = defineBehavior( { id: 'broken', create: () => ( {
		update() { throw new Error( 'broken rule' ); }, stop( ctx, reason ) { stops.push( reason ); },
	} ) } );
	const { runtime, failures } = fixture( scenario( { behaviors: [ broken( { id: 'rule' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' );
	assert.match( failures[ 0 ].message, /behavior.rule.update: broken rule/ );
	assert.deepEqual( stops, [ 'failed' ] );
	assert.equal( runtime.result, null );

} );

test( 'delayed autonomous movement cannot overwrite a newer player order', async () => {

	const pending = [], applied = [], freed = [], events = [];
	let context, autonomous;
	const follower = defineBehavior( { id: 'follower', create: () => ( {
		start( ctx ) { context = ctx; autonomous = ctx.movement.move( 'escort', [ 50, 0 ] ); },
		onEvent( ctx, event ) { events.push( event ); },
	} ) } );
	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ follower( { id: 'follower' } ) ] } ), {
		prepareMove: ( backend, request ) => new Promise( ( resolve ) => pending.push( { request, resolve } ) ),
		applyMove: ( backend, prepared, request, valid ) => { if ( ! valid() ) return false; applied.push( request.at ); return true; },
		releaseMove: ( prepared ) => freed.push( prepared ), stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const player = runtime.playerMove( 'escort', [ 10, 20 ] );
	await Promise.resolve();
	assert.equal( ( await autonomous.settled ).status, 'cancelled' );
	assert.equal( ( await context.movement.move( 'escort', [ 80, 0 ] ).settled ).code, 'PLAYER_CONTROL' );
	pending[ 1 ].resolve( { id: 'player-route' } );
	assert.equal( ( await player.settled as any ).status, 'completed' );
	pending[ 0 ].resolve( { id: 'stale-route' } );
	await Promise.resolve(); await Promise.resolve();
	assert.deepEqual( applied, [ [ 10, 20 ] ] );
	assert.equal( freed.length, 2 );
	assert.equal( events.filter( ( event ) => event.type === 'movement.arrived' ).length, 0 );
	runtime.update( 1 ); runtime.observe( {}, { sampledAt: 1, step: 1 } );
	assert.equal( events.filter( ( event ) => event.type === 'movement.arrived' ).length, 1 );
	assert.equal( events.find( ( event ) => event.type === 'movement.arrived' ).source, 'player' );
	runtime.dispose();

} );

test( 'stopping a behavior cancels prepared navigation and releases a late route', async () => {

	let context, resolveRoute, operation, released = 0, applied = 0;
	const behavior = defineBehavior( { id: 'mover', create: () => ( { start( ctx ) {

		context = ctx; operation = ctx.movement.move( 'escort', [ 50, 0 ] );

	} } ) } );
	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ behavior( { id: 'mover' } ) ] } ), {
		prepareMove: () => new Promise( ( resolve ) => { resolveRoute = resolve; } ),
		applyMove: () => { applied ++; }, releaseMove: () => released ++, stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	context.complete();
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	resolveRoute( {} ); await Promise.resolve(); await Promise.resolve();
	assert.equal( applied, 0 ); assert.equal( released, 1 );
	assert.equal( runtime.movement.orders.size, 0 );
	runtime.dispose();

} );

test( 'async startup waits before play and disposal interrupts a pending start', async () => {

	let resolveStart, context;
	const behavior = defineBehavior( { id: 'async-start', create: () => ( {
		start( ctx ) { context = ctx; return new Promise( ( resolve ) => { resolveStart = resolve; } ); },
	} ) } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'starting' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} );
	const started = runtime.start(); runtime.update( 10 );
	assert.equal( runtime.state, 'starting' ); assert.equal( runtime.time, 0 );
	runtime.dispose();
	await assert.rejects( started, /behavior.starting.start.*interrupted/ );
	resolveStart(); await Promise.resolve();
	assert.equal( context.signal.aborted, true );
	assert.throws( () => context.presentation.focus( 'square' ), /cannot mutate/ );
	assert.equal( runtime.state, 'disposed' );

} );

test( 'stopping during the apply phase holds the actor and prevents late arrival', async () => {

	let context, operation, resolveApply, stopped = 0;
	const behavior = defineBehavior( { id: 'mover', create: () => ( { start( ctx ) {

		context = ctx; operation = ctx.movement.move( 'escort', [ 50, 0 ] );

	} } ) } );
	const { runtime } = fixture( scenario( { setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ behavior( { id: 'mover' } ) ] } ), {
		prepareMove: async () => ( {} ),
		applyMove: () => new Promise( ( resolve ) => { resolveApply = resolve; } ),
		releaseMove() {}, stopMove() { stopped ++; },
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.equal( operation.state, 'applied' );
	context.complete(); resolveApply( true );
	assert.equal( ( await operation.settled ).status, 'cancelled' );
	assert.equal( stopped, 1 ); assert.equal( runtime.movement.orders.size, 0 );
	runtime.dispose();

} );

test( 'route following resumes at a forward waypoint after a player detour', async () => {

	let center = [ 0, 0 ];
	const applied = [];
	const { runtime } = fixture( scenario( {
		setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ followRoute( { id: 'route', actor: 'escort', waypoints: [ [ 10, 0 ], [ 20, 0 ], [ 30, 0 ] ], radius: 2 } ) ],
	} ), {
		readActor: () => ( { alive: 24, center } ), prepareMove: async () => ( {} ),
		applyMove: ( backend, prepared, request ) => { applied.push( request.at ); }, releaseMove() {}, stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	center = [ 10, 0 ]; runtime.update( 1 ); runtime.observe( {} );
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	assert.deepEqual( applied, [ [ 10, 0 ], [ 20, 0 ] ] );
	const detour = runtime.playerMove( 'escort', [ 29, 4 ] );
	await detour.settled;
	center = [ 29, 4 ]; runtime.update( 1 ); runtime.observe( {} );
	await runtime.movement.orders.get( 'escort' ).operation.settled;
	assert.deepEqual( applied, [ [ 10, 0 ], [ 20, 0 ], [ 29, 4 ], [ 30, 0 ] ] );
	center = [ 30, 0 ]; runtime.update( 1 ); runtime.observe( {} );
	assert.equal( runtime.behaviors.instances.get( 'route' ).state, 'completed' );
	assert.equal( runtime.result, null );
	runtime.dispose();

} );

test( 'completion from a timer cancels other due timers without changing completed status', async () => {

	let first, second, calls = 0;
	const behavior = defineBehavior( { id: 'timers', create: () => ( { start( ctx ) {

		first = ctx.timeline.after( 1, () => { calls ++; ctx.complete(); } );
		second = ctx.timeline.after( 1, () => { calls ++; } );

	} } ) } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'timers' } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 1 );
	assert.equal( calls, 1 ); assert.equal( first.state, 'completed' ); assert.equal( second.state, 'cancelled' );
	runtime.dispose();

} );

test( 'asynchronous behavior creation fails setup instead of creating an empty behavior', async () => {

	const behavior = defineBehavior( { id: 'invalid', create: async () => ( {} ) } );
	const { runtime } = fixture( scenario( { behaviors: [ behavior( { id: 'invalid' } ) ] } ) );
	await assert.rejects( runtime.setup(), /must synchronously return fresh hooks/ );
	assert.equal( runtime.state, 'failed' );

} );

test( 'relative routes resolve coordinates from a declared place before play begins', async () => {

	const applied = [];
	const { runtime } = fixture( scenario( {
		setup: ( ctx ) => ctx.spawn.squad( { id: 'escort', at: 'square' } ),
		behaviors: [ followRoute( { id: 'route', actor: 'escort', relativeTo: 'square', waypoints: [ [ 30, 0 ] ] } ) ],
	} ), {
		prepareMove: async () => ( {} ), applyMove: ( backend, prepared, request ) => applied.push( request.at ),
		releaseMove() {}, stopMove() {},
	} );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.deepEqual( applied, [ [ 40, 20 ] ] );
	assert.equal( runtime.state, 'running' ); assert.equal( runtime.time, 0 );
	runtime.dispose();

} );

test( 'crowd spawning validates and detaches explicit wave attributes without changing defaults', async () => {

	const agitation = [ 0.5, 0.8 ];
	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		ctx.spawn.crowd( { id: 'wave', at: 'square', goal: [ 40, 20 ], people: 200, label: 'Arrivals',
			groupSize: 100, agitation, morale: 0.8, bikes: 0.25 } );
		agitation[ 0 ] = 0;
		assert.throws( () => ctx.spawn.crowd( { id: 'invalid', at: 'square', agitation: [ 0.9, 0.2 ] } ), /ordered/ );
		assert.throws( () => ctx.spawn.crowd( { id: 'invalid', at: 'square', mode: 'march' } ), /requires a destination/ );

	} } ) );
	await runtime.setup();
	assert.equal( spawns[ 0 ].options.mode, 'march' ); assert.equal( spawns[ 0 ].options.groupSize, 100 );
	assert.deepEqual( spawns[ 0 ].options.agitation, [ 0.5, 0.8 ] ); assert.equal( spawns[ 0 ].options.label, 'Arrivals' );
	runtime.dispose();

} );

test( 'crowd standoff options are validated and passed on frozen; without them the crowd has none', async () => {

	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		ctx.spawn.crowd( { id: 'counter', at: 'square', faction: 'counter', standoff: { level: 2, ceiling: 4, blows: true } } );
		ctx.spawn.crowd( { id: 'rally', at: 'square' } );
		assert.throws( () => ctx.spawn.crowd( { id: 'bad-level', at: 'square', standoff: { level: 5 as any } } ), /spawn.standoff.level/ );
		assert.throws( () => ctx.spawn.crowd( { id: 'above', at: 'square', standoff: { level: 4, ceiling: 2 } } ), /above the ceiling/ );
		assert.throws( () => ctx.spawn.crowd( { id: 'unknown', at: 'square', standoff: { anger: 1 } as any } ), /unsupported field/ );
		assert.throws( () => ctx.spawn.crowd( { id: 'blows', at: 'square', standoff: { blows: 'yes' as any } } ), /spawn.standoff.blows/ );
		assert.throws( () => ctx.spawn.crowd( { id: 'onlookers', at: 'square', faction: 'bystander', standoff: {} } ), /bystanders/ );

	} } ) );
	await runtime.setup();
	assert.deepEqual( spawns[ 0 ].options.standoff, { level: 2, ceiling: 4, blows: true } );
	assert.equal( Object.isFrozen( spawns[ 0 ].options.standoff ), true );
	assert.equal( spawns[ 1 ].options.standoff, null );
	runtime.dispose();

} );

test( 'actor configuration exposes native closed and leader-succession policies', async () => {

	let configured;
	const { runtime } = fixture( scenario( { setup( ctx ) { ctx.spawn.crowd( { id: 'militant', at: 'square' } ); } } ), {
		configureActor: ( groups, options ) => { configured = options; return { status: 'completed' }; },
	} );
	await runtime.setup();
	const result = runtime.context.actors.configure( runtime.context.actors.resolve( 'militant' ), { closed: true, leaderSuccession: false } );
	assert.equal( result.status, 'completed' ); assert.deepEqual( configured, { closed: true, leaderSuccession: false } ); runtime.dispose();
	const engine = Object.create( ScenarioEngine.prototype ), crowd = { u: { parting: { value: - 1 } } }, group: any = { id: 'speaker' }, ordinary: any = { id: 'ordinary' };
	engine.mission = { crowd, world: {}, city: {} }; engine.configureActor( [ group ], { closed: true, parting: true, leaderSuccession: false } );
	assert.equal( group.closed, true ); assert.equal( group.succession, Infinity ); assert.equal( crowd.u.parting.value, group.id );
	engine.configureActor( [ ordinary ], { closed: true } ); assert.equal( ordinary.closed, true ); assert.equal( 'succession' in ordinary, false );

} );

test( 'crowd recall is an actor-scoped resolve mutation with a bounded floor', async () => {

	let backend, captured;
	const definition = scenario( { setup( ctx ) { ctx.spawn.crowd( { id: 'antifa', at: 'square', people: 2 } ); } } );
	const { runtime } = fixture( definition, {
		spawn: async ( kind ) => { backend = { id: 'antifa-group', kind, members: [ 0, 1 ] }; return [ backend ]; },
		recallCrowd: ( groups, floor ) => { captured = [ groups, floor ]; return { status: 'completed', people: 2 }; },
	} );
	await runtime.setup();
	const actor = runtime.context.actors.resolve( 'antifa' ), result = runtime.context.crowd.recall( actor, 0.6 );
	assert.equal( result.status, 'completed' ); assert.deepEqual( captured, [ [ backend ], 0.6 ] );
	assert.throws( () => runtime.context.crowd.recall( actor, 2.1 ), /crowd\.recall\.floor/ ); runtime.dispose();

} );

test( 'native crowd recall preflights edit capacity before queueing members', () => {

	const calls = [], crowd = { pendingEdits: [], recall: ( member, floor ) => calls.push( [ member, floor ] ) };
	const engine = Object.create( ScenarioEngine.prototype ); engine.mission = { crowd, world: { intel: {} } };
	const groups = [ { members: [ 10, 11 ] }, { members: [ 12 ] } ];
	assert.deepEqual( engine.recallCrowd( groups, 0.6 ), { status: 'completed', people: 3 } );
	assert.deepEqual( calls, [ [ 10, 0.6 ], [ 11, 0.6 ], [ 12, 0.6 ] ] );
	crowd.pendingEdits = new Array( MAX_EDITS - 2 ); calls.length = 0;
	assert.deepEqual( engine.recallCrowd( groups, 0.6 ), { status: 'rejected', code: 'EDIT_CAPACITY' } ); assert.deepEqual( calls, [] );
	engine.mission.world.intel = null;
	assert.deepEqual( engine.recallCrowd( groups, 0.6 ), { status: 'rejected', code: 'OBSERVATION_UNAVAILABLE' } );

} );

test( 'vehicle spawning validates transport, water-cannon, and static police capabilities', async () => {

	let handles;
	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		ctx.spawn.vehicle( { id: 'truck', at: 'square', type: 'water-cannon' } );
		ctx.spawn.vehicle( { id: 'roadblock', at: 'square', type: 'police-patrol', crew: 0, selectable: false } );
		assert.throws( () => ctx.spawn.vehicle( { id: 'invalid', at: 'square', type: 'combat' } ), /transport, water-cannon/ );
		assert.throws( () => ctx.spawn.vehicle( { id: 'invalid-selectable', at: 'square', selectable: 'no' as any } ), /spawn.selectable/ );
		handles = ctx.actors;

	} } ) );
	await runtime.setup();
	assert.equal( spawns[ 0 ].options.type, 'water-cannon' );
	assert.equal( spawns[ 1 ].options.crew, 0 ); assert.equal( spawns[ 1 ].options.selectable, false );
	assert.equal( runtime.actors.get( 'truck' ).type, 'water-cannon' );
	assert.equal( handles.resolve( 'truck' ).kind, 'vehicle' );
	runtime.dispose();

} );

test( 'bystander spawns validate and detach wander destinations as a crowd actor', async () => {

	let operation, actors;
	const destinations: any[] = [ 'square', [ 30, 40 ] ];
	const { runtime, spawns } = fixture( scenario( { setup( ctx ) {

		operation = ctx.spawn.bystanders( { id: 'onlookers', people: 2200, destinations } );
		destinations[ 1 ][ 0 ] = 999;
		assert.throws( () => ctx.spawn.bystanders( { id: 'invalid', people: 12, destinations: [] } ), /non-empty/ );
		actors = ctx.actors;

	} } ) );
	await runtime.setup();
	const outcome = await operation.settled;
	assert.equal( outcome.status, 'completed' ); assert.equal( outcome.value.kind, 'crowd' );
	assert.equal( spawns[ 0 ].kind, 'bystanders' ); assert.equal( spawns[ 0 ].options.people, 2200 );
	assert.deepEqual( spawns[ 0 ].options.destinations, [ [ 10, 20 ], [ 30, 40 ] ] );
	assert.equal( actors.resolve( 'onlookers' ), outcome.value );
	runtime.dispose();

} );

test( 'custom scoring receives frozen semantic metrics and validates score rows', async () => {

	let seen, context;
	const scoring = ( { win, metrics } ) => {
		seen = { win, metrics };
		const second = win && metrics.opinion >= 45, third = win && metrics.counters.injuriesByPolice <= 25;
		return { stars: Number( win ) + Number( second ) + Number( third ), lines: [ [ 'Public opinion', Math.round( metrics.opinion ) ],
			[ 'Injuries caused by police', metrics.counters.injuriesByPolice ], [ 'Arrests', metrics.counters.arrests ], [ 'Tear gas used', metrics.counters.gasUsed ] ] };
	};
	const { runtime, finished } = fixture( scenario( { score: scoring, setup( ctx ) { context = ctx; },
		objectives: [ survive( { id: 'hold', seconds: 1 } ) ] } ), { readMetrics: () => ( { opinion: 44.8,
		counters: { injuriesByPolice: 26, arrests: 4, gasUsed: 1 } } ) } );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.equal( context.metrics.opinion, 44.8 ); assert.equal( context.metrics.counters.arrests, 4 );
	assert.equal( Object.isFrozen( context.metrics.counters ), true );
	assert.equal( seen.win, true ); assert.equal( Object.isFrozen( seen.metrics.counters ), true );
	assert.equal( finished[ 0 ].stars, 1 ); assert.deepEqual( finished[ 0 ].lines, [ [ 'Public opinion', 45 ],
		[ 'Injuries caused by police', 26 ], [ 'Arrests', 4 ], [ 'Tear gas used', 1 ] ] );
	assert.throws( () => scenario( { score: 42 } ), /synchronous scoring/ );

} );

test( 'metric indicators apply warning and failure thresholds and phase policies receive semantic state', () => {

	let phaseContext;
	const definition = scenario( { indicators: [ { id: 'injury-limit', label: 'Police injuries', counter: 'injuriesByPolice', maximum: 25, warnAt: 15 } ],
		phase: ( context ) => { phaseContext = context; return `At ${context.time}`; } } );
	const metrics = ( injuriesByPolice ) => ( { opinion: 60, counters: { injuriesByPolice } } );
	const states = [ 15, 16, 25, 26 ].map( ( injuriesByPolice ) => fixture( definition, { readMetrics: () => metrics( injuriesByPolice ) } ).runtime.objectives().at( - 1 ).state );
	assert.deepEqual( states, [ 'ok', 'warn', 'warn', 'bad' ] );
	const runtime = fixture( definition ).runtime;
	assert.equal( runtime.phase(), 'At 0' );
	assert.equal( phaseContext.objective, 'survive' );
	assert.equal( phaseContext.metrics.opinion, 60 );
	assert.throws( () => scenario( { indicators: [ { id: 'bad-limit', label: 'Bad', counter: 'injuriesByPolice', maximum: 10, warnAt: 11 } ] } ), /between zero and maximum/ );
	assert.throws( () => scenario( { indicators: [ { id: 'unknown', label: 'Unknown', counter: 'privateValue', maximum: 10 } ] } ), /unknown semantic counter/ );

} );

test( 'invalid phase policy output fails the runtime instead of escaping into the HUD', () => {

	const { runtime, failures } = fixture( scenario( { phase: () => Promise.resolve( 'too late' ) } ) );
	assert.equal( runtime.phase(), '1:00 left' );
	assert.equal( runtime.state, 'failed' );
	assert.match( failures[ 0 ].message, /scenario\.phase: must return synchronous non-empty text/ );

} );

test( 'BlackBloc, Massacre, Pride and Resni.ca candidates retain their source contract metadata', () => {

	const blackbloc = ( blackBlocScenario as any )( sdkBuilders ), massacre = ( massacreScenario as any )( sdkBuilders ), pride = ( prideScenario as any )( sdkBuilders ), resnica = ( resnicaScenario as any )( sdkBuilders );
	assert.deepEqual( [ blackbloc.id, blackbloc.side, blackbloc.objectives[ 0 ].kind, blackbloc.resources.gas.capacity ], [ 'blackbloc-rules', 'police', 'survive', 4 ] );
	assert.deepEqual( [ massacre.id, massacre.objectives[ 0 ].seconds, massacre.terrain[ 0 ].id, massacre.terrain[ 0 ].polygon.length ], [ 'massacre-rules', 400, 'embassy-fence', 20 ] );
	assert.deepEqual( [ pride.id, pride.side, pride.objectives[ 0 ].seconds, pride.commands.some( ( command ) => command.id === 'firearms' ) ], [ 'pride-rules', 'police', 1801, true ] );
	assert.deepEqual( [ resnica.id, resnica.city, resnica.objectives[ 0 ].seconds, resnica.resources.water.capacity ], [ 'resnica-rules', 'north', 1500, 10 ] );
	assert.ok( blackbloc.commands.some( ( command ) => command.id === 'dispersal-order' ) );
	assert.equal( pride.commands.some( ( command ) => command.id === 'protest-command' ), false );

} );

test( 'Rescue mobile police response is scheduled relative to the Speaker escape', () => {

	const definition = ( rescueScenario as any )( sdkBuilders ), behavior = definition.behaviors[ 0 ].create(), timers = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } );
	const context = { time: 0, protected: { get: () => ( { actor: speaker } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } } };
	behavior.start( context ); assert.deepEqual( timers.map( ( timer ) => timer.seconds ), [ 2, 14, 45 ] ); timers.length = 0;
	behavior.onEvent( context, { type: 'player.move', actor: speaker } );
	assert.deepEqual( timers.map( ( timer ) => timer.seconds ), [ 20, 55, 95, 140 ] );

} );

test( 'Rescue Snatch considers a deployed mobile crew at 40 m, not only its 25 m lunge radius', async () => {

	const definition = ( rescueScenario as any )( sdkBuilders ), behavior = definition.behaviors[ 0 ].create();
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), vehicle = Object.freeze( { id: 'mobile-1', kind: 'vehicle', run: 1 } );
	const crew = Object.freeze( { id: 'mobile-1-crew', kind: 'squad', run: 1 } ), timers = [], notices = [], commands = [];
	let moving = false, crewState = 'aboard', crewRevision = 0;
	const position: [ number, number ] = [ - 205, - 178 ];
	const context = {
		time: 0, signal: new AbortController().signal, observation: { people: [] },
		protected: { get: () => ( { actor: speaker, state: 'active', position } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice: ( text ) => notices.push( text ), markers() {} },
		spawn: { vehicle: () => ( { settled: Promise.resolve( { status: 'completed', value: vehicle } ) } ) },
		vehicles: {
			get: () => ( { handle: vehicle, position: [ - 372, - 385 ], moving, speed: moving ? 9 : 0, revision: crewRevision,
				crew: { handle: crew, state: crewState, people: 12, aboard: crewState === 'aboard' ? 12 : 0 } } ),
			drive: () => { moving = true; crewRevision ++; return { status: 'completed' }; },
			toggleCrew: () => { crewState = 'deployed'; crewRevision ++; return { status: 'completed', value: { crew: { handle: crew } } }; },
		},
		spatial: { roadRoute: ( from, to ) => ( { points: [ from, to ], length: 180 } ), walkable: ( at ) => at, roadSpan: () => ( { a: [ - 12, 0 ], b: [ 12, 0 ], width: 24 } ), count: () => 0 },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		actors: { resolve: ( id ) => Object.freeze( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { handle,
			center: handle.id === crew.id ? [ - 165, - 178 ] : [ - 900, - 900 ], alive: 12 } ) },
		commands: { execute: ( id, request ) => { commands.push( { id, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		resources: { get: () => ( { available: false } ) },
	};
	behavior.start( context ); behavior.onEvent( context, { type: 'player.move', actor: speaker } );
	timers.find( ( timer ) => timer.seconds === 20 ).callback(); await Promise.resolve();
	timers.find( ( timer ) => timer.seconds === 1.5 ).callback(); moving = false; crewRevision ++;
	behavior.observe( context, { sequence: 1, elapsed: 0.5 } );
	context.time = 75; behavior.update( context ); context.time = 90; behavior.update( context );
	assert.ok( notices.some( ( text ) => text.includes( 'mobile-1-crew for the Speaker' ) ) );
	timers.filter( ( timer ) => timer.seconds === 5 ).at( - 1 ).callback();
	assert.equal( commands[ 0 ].id, 'arrest' ); assert.equal( commands[ 0 ].request.selection[ 0 ].id, crew.id );
	assert.equal( commands[ 0 ].request.retarget, true );

} );

test( 'Rescue mobile police deploy a road cordon and pursue after the Speaker passes it', async () => {

	const definition = ( rescueScenario as any )( sdkBuilders ), behavior = definition.behaviors[ 0 ].create();
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), vehicle = Object.freeze( { id: 'mobile-1', kind: 'vehicle', run: 1 } ), crew = Object.freeze( { id: 'mobile-crew', kind: 'squad', run: 1 } );
	const timers = [], spawned = [], drives = [], moves = [], commands = [];
	let speakerPosition = [ - 205, - 178 ], speakerState = 'active', crewState = 'aboard';
	const rescueCar = { handle: { id: 'rescue-car', kind: 'vehicle', run: 1 }, position: [ - 318, - 772 ], speed: 0, moving: false, revision: 0, crew: null };
	const context = { time: 0, signal: new AbortController().signal, observation: null as any,
		protected: { get: () => ( { actor: speaker, state: speakerState, position: speakerPosition } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		spawn: { vehicle: ( options ) => { spawned.push( options ); return { settled: Promise.resolve( { status: 'completed', value: vehicle } ) }; } },
		vehicles: {
			get: ( handle ) => handle === vehicle ? { handle: vehicle, position: [ - 372, - 385 ], speed: 0, moving: false, revision: crewState === 'aboard' ? 0 : 1,
				crew: { handle: crew, state: crewState, people: 12, aboard: crewState === 'aboard' ? 12 : 0 } } : rescueCar,
			drive: ( handle, at, options ) => { drives.push( { handle, at, options } ); return { status: 'completed', value: {} }; },
			toggleCrew: ( handle, options ) => { crewState = 'deployed'; return { status: 'completed', value: { crew: { handle: crew, state: crewState } } }; },
		},
		spatial: { roadSpan: () => ( { a: [ - 12, 0 ], b: [ 12, 0 ], width: 24 } ), roadRoute: ( from, to ) => ( { points: [ from, to ], length: 180 } ),
			walkable: ( at ) => at, count: () => null },
		movement: { move: ( actor, at, options ) => { moves.push( { actor, at, options } ); return {}; } },
		actors: { resolve: () => crew, get: ( handle ) => ( { handle, center: [ - 150, - 300 ], alive: 12 } ) },
		commands: { execute: ( id, request ) => { commands.push( { id, request } ); return { id: `operation-${commands.length}`, state: 'applied', settled: Promise.resolve( { status: 'completed' } ), cancel: () => ( { status: 'too-late' } ) }; } },
		resources: { get: () => ( { available: false } ) },
	};
	behavior.start( context ); behavior.onEvent( context, { type: 'player.move', actor: speaker } );
	timers.find( ( timer ) => timer.seconds === 20 ).callback(); await Promise.resolve();
	assert.deepEqual( spawned[ 0 ], { id: 'mobile-1', at: [ - 372, - 385 ], type: 'police-patrol', crew: 12, selectable: false } );
	assert.equal( drives.length, 0 ); timers.find( ( timer ) => timer.seconds === 1.5 ).callback();
	assert.equal( drives.length, 1 );
	behavior.observe( context, { sequence: 1, elapsed: 1 } );
	assert.deepEqual( moves[ 0 ], { actor: crew, at: [ 12, 0 ], options: { line: [ - 12, 0 ], radius: 8 } } );
	speakerPosition = [ - 233, - 402 ];
	behavior.observe( context, { sequence: 2, elapsed: 1 } );
	assert.equal( commands[ 0 ].id, 'arrest' ); assert.deepEqual( commands[ 0 ].request.selection, [ crew ] );
	assert.ok( timers.some( ( timer ) => timer.seconds === 30 ) );
	context.observation = {}; context.time = 3; behavior.update( context ); assert.equal( commands.length, 2 );
	speakerState = 'down'; context.time = 6; behavior.update( context ); assert.equal( commands.length, 2 );
	assert.ok( moves.some( ( move ) => move.at === speakerPosition ) );

} );

test( 'Rescue AntiFa assault targets nearby police and applies sampled injury effects', () => {

	const definition = ( rescueScenario as any )( sdkBuilders ), behavior = definition.behaviors[ 0 ].create();
	assert.ok( definition.commands.some( ( command ) => command.id === 'antifa-assault' ) );
	const attacker = Object.freeze( { id: 'antifa-1', kind: 'crowd', run: 1 } ), target = Object.freeze( { id: 'force-0-0', kind: 'squad', run: 1 } );
	const attackerPerson = Object.freeze( { id: 'antifa-person', run: 1 } ), policePerson = Object.freeze( { id: 'police-person', run: 1 } );
	const observations = new Map( [ [ attacker.id, { handle: attacker, center: [ 0, 0 ], alive: 24 } ], [ target.id, { handle: target, center: [ 1, 0 ], alive: 24 } ] ] );
	const moves = [], modes = [], configurations = [], recalls = [], effects = [], opinions = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), rescueCar = { position: [ - 318, - 772 ], moving: true, speed: 8 };
	const context = { time: 5, random: () => 0,
		protected: { get: () => ( { actor: speaker, state: 'active', position: [ - 205, - 178 ] } ) },
		vehicles: { get: () => rescueCar },
		actors: { resolve: ( id ) => observations.get( id )?.handle, get: ( actor ) => observations.get( actor.id ), configure: ( actor, options ) => { configurations.push( [ actor, options ] ); } },
		movement: { move: ( actor, at, options ) => { moves.push( [ actor, at, options ] ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		crowd: { setMode: ( actor, mode ) => { modes.push( [ actor, mode ] ); return { status: 'completed' }; }, recall: ( actor, floor ) => { recalls.push( [ actor, floor ] ); return { status: 'completed' }; } },
		opinion: { adjust: ( delta, reason ) => opinions.push( [ delta, reason ] ) },
		effects: { apply: ( person, options ) => { effects.push( [ person, options ] ); return { status: 'queued' }; }, nudge: () => ( { status: 'completed' } ) },
		spatial: { count: () => null }, presentation: { notice() {}, markers() {} }, timeline: { after() {} },
	};
	behavior.onEvent( context, { type: 'command.applied', command: 'antifa-assault', selection: [ attacker ], at: [ 1, 0 ], source: 'player' } );
	behavior.observe( context, { sequence: 5, elapsed: 0.5, people: [
		{ handle: attackerPerson, actor: attacker, faction: 'protester', position: [ 0, 0 ], status: 'active', agitation: 0.6 },
		{ handle: policePerson, actor: target, faction: 'police', position: [ 1, 0 ], status: 'active', agitation: 0 },
	] } );
	assert.ok( moves.some( ( [ actor ] ) => actor === attacker ) ); assert.deepEqual( modes, [ [ attacker, 'push' ] ] );
	assert.deepEqual( recalls, [ [ attacker, 0.6 ] ] );
	assert.deepEqual( configurations, [ [ attacker, { speed: 1.7 } ] ] ); assert.deepEqual( opinions, [ [ - 2, 'AntiFa attack the police' ] ] );
	assert.deepEqual( effects, [ [ policePerson, { status: 'injured', source: 'other', expectedSample: 5 } ] ] );

} );

test( 'Court candidate preserves native population, police force and score thresholds', () => {

	const definition = ( courtScenario as any )( sdkBuilders ), crowd = [], police = [], vehicles = [];
	const context = { locations: { get: () => [ 100, 100 ] }, presentation: { focus() {} },
		spatial: { footprint: () => [ 0, 0, 100, 0, 100, 100, 0, 100 ], clearance: () => 5, sample: ( at ) => at,
			walkable: ( at ) => at, roadSpan: ( at ) => ( { a: [ at[ 0 ] - 10, at[ 1 ] ], b: [ at[ 0 ] + 10, at[ 1 ] ] } ) },
		spawn: { crowd: ( options ) => crowd.push( options ), squad: ( options ) => police.push( options ), vehicle: ( options ) => vehicles.push( options ), bystanders() {} },
		protected: { create: () => ( {} ) } };
	definition.setup( context );
	assert.deepEqual( crowd.map( ( group ) => group.people ), [ 250, 600, 500, 120, 20 ] );
	assert.equal( police.length, 11 ); assert.ok( police.every( ( squad ) => squad.people === 24 ) ); assert.equal( vehicles.length, 2 );
	for ( const win of [ false, true ] ) for ( const time of [ 599.9, 600, 900 ] ) for ( const opinion of [ 49, 50 ] ) for ( const officers of [ 10, 11 ] ) {

		const expected = CourtMission.prototype.score.call( { t: time, opinion, banner: { bearers: 1 }, counters: { injByPolice: 3, injPolice: officers, arrested: 4, treated: 0 }, ai: { gasUsed: 0 } } as any, win );
		const actual = definition.score( { win, time, metrics: { opinion, counters: { injuriesByPolice: 3, officersInjured: officers, arrests: 4 } } } );
		assert.equal( actual.stars, expected.stars ); assert.deepEqual( actual.lines.filter( ( row ) => row[ 0 ] !== 'Treated by medics' ), expected.lines.filter( ( row ) => row[ 0 ] !== 'Treated by medics' ) );

	}

} );

test( 'Government Palace waves split across exact route columns and advance through both legs to rally', async () => {

	const behavior = governmentRouteHooks(), timers = [], spawned = [], centers = new Map<any, any>(), orders = [], nudges = [], modes = [];
	const context = { time: 0, signal: new AbortController().signal, observation: null,
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		people: { members: () => [ { faction: 'protester', status: 'active' } ] },
		crowd: { nudge: ( actor, options ) => { nudges.push( [ actor.id, options ] ); return { status: 'completed', value: { actor, people: 1 } }; },
			setMode: ( actor, mode ) => { modes.push( [ actor.id, mode ] ); return { status: 'completed', value: { actor, mode } }; } },
		spawn: { crowd: ( options ) => {
			const actor = { id: options.id, kind: 'crowd', run: 1 };
			centers.set( actor.id, [ - 545, - 243 ] ); spawned.push( { actor, options } );
			return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
		} },
		actors: { get: ( actor ) => ( { handle: actor, alive: 100, center: centers.get( actor.id ) ?? null } ) },
		movement: { move: ( actor, at, options ) => {
			orders.push( { actor, at, options } );
			return { settled: Promise.resolve( { status: 'completed', value: {} } ) };
		} },
	};
	behavior.start( context );
	timers.find( ( timer ) => timer.seconds === 8 ).callback( context );
	await Promise.resolve();
	assert.equal( spawned.length, 20 );
	assert.equal( spawned.filter( ( entry ) => entry.options.goal[ 0 ] === - 668 ).length, 10 );
	assert.equal( spawned.filter( ( entry ) => entry.options.goal[ 0 ] === - 410 ).length, 10 );
	assert.ok( spawned.every( ( entry ) => entry.options.spread === 35 && entry.options.goalRadius === 12 ) );
	context.observation = { actors: spawned.map( ( entry ) => ( { handle: entry.actor, center: [ - 545, - 243 ] } ) ), people: [] };
	behavior.onEvent( context, { type: 'command.applied', command: 'charge', at: [ - 545, - 243 ] } );
	assert.equal( nudges.length, 20 );
	assert.deepEqual( modes, [], 'route-bound groups should not be forced into riot mode' );

	const first = spawned[ 0 ], waypoints = [ [ - 668, - 216 ], [ - 700, - 300 ], [ - 682, - 308 ] ];
	centers.set( first.actor.id, waypoints[ 0 ] );
	behavior.update( context, 1 / 60 ); await Promise.resolve();
	assert.deepEqual( orders[ 0 ], { actor: first.actor, at: waypoints[ 1 ], options: { radius: 12 } } );
	centers.set( first.actor.id, waypoints[ 1 ] );
	behavior.update( context, 1 / 60 ); await Promise.resolve();
	assert.deepEqual( orders[ 1 ], { actor: first.actor, at: waypoints[ 2 ], options: { radius: 25 } } );
	context.observation = { actors: spawned.map( ( entry ) => ( { handle: entry.actor,
		center: entry.actor.id === first.actor.id ? waypoints[ 2 ] : [ 500, 500 ] } ) ), people: [] };
	behavior.onEvent( context, { type: 'command.applied', command: 'charge', at: waypoints[ 2 ] } );
	assert.deepEqual( modes, [ [ first.actor.id, 'riot' ] ], 'a group may enter riot mode after reaching its rally' );

} );

test( 'Government rallied groups enter the native adaptive defense director after route completion', async () => {

	const behavior = governmentRouteHooks(), timers = [], actors = [], centers = new Map(), orders = [], modes = [];
	const context: any = { time: 0, observation: {}, random: () => 0.9, signal: new AbortController().signal,
		timeline: { after: ( seconds, callback ) => timers.push( { seconds, callback } ) }, presentation: { notice() {}, markers() {} },
		spatial: { buildingGeometry: () => ( { position: [ - 600, - 330 ], footprints: [ [ - 620, - 350, - 580, - 350, - 580, - 310, - 620, - 310 ] ], exits: [ [ - 600, - 300 ] ] } ),
			sample: ( at ) => at, count: () => 0 },
		people: { members: () => [ { faction: 'protester', status: 'active', agitation: 0.8 } ] },
		crowd: { setMode: ( actor, mode ) => { modes.push( [ actor.id, mode ] ); return { status: 'completed' }; } },
		actors: { get: ( actor ) => ( { handle: actor, alive: 100, center: centers.get( actor.id ) ?? [ 1000, 1000 ] } ) },
		spawn: { crowd: ( options ) => { const actor = { id: options.id, kind: 'crowd', run: 1 }; actors.push( actor ); return { settled: Promise.resolve( { status: 'completed', value: actor } ) }; } },
		movement: { move: ( actor, at, options ) => { orders.push( { actor, at, options } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } } };
	behavior.start( context ); timers.find( ( timer ) => timer.seconds === 8 ).callback(); await Promise.resolve();
	centers.set( actors[ 0 ].id, [ - 668, - 216 ] ); context.time = 9; behavior.update( context ); await Promise.resolve();
	centers.set( actors[ 0 ].id, [ - 700, - 300 ] ); context.time = 10; behavior.update( context ); await Promise.resolve();
	centers.set( actors[ 0 ].id, [ - 682, - 308 ] ); context.time = 20; behavior.update( context ); await Promise.resolve();
	assert.equal( orders.length, 2 );
	context.time = 20.01; behavior.update( context ); await Promise.resolve();
	assert.equal( orders.length, 3 ); assert.equal( orders.at( - 1 ).options.radius, 10 );
	assert.deepEqual( modes, [ [ actors[ 0 ].id, 'riot' ] ] );
	assert.ok( orders.every( ( order ) => order.actor === actors[ 0 ] ), 'route-bound groups stay on their columns' );

} );

test( 'Government injury reactions apply capped same-group and half-strength neighbor deltas once per sample increase', () => {

	const behavior = governmentRouteHooks(), nudge = [], notices = [];
	const actors = [ [ 'hurt', 0 ], [ 'neighbor', 40 ], [ 'distant', 51 ] ].map( ( [ id, x ] ) => ( { handle: { id, kind: 'crowd', run: 1 }, center: [ x, 0 ] } ) );
	const people = [ ...Array.from( { length: 4 }, ( _, index ) => ( { handle: { id: `hurt-${index}` }, actor: actors[ 0 ].handle, faction: 'protester', status: 'active' } ) ),
		{ handle: { id: 'neighbor-person' }, actor: actors[ 1 ].handle, faction: 'protester', status: 'active' },
		{ handle: { id: 'distant-person' }, actor: actors[ 2 ].handle, faction: 'protester', status: 'active' } ];
	const observation = ( injured ) => ( { actors, people: people.map( ( person ) => person.actor === actors[ 0 ].handle
		? { ...person, status: injured ? 'injured' : 'active' } : person ) } );
	const context = { time: 20, observation: observation( false ), signal: new AbortController().signal,
		timeline: { after() { return { state: 'pending', cancel() {} }; } }, presentation: { markers() {}, notice: ( ...args ) => notices.push( args ) },
		crowd: { nudge: ( actor, options ) => { nudge.push( [ actor.id, options ] ); return { status: 'completed', value: { actor, people: 1 } }; }, setMode() { return { status: 'completed' }; } },
	};
	behavior.start( context );
	const first = { ...observation( true ), sequence: 2 };
	behavior.observe( context, first ); behavior.observe( context, { ...first, sequence: 3 } );
	assert.deepEqual( nudge, [ [ 'hurt', { agitation: 0.35, resolve: 0.05 } ], [ 'neighbor', { agitation: 0.175 } ] ] );
	assert.equal( notices.length, 1 );

} );

test( 'invalid score output fails without publishing or saving a malformed result', async () => {

	const { runtime, finished, failures } = fixture( scenario( { score: () => ( { stars: 4, lines: [] } ),
		objectives: [ survive( { id: 'hold', seconds: 1 } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' ); assert.equal( finished.length, 0 );
	assert.match( failures[ 0 ].message, /stars/ );

} );

test( 'a scoring callback exception fails the run before publishing a result', async () => {

	const { runtime, finished, failures } = fixture( scenario( { score: () => { throw new Error( 'score unavailable' ); },
		objectives: [ survive( { id: 'hold', seconds: 1 } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.equal( runtime.state, 'failed' ); assert.equal( finished.length, 0 );
	assert.match( failures[ 0 ].message, /scenario\.score: score unavailable/ );

} );

test( 'ordered outcome rules use first-match precedence and preserve default objective outcomes', async () => {

	const order = [];
	const first = defineOutcome( { id: 'breach', evaluate: ( context ) => {

		order.push( 'breach' );
		return context.time >= 1 ? { win: false, reason: 'Breached.' } : null;

	} } );
	const second = defineOutcome( { id: 'evacuation', evaluate: () => {

		order.push( 'evacuation' ); return { win: false, reason: 'Blocked.' };

	} } );
	const { runtime, finished } = fixture( scenario( { outcomes: [ first, second ], objectives: [ survive( { id: 'hold', seconds: 10 } ) ] } ) );
	await runtime.setup(); runtime.observe( {} ); runtime.start(); runtime.update( 1 );
	assert.deepEqual( order, [ 'breach' ] ); assert.equal( runtime.result.reason, 'Breached.' );
	assert.equal( finished.length, 1 );

} );

test( 'behavior crowd controls are owner-scoped and stop with their lifetime', async () => {

	let crowdContext, actor; const recalls = [];
	const attachment = defineBehavior( { id: 'crowd-control', create: () => ( { start( ctx ) { crowdContext = ctx; actor = ctx.actors.resolve( 'march' ); } } ) } )( { id: 'controller' } );
	const { runtime } = fixture( scenario( { setup( ctx ) { ctx.spawn.crowd( { id: 'march', at: 'square' } ); },
		behaviors: [ attachment ] } ), { spawn: async () => [], setCrowdMode: () => ( { status: 'completed' } ),
		nudgeCrowd: () => ( { status: 'completed', people: 1 } ), recallCrowd: ( groups, floor ) => { recalls.push( [ groups, floor ] ); return { status: 'completed', people: 2 }; } } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	assert.equal( crowdContext.crowd.setMode( actor, 'riot' ).status, 'completed' );
	assert.equal( crowdContext.crowd.recall( actor, 0.6 ).status, 'completed' ); assert.equal( recalls[ 0 ][ 1 ], 0.6 );
	crowdContext.complete();
	assert.throws( () => crowdContext.crowd.setMode( actor, 'hold' ), /cannot mutate while completed/ );
	assert.throws( () => crowdContext.crowd.nudge( actor, { agitation: 0.1 } ), /cannot mutate while completed/ );
	assert.throws( () => crowdContext.crowd.recall( actor, 0.6 ), /cannot mutate while completed/ );
	runtime.dispose();

} );

test( 'behavior player actions carry semantic selections and owned coach cards clear on stop', async () => {

	let received, card;
	const training = defineBehavior( { id: 'action-card', create: () => ( {
		start( ctx ) { ctx.presentation.coach( { chapter: '1. Controls', text: 'Select a squad.', step: 1, total: 2, onNext: () => ctx.complete() } ); },
		onAction: ( ctx, action ) => { received = action; },
	} ) } )( { id: 'training' } );
	const displayed = [];
	const { runtime } = fixture( scenario( { behaviors: [ training ] } ), { coach: ( value ) => displayed.push( value ) } );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	const actor = Object.freeze( { id: 'squad-1', kind: 'squad', run: runtime.run } );
	runtime.playerAction( Object.freeze( { type: 'select', how: 'click', selection: Object.freeze( [ actor ] ) } ) );
	assert.equal( received.type, 'select' ); assert.equal( received.selection[ 0 ], actor );
	runtime.playerAction( Object.freeze( { type: 'key', key: 'v', selection: Object.freeze( [] ) } ) );
	assert.equal( received.type, 'key' ); assert.equal( received.key, 'v' );
	card = displayed[ 0 ]; assert.equal( card.chapter, '1. Controls' ); card.onNext();
	assert.equal( runtime.behaviors.instances.get( 'training' ).state, 'completed' );
	assert.deepEqual( displayed.slice( 1 ), [ null ] ); runtime.dispose();

} );

test( 'Training preview advances the coach from semantic pan and selection actions', () => {

	const { definition, curriculum } = trainingCurriculum(), cards = [], locks = new Set( definition.initiallyLockedCommands ), actors = new Map( [
		[ 'squad-1', { id: 'squad-1', kind: 'squad', run: 1 } ], [ 'squad-2', { id: 'squad-2', kind: 'squad', run: 1 } ],
	] );
	let completed = false;
	const context = { actors: { resolve: ( id ) => actors.get( id ) }, locations: { get: () => [ - 20, - 20 ] },
		commands: { list: () => [ 'arrest', 'charge', 'gas', 'crew', 'water' ].filter( ( id ) => ! locks.has( id ) ).map( ( id ) => ( { id } ) ),
			lock: ( id ) => locks.add( id ), unlock: ( id ) => locks.delete( id ) },
		presentation: { coach: ( card ) => cards.push( card ) }, complete: () => { completed = true; }, signal: new AbortController().signal };
	curriculum.start( context );
	assert.deepEqual( [ ...locks ], definition.initiallyLockedCommands );
	assert.match( cards.at( - 1 ).chapter, /Camera/ );
	for ( let count = 0; count < 25; count ++ ) curriculum.onAction( context, { type: 'pan', selection: [] } );
	assert.match( cards.at( - 1 ).chapter, /Camera/ );
	assert.match( cards.at( - 1 ).text, /Scroll to zoom/ );
	curriculum.onAction( context, { type: 'zoom', selection: [] } ); curriculum.onAction( context, { type: 'zoom', selection: [] } );
	curriculum.onAction( context, { type: 'zoom', selection: [] } ); curriculum.onAction( context, { type: 'zoom', selection: [] } );
	assert.match( cards.at( - 1 ).chapter, /Selection/ );
	curriculum.onAction( context, { type: 'select', how: 'click', selection: [ actors.get( 'squad-1' ) ] } );
	assert.match( cards.at( - 1 ).text, /Shift-click Squad 2/ );
	cards.at( - 1 ).onSkip();
	assert.match( cards.at( - 1 ).text, /Escape/ );
	assert.equal( completed, false );

} );

test( 'Training final door test wins after the source hold duration with no sampled pressure', async () => {

	const { definition, curriculum } = trainingCurriculum(), cards = [], actors = new Map<any, any>(), unlocked = new Set( definition.initiallyLockedCommands );
	const operation = ( id, kind ) => {
		const actor = Object.freeze( { id, kind, run: 1 } ); actors.set( id, actor );
		return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
	};
	const setupContext = { locations: { get: ( id ) => id === 'square' ? [ - 40, - 10 ] : [ 0, 0 ] }, spatial: { walkable: ( at ) => at },
		presentation: { focus() {} }, spawn: { squad: ( options ) => operation( options.id, 'squad' ),
			vehicle: ( options ) => operation( options.id, 'vehicle' ), crowd: ( options ) => operation( options.id, 'crowd' ),
			bystanders: ( options ) => operation( options.id, 'crowd' ) } };
	await definition.setup( setupContext );
	let time = 0;
	const context = { get time() { return time; }, get metrics() { return { counters: { injuriesByPolice: 0 } }; }, signal: new AbortController().signal,
		actors: { resolve: ( id ) => actors.get( id ) }, commands: { list: () => [], lock: ( id ) => unlocked.add( id ), unlock: ( id ) => unlocked.delete( id ) },
		locations: { get: () => [ 0, 0 ] }, spatial: { count: () => 0, walkable: ( at ) => at },
		presentation: { coach: ( card ) => cards.push( card ), notice() {} },
		spawn: { squad: ( options ) => operation( options.id, 'squad' ), crowd: ( options ) => operation( options.id, 'crowd' ) }, complete() {} };
	curriculum.start( context );
	for ( let index = 0; index < 30 && ! cards.at( - 1 ).chapter.includes( 'Final Test' ); index ++ ) {
		const card = cards.at( - 1 ); ( card.onSkip ?? card.onNext )();
	}
	assert.match( cards.at( - 1 ).chapter, /Final Test/ );
	time = 30; curriculum.update( context, 30 );
	time = 240; curriculum.update( context, 210 );
	assert.match( cards.at( - 1 ).text, /Training complete/ );
	assert.deepEqual( definition.outcomes[ 0 ].evaluate( { time } ), { win: true, reason: 'The door held. Training complete.' } );
	cards.at( - 1 ).onNext();
	assert.equal( unlocked.size, 0 );

} );

test( 'Training final door test holds for 210 seconds and wins with three stars', async () => {

	const { definition, curriculum } = trainingCurriculum(), cards = [], actors = new Map<any, any>(), unlocked = new Set( definition.initiallyLockedCommands );
	const operation = ( id, kind ) => {
		const actor = Object.freeze( { id, kind, run: 1 } ); actors.set( id, actor );
		return { settled: Promise.resolve( { status: 'completed', value: actor } ) };
	};
	await definition.setup( { locations: { get: () => [ - 40, - 10 ] }, spatial: { walkable: ( at ) => at }, presentation: { focus() {} },
		spawn: { squad: ( options ) => operation( options.id, 'squad' ), vehicle: ( options ) => operation( options.id, 'vehicle' ),
			crowd: ( options ) => operation( options.id, 'crowd' ), bystanders: ( options ) => operation( options.id, 'crowd' ) } } );
	let time = 0, completed = false;
	const context = { get time() { return time; }, get metrics() { return { opinion: 60, counters: { injuriesByPolice: 0 } }; }, signal: new AbortController().signal,
		actors: { resolve: ( id ) => actors.get( id ) }, commands: { list: () => [], lock: ( id ) => unlocked.add( id ), unlock: ( id ) => unlocked.delete( id ) },
		locations: { get: () => [ 0, 0 ] }, spatial: { count: () => 0, walkable: ( at ) => at },
		presentation: { coach: ( card ) => cards.push( card ), notice() {} },
		spawn: { squad: ( options ) => operation( options.id, 'squad' ), crowd: ( options ) => operation( options.id, 'crowd' ) }, complete: () => { completed = true; } };
	curriculum.start( context );
	for ( let index = 0; index < 30 && ! cards.at( - 1 ).chapter.includes( 'Final Test' ); index ++ ) {
		const card = cards.at( - 1 ); ( card.onSkip ?? card.onNext )();
	}
	time = 30; curriculum.update( context, 30 );
	time = 239.99; curriculum.update( context, 209.99 );
	assert.equal( definition.outcomes[ 0 ].evaluate( { time } ), null );
	time = 240; curriculum.update( context, 0.01 );
	assert.deepEqual( definition.outcomes[ 0 ].evaluate( { time } ), { win: true, reason: 'The door held. Training complete.' } );
	const scoring = definition.score( { win: true, metrics: { opinion: 60, counters: { injuriesByPolice: 0, arrests: 0 } } } );
	assert.equal( scoring.stars, 3 );
	cards.at( - 1 ).onNext();
	assert.equal( completed, true );
	assert.equal( cards.at( - 1 ), null );

} );
test( 'scenario opinion policy defaults to the base mission model and maps overrides onto the host weights', async () => {

	const { Mission } = await import( '../src/game/mission.ts' );
	const { SitInMission } = await import( '../src/game/missions/sitin.ts' );
	const { scenarioMission } = await import( '../src/game/scenarios/mission.ts' );
	const base = scenario();
	assert.deepEqual( { initial: base.opinion.initial, gas: base.opinion.gas, water: base.opinion.water }, { initial: 60, gas: - 2, water: - 2 } );
	assert.deepEqual( scenarioMission( base ).prototype.opinionWeights(), Mission.prototype.opinionWeights() );
	const sitin = scenario( { opinion: { initial: 55, gas: - 6, water: - 3.5,
		weights: { injuriesByPolice: - 0.7, officersInjured: 0.2, arrests: - 0.03, sitterArrests: - 0.1, otherInjuries: - 0.05 } } } );
	assert.deepEqual( scenarioMission( sitin ).prototype.opinionWeights(), SitInMission.prototype.opinionWeights() );
	assert.equal( scenario( { opinion: { weights: { arrests: - 1 } } } ).opinion.weights.injuriesByPolice, - 0.5 );
	assert.ok( Object.isFrozen( sitin.opinion ) && Object.isFrozen( sitin.opinion.weights ) );
	assert.throws( () => scenario( { opinion: { initial: 101 } } ), /opinion\.initial/ );
	assert.throws( () => scenario( { opinion: { gas: 1 } } ), /opinion\.gas/ );
	assert.throws( () => scenario( { opinion: { weights: { tension: 1 } } } ), /unsupported field/ );

} );

test( 'scenario HUD rows replace the default objective rows, clamp bars and fail the run on malformed rows', async () => {

	const good = fixture( scenario( { hud: ( { time } ) => [ { label: 'Handed over', value: 1.5, text: `${time}`, state: 'ok' }, { label: 'Tension', value: - 1, text: 'calm', state: 'warn', invert: true } ] } ) );
	await good.runtime.setup(); good.runtime.observe( {} ); await good.runtime.start(); good.runtime.update( 2 );
	assert.deepEqual( good.runtime.objectives(), [ { label: 'Handed over', value: 1, text: '2', state: 'ok', invert: false }, { label: 'Tension', value: 0, text: 'calm', state: 'warn', invert: true } ] );
	const bad = fixture( scenario( { hud: () => [ { label: 'Oops', value: 0.5, text: 'x', state: 'great' } ] } ) );
	await bad.runtime.setup(); bad.runtime.observe( {} ); await bad.runtime.start();
	assert.equal( bad.runtime.objectives()[ 0 ].label, 'Hold position' );
	assert.equal( bad.runtime.state, 'failed' ); assert.match( bad.failures[ 0 ].message, /scenario\.hud: scenario\.hud\.0\.state/ );
	assert.throws( () => scenario( { hud: 'rows' } ), /scenario\.hud/ );

} );
