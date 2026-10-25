import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceBuilding } from '../src/game/scenarios/building.ts';
import { DefendMission } from '../src/game/sdk/templates/defend.ts';
import { SpatialHost, mapTarget } from '../src/game/scenarios/spatial.ts';
import { defineOutcome, defineScenario, holdBuilding, target } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';
import defenseScenario from '../examples/defense-scenario.ts';
import { DefendAssembly } from '../src/game/missions/defend.ts';
import * as sdk from '../src/game/scenarios/index.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';
import { FACTION } from '../src/sim/crowd.ts';
import { scenarioMission } from '../src/game/scenarios/mission.ts';
import { Mission } from '../src/game/mission.ts';

test( 'SDK arrested leaders trigger the native one-shot group morale reaction', () => {

	const nativeWrites = [], sdkWrites = [];
	const groups = () => [ { id: 1, faction: FACTION.PROTESTER, leaderState: 'arrested' },
		{ id: 2, faction: FACTION.PROTESTER, leaderDetained: true }, { id: 3, faction: FACTION.POLICE, leaderDetained: true },
		{ id: 4, faction: FACTION.PROTESTER, leaderState: 'active' } ];
	const native: any = { t: 0, resources: {}, timers: [], shelters: [], world: { intel: null, groups: groups() }, side: 'police', tick() {},
		crowd: { setGroup: ( ...args ) => nativeWrites.push( args ) } };
	const mission: any = { world: { groups: groups() }, crowd: { setGroup: ( ...args ) => sdkWrites.push( args ) } };
	const engine = new ScenarioEngine( mission );
	for ( let update = 0; update < 2; update ++ ) { Mission.prototype.update.call( native, 0, null ); engine.updateAmbient( 0 ); }
	assert.deepEqual( sdkWrites, nativeWrites );
	assert.deepEqual( nativeWrites, [ [ 1, { morale: 0.15 } ], [ 2, { morale: 0.15 } ] ] );

} );

test( 'sampled placement validates options, owns its RNG and forwards native placement policy', () => {

	const calls = [], definition = sdk.defineScenario( { id: 'placement', title: 'Placement', subtitle: 'Placement', brief: 'Placement.', seed: 42,
		objectives: [ sdk.survive( { id: 'hold', seconds: 1 } ) ] } );
	const engine = new ScenarioEngine( { world: { spot: ( ...args ) => { calls.push( args.slice( 0, 4 ) ); return [ args[ 0 ] + args[ 4 ](), args[ 1 ] ]; } } } );
	const adapter = { sampleWalkable: engine.sampleWalkable.bind( engine ) };
	const first = new ScenarioRuntime( definition, adapter ), second = new ScenarioRuntime( definition, adapter );
	const result = first.context.spatial.sample( [ 1, 2 ], { radius: 8, streetOnly: false } );
	assert.deepEqual( result, second.context.spatial.sample( [ 1, 2 ], { radius: 8, streetOnly: false } ) );
	assert.deepEqual( calls[ 0 ], [ 1, 2, 8, false ] );
	assert.ok( Object.isFrozen( result ) );
	first.context.spatial.sample( [ 1, 2 ], { radius: 4 } );
	assert.deepEqual( calls.at( - 1 ), [ 1, 2, 4, true ] );
	for ( const options of [ { radius: 0 }, { radius: Infinity }, { radius: 1001 }, { radius: 4, streetOnly: 1 }, { radius: 4, extra: true } ] ) {

		assert.throws( () => first.context.spatial.sample( [ 0, 0 ], options ), /spatial.sample/ );

	}
	assert.equal( calls.length, 3 );

} );

test( 'containing-building footprints are detached semantic geometry and reject malformed host rings', () => {

	const ring = [ 0, 0, 10, 0, 10, 10, 0, 10 ];
	const engine = new ScenarioEngine( { city: { buildings: [ { p: [ ring ] } ] } } );
	const runtime = new ScenarioRuntime( sdk.defineScenario( { id: 'footprints', title: 'Footprints', subtitle: 'Footprints', brief: 'Footprints.',
		objectives: [ sdk.survive( { id: 'hold', seconds: 1 } ) ] } ), { footprint: engine.footprint.bind( engine ) } );
	const copy = runtime.context.spatial.footprint( [ 5, 5 ] ); ring[ 0 ] = - 1;
	assert.equal( copy[ 0 ], 0 ); assert.ok( Object.isFrozen( copy ) );
	assert.equal( runtime.context.spatial.footprint( [ 100, 100 ] ), null );
	runtime.adapter.footprint = () => [ 0, NaN ]; assert.throws( () => runtime.context.spatial.footprint( [ 5, 5 ] ), /invalid outer ring/ );

} );

test( 'mission route geometry is copied and visibility queries have bounded range', () => {

	const route = [ [ 0, 0 ], [ 10, 0 ] ], engine = new ScenarioEngine( { city: { route, ring: [ [ 0, 0, 20, 0 ] ] }, world: { cost: () => 12, sdf: ( x ) => x > 4 && x < 6 ? - 1 : 5 } } );
	const runtime = new ScenarioRuntime( sdk.defineScenario( { id: 'route-geometry', title: 'Route', subtitle: 'Route', brief: 'Route.', objectives: [ sdk.survive( { id: 'hold', seconds: 1 } ) ] } ), engine );
	const copy = runtime.context.spatial.route(); route[ 0 ][ 0 ] = 99; assert.equal( copy[ 0 ][ 0 ], 0 ); assert.ok( Object.isFrozen( copy[ 0 ] ) );
	assert.deepEqual( runtime.context.spatial.carriageways(), [ [ [ 0, 0 ], [ 20, 0 ] ] ] );
	assert.equal( runtime.context.spatial.visible( [ 0, 0 ], [ 10, 0 ] ), false ); assert.equal( runtime.context.spatial.visible( [ 0, 0 ], [ 3, 0 ] ), true );
	assert.throws( () => runtime.context.spatial.visible( [ 0, 0 ], [ 1001, 0 ] ), /range/ );

} );

test( 'Assembly does not enable the Government-only force and injury outrage policy', () => {

	const definition = ( defenseScenario as any )( sdk );
	assert.ok( ! DefendAssembly.outrage );
	assert.deepEqual( definition.behaviors.map( ( behavior ) => behavior.id ), [ 'arrivals' ] );

} );

test( 'Assembly deployment and all waves match the native setup and spawn policy', async () => {

	const nativeSquads = [], nativeVehicles = [], nativeWaves = [], sdkSquads = [], sdkVehicles = [], sdkWaves = [];
	const nativeNotices = [], sdkNotices = [], nativeTimers = [];
	const base = { pos: [ 0, 0 ], radius: 20, poly: [ [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ] ],
		exits: [ [ 0, 10 ], [ 0, - 10 ], [ 10, 0 ] ] };
	const places = { 'Trg republike': [ 0, 90 ], 'Kongresni trg': [ 200, 0 ], 'Prešernov trg': [ 300, 0 ] };
	const marks = { 'PU Ljubljana': [ 400, 0 ], 'Ministrstvo za finance': [ 500, 0 ] };
	const sample = ( x, y, radius, streetOnly = true ) => [ x + radius / 10, y + ( streetOnly ? 1 : - 1 ) * radius / 10 ];
	const world = { groups: [], places, marks, exits: async () => {}, spot: sample,
		patrols: { snap: ( x, y ) => [ x, y ], add: async ( options ) => nativeVehicles.push( options ) },
		squad: async ( options ) => { nativeSquads.push( options ); return options; },
		bloc: async ( options ) => { nativeWaves.push( options ); return Array.from( { length: Math.ceil( options.n / options.groupSize ) }, () => ( {} ) ); } };
	const native: any = { constructor: DefendAssembly, world, city: { targets: { 'Državni zbor': base } }, t: 0,
		setZones() {}, bystanders: async ( people ) => { assert.equal( people, 2200 ); }, event: ( ...args ) => nativeNotices.push( args ),
		after: ( seconds, callback ) => nativeTimers.push( { seconds, callback } ) };
	await DefendMission.prototype.setup.call( native );
	const geometry = { name: 'Državni zbor', position: native.T.pos, radius: native.T.radius,
		footprints: native.T.poly.map( ( polygon ) => polygon[ 0 ] ), exits: native.T.exits };
	const aliases = { square: 'Trg republike', kongresni: 'Kongresni trg', preseren: 'Prešernov trg', station: 'PU Ljubljana', finance: 'Ministrstvo za finance' };
	let director;
	const definition = ( defenseScenario as any )( { ...sdk, defineBehavior: ( options ) => {

		director = options.create(); return sdk.defineBehavior( options );

	} } );
	const timers = [], context: any = { time: 0, random: () => 0.2, signal: new AbortController().signal,
		locations: { get: ( id ) => places[ aliases[ id ] ] ?? marks[ aliases[ id ] ] },
		spatial: { buildingGeometry: () => geometry, sample: ( at, options ) => sample( at[ 0 ], at[ 1 ], options.radius, options.streetOnly ) },
		presentation: { focus() {}, markers() {}, notice: ( ...args ) => sdkNotices.push( args ) }, timeline: { after: ( seconds, callback ) => timers.push( { seconds, callback } ) },
		spawn: { squad: ( options ) => sdkSquads.push( options ), vehicle: ( options ) => sdkVehicles.push( options ),
			bystanders: ( options ) => assert.equal( options.people, 2200 ), crowd: ( options ) => {

				sdkWaves.push( options );
				return { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) };

			} } };
	definition.setup( context ); director.start( context );
	DefendMission.prototype.start.call( native );
	nativeTimers.at( - 1 ).callback(); timers.at( - 1 ).callback();
	assert.deepEqual( sdkNotices, nativeNotices );
	assert.deepEqual( sdkSquads.map( ( squad ) => ( { at: squad.at, people: squad.people } ) ), nativeSquads.map( ( squad ) => ( { at: squad.at, people: squad.n } ) ) );
	assert.deepEqual( sdkVehicles.map( ( vehicle ) => vehicle.at ), nativeVehicles.map( ( vehicle ) => vehicle.at ) );
	assert.equal( sdkSquads.reduce( ( total, squad ) => total + squad.people, 0 ), 360 );
	assert.deepEqual( Object.fromEntries( Object.entries( definition.resources ).map( ( [ id, resource ] ) => [ id, ( resource as any ).capacity ] ) ),
		Object.fromEntries( Object.entries( native.resources ).map( ( [ id, resource ] ) => [ id, ( resource as any ).max ] ) ) );
	assert.equal( definition.resources.reinforce.cooldown, 0 );
	const originalRandom = Math.random;
	try {

		Math.random = context.random;
		for ( const [ index, wave ] of DefendAssembly.waves.entries() ) {

			native.t = context.time = wave.t;
			nativeTimers[ index * 2 ].callback();
			timers.find( ( timer ) => timer.seconds === Math.max( 0, wave.t - 30 ) ).callback();
			await DefendMission.prototype.spawnWave.call( native, { ...wave } );
			const start = sdkWaves.length;
			timers.find( ( timer ) => timer.seconds === wave.t ).callback();
			await Promise.resolve();
			const parts = sdkWaves.slice( start ), expected = nativeWaves.at( - 1 );
			assert.equal( parts.reduce( ( total, part ) => total + part.people, 0 ), expected.n );
			for ( const part of parts ) {

				assert.deepEqual( { at: part.at, goal: part.goal, goalRadius: part.goalRadius, agitation: part.agitation, morale: part.morale, bikes: part.bikes, spread: part.spread },
					{ at: expected.at, goal: expected.goal, goalRadius: expected.goalR, agitation: expected.agitation, morale: expected.morale, bikes: expected.bikes, spread: expected.spread } );

			}
			assert.deepEqual( sdkNotices, nativeNotices );

		}

	} finally { Math.random = originalRandom; }
	assert.deepEqual( nativeWaves.map( ( wave ) => wave.n ), [ 2200, 1800, 450, 1100, 2600, 1500 ] );

} );

test( 'Assembly wave markers match native positions, countdowns and delayed-spawn removal for every wave', async () => {

	let director;
	const definition = ( defenseScenario as any )( { ...sdk, defineBehavior: ( options ) => { director = options.create(); return sdk.defineBehavior( options ); } } );
	const runtime = new ScenarioRuntime( sdk.defineScenario( { id: 'marker-parity', title: 'Markers', subtitle: 'Markers', brief: 'Markers.',
		objectives: [ sdk.survive( { id: 'hold', seconds: 720 } ) ] } ), {} );
	runtime.state = 'running';
	const positions = { kongresni: [ 100, 0 ], preseren: [ 200, 0 ], station: [ 300, 0 ], finance: [ 400, 0 ] };
	for ( const [ id, at ] of Object.entries( positions ) ) runtime.locations.set( id, at );
	const timers = [], sdkDraws = [], nativeDraws = [], sourceWaves = DefendAssembly.waves.map( ( wave ) => ( { ...wave, spawned: false } ) );
	let pending;
	const context = { get time() { return runtime.time; }, observation: null, random: () => 0,
		signal: new AbortController().signal, locations: { get: ( id ) => positions[ id ] ?? [ 0, 100 ] },
		spatial: { buildingGeometry: () => ( { position: [ 0, 0 ], footprints: [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ], exits: [] } ), sample: ( at ) => at },
		presentation: { markers: ( markers ) => runtime.context.presentation.markers( markers ), notice() {} },
		timeline: { after: ( seconds, callback ) => timers.push( { seconds, callback } ) },
		spawn: { crowd: ( options ) => ( { settled: pending.then( () => ( { status: 'completed', value: { id: options.id } } ) ) } ) } };
	director.start( context );
	const native: any = { t: 0, breach: 0, T: { pos: [ 0, 0 ], radius: 20, exits: [] }, constructor: DefendAssembly,
		nextWave: () => sourceWaves.find( ( wave ) => ! wave.spawned ),
		world: { places: Object.fromEntries( Object.entries( SOURCE_ALIASES ).map( ( [ alias, name ] ) => [ name, positions[ alias ] ] ) ), marks: {} },
		drawZone: ( ...args ) => nativeDraws.push( args ) };
	const Candidate = scenarioMission( definition ), overlay = {};
	const compareAt = ( time ) => {

		runtime.time = native.t = time; director.update( context ); sdkDraws.length = nativeDraws.length = 0;
		DefendMission.prototype.draw.call( native, overlay );
		Candidate.prototype.draw.call( { runtime, drawZone: ( ...args ) => sdkDraws.push( args ), drawCustody() {} } as any, overlay );
		assert.deepEqual( sdkDraws, nativeDraws.filter( ( args ) => args[ 3 ] === 40 ), `marker rendering at ${time}s` );

	};
	for ( const wave of sourceWaves ) {

		if ( wave.t >= 60 ) { compareAt( wave.t - 60 ); assert.equal( sdkDraws.length, 0 ); compareAt( wave.t - 60 + 0.001 ); }
		compareAt( Math.max( 0, wave.t - 1 ) ); assert.equal( sdkDraws.length, 1 );
		let releaseSpawn;
		pending = new Promise<void>( ( resolve ) => { releaseSpawn = resolve; } );
		runtime.time = wave.t; timers.find( ( timer ) => timer.seconds === wave.t ).callback();
		compareAt( wave.t + 0.5 ); assert.equal( sdkDraws[ 0 ][ 5 ], `${wave.label} · 0:00` );
		releaseSpawn(); await new Promise( ( resolve ) => setImmediate( resolve ) ); wave.spawned = true;
		compareAt( wave.t + 0.5 );

	}
	assert.deepEqual( runtime.markers(), [] ); runtime.dispose();

} );

const SOURCE_ALIASES = { kongresni: 'Kongresni trg', preseren: 'Prešernov trg', station: 'PU Ljubljana', finance: 'Ministrstvo za finance' };

test( 'Assembly director matches native cadence, commitment, riot installation and calm return', async () => {

	let director;
	( defenseScenario as any )( { ...sdk, defineBehavior: ( options ) => { director = options.create(); return sdk.defineBehavior( options ); } } );
	const timers = [], targets = [], handles = [], sdkMoves = [], nativeMoves = [], sdkModes = [], nativeModes = [];
	let agitation = 0.7;
	const rally = [ 0, 100 ], exits = [ [ 0, 30 ], [ 0, - 30 ] ];
	const context: any = { time: 0, observation: {}, random: () => 0.9, signal: new AbortController().signal,
		locations: { get: ( id ) => id === 'square' ? rally : [ 500, 0 ] },
		spatial: { buildingGeometry: () => ( { position: [ 0, 0 ], footprints: [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ], exits } ),
			sample: ( at ) => { targets.push( at ); return at; }, count: () => 0 },
		timeline: { after: ( seconds, callback ) => timers.push( { seconds, callback } ) }, presentation: { notice() {}, markers() {} },
		spawn: { crowd: ( options ) => {

			const handle = { id: options.id }; handles.push( handle );
			return { settled: Promise.resolve( { status: 'completed', value: handle } ) };

		} },
		actors: { get: ( handle ) => handle === handles[ 0 ] ? { center: [ 100, 0 ] } : null },
		people: { members: () => [ { status: 'active', agitation } ] },
		movement: { move: ( handle, at, options ) => { sdkMoves.push( [ ...at, options.radius ] ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		crowd: { setMode: () => sdkModes.push( 'riot' ) } };
	director.start( context );
	context.time = 8; timers.find( ( timer ) => timer.seconds === 8 ).callback(); await Promise.resolve();
	const group: any = { center: [ 100, 0 ], goalKind: 'rally', agitation, label: 'Students' };
	const native: any = { constructor: DefendAssembly, t: 0, duration: 720, breach: 0, evac: 0, T: { exits }, flags: {},
		targets: [ ...targets, ...exits ], rallyPoint: rally, event() {}, end() {}, facadeCount: () => 0, zone: () => 0,
		world: { intel: {}, groupsOf: ( faction ) => faction === FACTION.PROTESTER ? [ group ] : [], countNear: () => 0,
			march: async ( groups, ...args ) => { nativeMoves.push( args ); }, setMode: () => nativeModes.push( 'riot' ) } };
	const originalRandom = Math.random;
	try {

		Math.random = context.random;
		for ( const time of [ 20, 20.1, 40, 40.1, 40.2, 61, 100, 100.1, 200, 200.1 ] ) {

			native.t = context.time = time;
			agitation = group.agitation = time >= 40.2 ? 0.1 : 0.7;
			DefendMission.prototype.tick.call( native, 0 ); director.update( context ); await Promise.resolve();
			assert.deepEqual( sdkMoves, nativeMoves, `movement at ${time}s` );
			assert.deepEqual( sdkModes, nativeModes, `riot at ${time}s` );

		}

	} finally { Math.random = originalRandom; }
	assert.deepEqual( sdkMoves.at( - 1 ), [ ...rally, 35 ] );

} );

test( 'Assembly scoring and ordered terminal reasons match the native mission', () => {

	const definition = ( defenseScenario as any )( sdk );
	for ( const win of [ false, true ] ) for ( const opinion of [ 44.9, 45, 70 ] ) for ( const injuries of [ 25, 26 ] ) {

		const counters = { injByPolice: injuries, injPolice: 4, arrested: 5, gas: 2 };
		const expected = DefendMission.prototype.score.call( { opinion, counters } as any, win );
		assert.deepEqual( definition.score( { win, metrics: { opinion, escalation: 0,
			counters: { injuriesByPolice: injuries, officersInjured: 4, arrests: 5, gasUsed: 2 } } } ), expected );

	}
	for ( const [ breach, evacuation, time ] of [ [ 1, 1, 720 ], [ 0, 1, 720 ], [ 0, 0, 720 ] ] ) {

		let expected;
		const native: any = { constructor: DefendAssembly, world: { intel: null, groupsOf: () => [] }, T: { exits: [ [] ] }, t: time, duration: 720,
			breach, evac: evacuation, flags: {}, facadeCount: () => 0, zone: () => 0, event() {}, end: ( win, reason ) => { expected = { win, reason }; } };
		DefendMission.prototype.tick.call( native, 0 );
		const outcome = definition.outcomes.map( ( rule ) => rule.evaluate( { building: { breach, evacuation } } ) ).find( Boolean )
			?? { win: true, reason: definition.objectives[ 0 ].reason };
		assert.deepEqual( outcome, expected );

	}

} );

test( 'owned bystanders retarget existing wander fields and stop after release or runtime pause', async () => {

	const changes = [], group = { faction: FACTION.BYSTANDER, members: [ 0 ], layer: 3 };
	const world = { setLayer: ( actor, layer ) => changes.push( [ actor, layer ] ), flow: { release() {} } };
	const engine = new ScenarioEngine( { world, crowd: { setFaction() {} }, game: { selected: [] }, runtime: { random: () => 0 } } );
	engine.wanderGroups.set( group, [ 3, 4 ] );
	const runtime = new ScenarioRuntime( sdk.defineScenario( { id: 'ambient', title: 'Ambient', subtitle: 'Ambient', brief: 'Ambient.',
		objectives: [ sdk.survive( { id: 'hold', seconds: 100 } ) ] } ), { updateAmbient: engine.updateAmbient.bind( engine ) } );
	engine.mission.runtime = runtime;
	runtime.random = () => 0;
	runtime.observation = { actors: [], people: [] }; runtime.state = 'briefing'; await runtime.start();
	runtime.update( 1 ); assert.equal( changes.length, 1 ); assert.equal( changes[ 0 ][ 1 ], 3 );
	runtime.pause( true ); runtime.update( 1 ); assert.equal( changes.length, 1 );
	runtime.pause( false ); engine.release( [ group ] );
	assert.equal( engine.wanderGroups.size, 0 ); runtime.update( 1 ); assert.equal( changes.length, 1 );

} );

test( 'Assembly pressure warnings and resets match native notices', () => {

	let director;
	( defenseScenario as any )( { ...sdk, defineBehavior: ( options ) => { director = options.create(); return sdk.defineBehavior( options ); } } );
	let measurement = { facade: 0, exits: [ 0, 0 ] };
	const nativeNotices = [], sdkNotices = [], geometry = { position: [ 0, 0 ], exits: [ [ 0, 30 ], [ 0, - 30 ] ] };
	const context = { spatial: { buildingGeometry: () => geometry }, presentation: { notice: ( ...args ) => sdkNotices.push( args ) } };
	const native: any = { constructor: DefendAssembly, world: { groupsOf: () => [], intel: null }, T: { pos: geometry.position, exits: geometry.exits },
		t: 0, duration: 720, breach: 0, evac: 0, flags: {}, event: ( ...args ) => nativeNotices.push( args ), end() {},
		facadeCount: () => measurement.facade, zone: ( index ) => measurement.exits[ index - 1 ] };
	let current = { breach: 0, evacuation: 0, blocked: [ false, false ] };
	for ( const [ facade, exits, seconds ] of [ [ 100, [ 20, 0 ], 21 ], [ 0, [ 12, 0 ], 1 ], [ 0, [ 11, 0 ], 29 ], [ 100, [ 20, 0 ], 21 ] ] as [ number, number[], number ][] ) {

		measurement = { facade, exits };
		const previous = current; current = advanceBuilding( current, measurement, seconds );
		native.t += seconds; DefendMission.prototype.tick.call( native, seconds );
		director.onEvent( context, { type: 'building.pressure', target: 'assembly', previous, current } );
		assert.deepEqual( sdkNotices, nativeNotices );

	}

} );

test( 'building pressure events expose frozen states before outcomes and skip unavailable measurements', async () => {

	const runtime = buildingRuntime( 'calm' ), events = [];
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	runtime.behaviors.dispatch = ( name, event ) => { if ( name === 'onEvent' ) events.push( event ); };
	runtime.update( 1 );
	assert.equal( events.length, 1 ); assert.equal( events[ 0 ].type, 'building.pressure' );
	assert.equal( events[ 0 ].target, 'building' );
	assert.ok( Object.isFrozen( events[ 0 ].previous ) ); assert.ok( Object.isFrozen( events[ 0 ].current.blocked ) );
	runtime.spatial.measureBuilding = () => null; runtime.update( 1 ); assert.equal( events.length, 1 ); runtime.dispose();

} );

test( 'building pressure and exit hysteresis match the existing defense template over a full timeline', () => {

	let input = { facade: 0, exits: [ 0, 0 ] };
	const reference: any = { constructor: {}, world: { groupsOf: () => [], intel: null }, T: { exits: [ [], [] ] },
		t: 0, duration: 720, breach: 0, evac: 0, flags: {}, event() {}, end() {},
		facadeCount: () => input.facade, zone: ( index ) => input.exits[ index - 1 ] };
	let current = { breach: 0, evacuation: 0, blocked: [ false, false ] };
	for ( let step = 0; step < 720 * 4; step ++ ) {

		const phase = Math.floor( step / 80 ) % 6;
		input = [ { facade: 21, exits: [ 20, 20 ] }, { facade: 200, exits: [ 15, 12 ] },
			{ facade: 0, exits: [ 11, 19 ] }, { facade: 20, exits: [ 20, 0 ] },
			{ facade: 40, exits: [ 30, 30 ] }, { facade: 0, exits: [ 0, 0 ] } ][ phase ];
		reference.t += 0.25; DefendMission.prototype.tick.call( reference, 0.25 );
		current = advanceBuilding( current, input, 0.25 );
		assert.equal( current.breach, reference.breach ); assert.equal( current.evacuation, reference.evac );
		assert.deepEqual( current.blocked, reference.blocked );

	}

} );

test( 'building pressure enforces capped breach, asymmetric decay and exact exit thresholds', () => {

	let state = { breach: 0, evacuation: 0, blocked: [ false, false ] };
	state = advanceBuilding( state, { facade: 10000, exits: [ 20, 20 ] }, 1 );
	assert.equal( state.breach, 0.025 ); assert.equal( state.evacuation, 1 / 45 );
	state = advanceBuilding( state, { facade: 0, exits: [ 12, 12 ] }, 1 );
	assert.deepEqual( state.blocked, [ true, true ] );
	state = advanceBuilding( state, { facade: 0, exits: [ 11, 19 ] }, 1 );
	assert.deepEqual( state.blocked, [ false, true ] );
	assert.throws( () => advanceBuilding( state, { facade: 0, exits: new Array( 2 ) }, 1 ), /dense/ );

} );

test( 'spatial defense measurements use outer footprints, agitation and prepared exits', () => {

	const building = mapTarget( { name: 'Building', position: [ 0, 0 ], radius: 15,
		footprints: [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ], exits: [ [ 0, 10 ], [ 0, - 10 ] ] }, 'test.target' );
	const handle = {};
	const person = ( position, agitation = 0.5, faction = 'protester', status = 'active' ) => ( { position, agitation, faction, status } );
	const runtime = { actors: new Map( [ [ 'crowd', { handle, backend: {} } ] ] ), adapter: { snapRoad: ( at ) => at }, location: ( at ) => at,
		observation: { actors: [ { handle } ], people: [ person( [ 0, 11 ] ), person( [ 0, 11 ], 0.2 ),
			person( [ 0, 11 ], 0.8, 'police' ), person( [ 0, 11 ], 0.8, 'protester', 'injured' ), person( [ 0, 30 ] ) ] } };
	const spatial = new SpatialHost( runtime ); spatial.targets.set( 'building', building );
	assert.deepEqual( spatial.prepareBuilding( 'building' ).exits, [ [ 0, 30 ], [ 0, - 30 ] ] );
	assert.deepEqual( spatial.buildingGeometry( 'building', { 1: [ 4, - 5 ] } ).exits, [ [ 0, 30 ], [ 4, - 5 ] ] );
	const measured = spatial.measureBuilding( 'building' );
	assert.deepEqual( measured, { facade: 1, exits: [ 1, 0 ] } );
	assert.equal( spatial.measureBuilding( 'building' ), measured );
	assert.equal( spatial.count( { at: [ 0, 11 ], radius: 3, faction: 'protester' } ), 2 );
	assert.equal( spatial.count( { at: [ 0, 11 ], radius: 3, faction: 'protester', minimumAgitation: 0.4 } ), 1 );
	runtime.observation.actors = [];
	assert.equal( spatial.measureBuilding( 'building' ), null );
	assert.equal( spatial.count( { at: [ 0, 0 ], radius: 20 } ), null );
	assert.throws( () => spatial.prepareBuilding( 'building', { 2: [ 0, 0 ] } ), /does not exist/ );
	assert.throws( () => { building.footprints[ 0 ][ 0 ] = 9; }, TypeError );

} );

function buildingRuntime( mode, seconds = 720, outcomes = [] ) {

	return new ScenarioRuntime( defineScenario( { id: 'building-proof', title: 'Building', subtitle: 'Proof', brief: 'Proof.', outcomes,
		locations: { building: target( 'Building' ) }, setup: ( ctx ) => ctx.spawn.crowd( { id: 'crowd', at: 'building', people: 100 } ),
		objectives: [ holdBuilding( { id: 'hold', target: 'building', seconds } ) ] } ), {
		target: () => ( { name: 'Building', position: [ 0, 0 ], radius: 15, footprints: [ [ - 10, - 10, 10, - 10, 10, 10, - 10, 10 ] ], exits: [ [ 0, 10 ], [ 0, - 10 ] ] } ),
		snapRoad: ( at ) => at, spawn: async () => ( {} ), release() {},
		readActor: () => mode === 'unavailable' ? null : ( { alive: 100, center: [ 0, 0 ] } ),
		readPeople: () => Array.from( { length: 100 }, ( _, index ) => ( { key: index, backend: index, leader: index === 0,
			status: 'active', faction: 'protester', agitation: 0.5,
			position: mode === 'breach' ? [ 0, 11 ] : mode === 'exits' ? [ 0, index < 50 ? 30 : - 30 ] : [ 100, 100 ],
		} ) ),
	} );

}

test( 'building objective loses on breach or blocked exits, wins only for a safe full hold', async () => {

	for ( const [ mode, seconds, win, reason ] of [ [ 'breach', 40, false, /forced/ ], [ 'exits', 45, false, /Every exit/ ], [ 'calm', 720, true, /held/ ] ] as [ string, number, boolean, RegExp ][] ) {

		const runtime = buildingRuntime( mode, seconds );
		await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( seconds );
		assert.equal( runtime.result.win, win ); assert.match( runtime.result.reason, reason );
		assert.equal( runtime.objectives().length, 3 ); runtime.dispose();

	}

} );

test( 'ordered outcome rules prioritize a facade breach over simultaneous exit failure', async () => {

	const outcomes = [
		defineOutcome( { id: 'breach-first', evaluate: ( { building } ) => building?.breach >= 1 ? { win: false, reason: 'Breach priority.' } : null } ),
		defineOutcome( { id: 'exit-second', evaluate: ( { building } ) => building?.evacuation >= 1 ? { win: false, reason: 'Exit priority.' } : null } ),
	];
	const runtime = buildingRuntime( 'calm', 60, outcomes );
	await runtime.setup(); runtime.observe( {} ); await runtime.start();
	runtime.spatial.measureBuilding = () => ( { facade: 200, exits: [ 40, 40 ] } );
	runtime.update( 60 );
	assert.equal( runtime.result.win, false ); assert.equal( runtime.result.reason, 'Breach priority.' );
	runtime.dispose();

} );

test( 'unavailable building observations freeze pressure and cannot award timeout victory', async () => {

	const runtime = buildingRuntime( 'unavailable' );
	await runtime.setup(); runtime.observe( {} ); await runtime.start(); runtime.update( 10 );
	assert.equal( runtime.buildingState.breach, 0 ); assert.equal( runtime.result, null );
	runtime.update( 710 ); assert.equal( runtime.state, 'failed' ); assert.equal( runtime.result, null );
	assert.match( runtime.error.message, /observation unavailable/ ); runtime.dispose();

} );

test( 'missing targets fail preflight without running setup', async () => {

	const runtime = buildingRuntime( 'calm' );
	let spawns = 0;
	runtime.adapter.target = () => null; runtime.adapter.spawn = () => { spawns ++; };
	await assert.rejects( runtime.setup(), /scenario.locations.building/ ); assert.equal( spawns, 0 );

} );