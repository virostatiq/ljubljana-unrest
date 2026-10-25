import assert from 'node:assert/strict';
import test from 'node:test';
import rallyScenario from '../examples/rally-scenario.ts';
import { RallyMission } from '../src/game/missions/rally.ts';
import { STAT } from '../src/sim/crowd.ts';
import { defineScenario, holdCrowd, place } from '../src/game/scenarios/definition.ts';
import { ScenarioRuntime } from '../src/game/scenarios/runtime.ts';
import * as sdk from '../src/game/scenarios/index.ts';

function buildRally() {

	let behavior;
	const definition = ( rallyScenario as any )( {
		defineScenario: ( value ) => value,
		defineBehavior: ( value ) => { behavior = value; return ( options ) => ( { kind: 'behavior', id: options.id, create: value.create } ); },
		holdCrowd: ( value ) => ( { ...value, kind: 'hold-crowd' } ),
		landmark: ( name ) => ( { kind: 'landmark', name } ), place: ( name ) => ( { kind: 'place', name } ),
		policeCommands: ( options ) => [ { kind: 'police-command', id: 'gas', resource: options.gas } ],
		protestCommands: sdk.protestCommands, scenarioCommand: sdk.scenarioCommand,
	} );
	return { definition, behavior };

}

test( 'Rally preview starts with source-sized groups, onlookers, police cordons and static police cars', async () => {

	const { definition } = buildRally(), crowd = [], squads = [], bystanders = [], vehicles = [];
	const locations = new Map( [ [ 'square', [ 0, 0 ] ], [ 'preseren', [ 100, 0 ] ], [ 'tivoli', [ 0, 100 ] ],
		[ 'station', [ - 100, 0 ] ], [ 'kongresni', [ 0, - 100 ] ], [ 'metelkova', [ 100, 100 ] ] ] );
	const context = { locations: { get: ( id ) => locations.get( id ) ?? id },
		spatial: { walkable: ( at ) => at }, presentation: { focus() {} },
		spawn: { crowd: ( options ) => crowd.push( options ), squad: ( options ) => squads.push( options ),
			bystanders: ( options ) => bystanders.push( options ), vehicle: ( options ) => vehicles.push( options ) } };
	await definition.setup( context );
	assert.equal( definition.side, 'protest' ); assert.equal( definition.objectives[ 0 ].kind, 'hold-crowd' );
	assert.equal( definition.commands[ 0 ].id, 'gas' ); assert.equal( definition.resources.gas.capacity, 46 );
	assert.equal( definition.opinion.initial, 50 );
	assert.deepEqual( definition.opinion.weights, { injuriesByPolice: 0.4, officersInjured: - 0.6, arrests: 0.05, sitterArrests: 0.1, otherInjuries: - 0.1 } );
	const score = definition.score( { win: true, time: 73.9, metrics: { opinion: 54.6,
		counters: { injuriesByPolice: 2, officersInjured: 1, arrests: 3, peopleGone: 4 } } } );
	assert.equal( score.lines[ 0 ][ 1 ], '1:13' );
	assert.deepEqual( crowd.map( ( group ) => group.people ), [ 900, 700, 600, 300 ] );
	assert.equal( crowd.reduce( ( total, group ) => total + group.people, 0 ), 2500 );
	assert.equal( bystanders[ 0 ].people, 2000 ); assert.equal( squads.length, 14 );
	assert.equal( vehicles.length, 4 );
	assert.ok( vehicles.every( ( vehicle ) => vehicle.type === 'police-patrol' && vehicle.crew === 0 && vehicle.selectable === false ) );
	assert.equal( squads.filter( ( squad ) => squad.id.startsWith( 'cordon-' ) ).length, 8 );
	assert.equal( squads.filter( ( squad ) => squad.id.startsWith( 'reserve-' ) ).length, 6 );

} );

test( 'Rally AI uses six cordon gas orders with the native pressure threshold and cooldown', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), orders = [], moves = [], notices = [];
	let time = 5;
	const context = { get time() { return time; }, signal: new AbortController().signal,
		locations: { get: () => [ 0, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? 0 : 251 },
		movement: { move: ( ...args ) => moves.push( args ) },
		spawn: { squad: ( options ) => ( { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) } ) },
		commands: { execute: ( command, request ) => {

			orders.push( { command, request } );
			return { settled: Promise.resolve( { status: 'completed', value: {} } ) };

		} },
		presentation: { notice: ( message, kind, at ) => notices.push( { message, kind, at } ) } };
	hooks.start( context );
	for ( let index = 0; index < 7; index ++ ) {

		time = 5 + index * 46; hooks.update( context ); await Promise.resolve();

	}
	assert.equal( orders.length, 6 );
	assert.ok( orders.every( ( order ) => order.command === 'gas' && order.request.at.every( ( value ) => value >= - 8 && value <= 8 )
		&& order.request.opinion.delta === 0 && order.request.opinion.reason === 'AI cordon gas' ) );
	assert.equal( notices.filter( ( notice ) => notice.message.includes( 'pressed cordon' ) ).length, 6 );
	assert.equal( moves.length, 8 );

} );

test( 'Rally police reinforcements follow the native headcount cadence, add line strength and respect the 30-squad cap', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), squads = [], notices = [], moves = [];
	let time = 5, headcount = 1600;
	const context = { get time() { return time; }, signal: new AbortController().signal,
		locations: { get: () => [ 0, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? headcount : 0 },
		movement: { move: ( ...args ) => { moves.push( args ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		commands: { execute: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		spawn: { squad: ( options ) => { squads.push( options ); return { settled: Promise.resolve( { status: 'completed', value: { id: options.id, kind: 'squad', run: 1 } } ) }; } },
		presentation: { notice: ( message ) => notices.push( message ) } };
	hooks.start( context );
	const updateAt = async ( seconds, people ) => { time = seconds; headcount = people; hooks.update( context ); await new Promise( ( resolve ) => setImmediate( resolve ) ); };
	await updateAt( 5, 1600 ); assert.equal( squads.length, 0 );
	await updateAt( 90, 1600 ); assert.equal( squads.length, 2 );
	await updateAt( 150, 1700 ); assert.equal( squads.length, 4 );
	await updateAt( 180, 3400 ); assert.equal( squads.length, 8 );
	assert.ok( notices.includes( 'Police are beginning to clear the square' ) );
	assert.equal( moves.filter( ( order ) => order[ 0 ]?.id?.startsWith( 'reinforcement-' ) && order[ 2 ]?.line ).length, 2 );
	for ( let index = 0; index < 30; index ++ ) await updateAt( 230 + index * 100, 3400 );
	assert.equal( squads.length, 30 );
	assert.ok( squads.every( ( squad ) => squad.people === 26 && [ 'station', 'police-center' ].includes( squad.at ) ) );

} );

test( 'Rally low-pressure reinforcements occupy a measured open outer road span', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), squads = [], moves = [], notices = [];
	let time = 90;
	const places = new Map( [ [ 'square', [ 0, 0 ] ], [ 'preseren', [ 100, 0 ] ], [ 'tivoli', [ 0, 100 ] ],
		[ 'station', [ - 100, 0 ] ], [ 'kongresni', [ 0, - 100 ] ] ] );
	const context = { get time() { return time; }, signal: new AbortController().signal,
		locations: { get: ( id ) => places.get( id ) ?? [ 0, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, roadSpan: ( at ) => ( { a: [ at[ 0 ] - 6, at[ 1 ] ], b: [ at[ 0 ] + 6, at[ 1 ] ], width: 12 } ), count: () => 100 },
		movement: { move: ( ...args ) => { moves.push( args ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		spawn: { squad: ( options ) => { squads.push( options ); return { settled: Promise.resolve( { status: 'completed', value: { id: options.id, kind: 'squad', run: 1 } } ) }; } },
		commands: { execute: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) }, timeline: { after: () => ( { state: 'pending', cancel() {} } ) },
		presentation: { notice: ( message ) => notices.push( message ) } };
	hooks.start( context ); hooks.update( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.deepEqual( squads.map( ( squad ) => squad.id ), [ 'reinforcement-01', 'reinforcement-02' ] );
	const roadOrders = moves.filter( ( order ) => order[ 0 ]?.id?.startsWith( 'reinforcement-' ) );
	assert.equal( roadOrders.length, 2 ); assert.ok( roadOrders.every( ( order ) => Math.hypot( order[ 1 ][ 0 ] - order[ 2 ].line[ 0 ], order[ 1 ][ 1 ] - order[ 2 ].line[ 1 ] ) === 12 ) );
	assert.ok( notices.includes( 'Police reinforcements cordon off another street' ) );

} );

test( 'Rally clearing announces reserve charges at the crowd edge and returns squads afterward', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), timers = [], orders = [], returns = [];
	const center = [ 0, 0 ], people = Array.from( { length: 51 }, () => ( { faction: 'protester', status: 'active', position: [ 40, 0 ] } ) );
	const context = { time: 5, signal: new AbortController().signal, observation: { people },
		locations: { get: () => center }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? 3400 : 0 },
		actors: { resolve: ( id ) => ( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { alive: 26, center: handle.id === 'reserve-01' ? [ 100, 0 ] : [ 0, 100 ] } ) },
		movement: { move: ( ...args ) => { returns.push( args ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		spawn: { squad: ( options ) => ( { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) } ) },
		commands: { execute: ( command, request ) => { orders.push( { command, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {} } };
	hooks.start( context ); hooks.update( context );
	assert.equal( timers[ 0 ].seconds, 5 );
	timers.shift().callback( context ); await Promise.resolve();
	assert.equal( orders[ 0 ].command, 'charge' ); assert.deepEqual( orders[ 0 ].request.selection.map( ( handle ) => handle.id ), [ 'reserve-01', 'reserve-02' ] );
	assert.deepEqual( orders[ 0 ].request.at, [ 25, 0 ] );
	assert.equal( timers[ 0 ].seconds, 14 );
	timers.shift().callback( context ); await Promise.resolve();
	const returnOrders = returns.filter( ( order ) => ! order[ 2 ]?.line );
	assert.equal( returnOrders.slice( - 2 ).length, 2 );
	assert.ok( returnOrders.slice( - 2 ).every( ( order ) => order[ 1 ][ 0 ] === 40 && order[ 1 ][ 1 ] === 0 ) );

} );

test( 'Rally clearing advances inner cordons eight meters every fifteen seconds and stops at 38 meters', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), moves = [];
	let time = 5;
	const context = { get time() { return time; }, signal: new AbortController().signal,
		locations: { get: ( id ) => id === 'square' ? [ 0, 0 ] : [ 100, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? 3400 : 0 },
		movement: { move: ( ...args ) => { moves.push( args ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		actors: { resolve: ( id ) => ( { id, kind: 'squad', run: 1 } ), get: () => ( { alive: 26, center: [ 100, 0 ] } ) },
		spawn: { squad: ( options ) => ( { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) } ) },
		commands: { execute: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		timeline: { after: () => ( { state: 'pending', cancel() {} } ) }, presentation: { notice() {} } };
	hooks.start( context ); moves.length = 0;
	for ( const at of [ 5, 20, 25, 35, 50, 65, 80, 95, 110 ] ) {

		time = at; hooks.update( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );

	}
	const cordonMoves = moves.filter( ( [ id ] ) => typeof id === 'string' && id.startsWith( 'cordon-' ) );
	assert.equal( cordonMoves.length, 48 );
	assert.deepEqual( cordonMoves[ 0 ][ 1 ], [ 77, 0 ] );
	assert.deepEqual( cordonMoves[ 8 ][ 1 ], [ 69, 0 ] );
	assert.deepEqual( cordonMoves[ 40 ][ 1 ], [ 37, 0 ] );

} );

test( 'Rally packed-square gas fires two delayed canisters every twenty seconds and restores one sympathy point', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), timers = [], orders = [];
	let time = 5;
	const people = [ 12, 18, 23 ].map( ( x ) => ( { faction: 'protester', status: 'active', position: [ x, 0 ] } ) );
	const context = { get time() { return time; }, signal: new AbortController().signal, observation: { people },
		locations: { get: ( id ) => id === 'square' ? [ 0, 0 ] : [ 100, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? 5000 : 0 },
		actors: { resolve: ( id ) => ( { id, kind: 'squad', run: 1 } ), get: () => ( { alive: 26, center: [ 100, 0 ] } ) },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		spawn: { squad: ( options ) => ( { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) } ) },
		commands: { execute: ( command, request ) => { orders.push( { command, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {} } };
	hooks.start( context ); hooks.update( context );
	const volley = timers.find( ( timer ) => timer.seconds === 5 );
	assert.ok( volley ); volley.callback( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( orders.length, 2 );
	assert.ok( orders.every( ( order ) => order.command === 'gas' && order.request.opinion.delta === 0.5
		&& order.request.opinion.reason === 'tear gas on a packed square' ) );
	time = 25; hooks.update( context );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 5 ).length, 2 );

} );

test( 'Rally kettles isolated groups with two reserves and releases them after ninety seconds', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), orders = [], timers = [], returns = [];
	const handle = ( id, kind ) => ( { id, kind, run: 1 } ), loner = handle( 'lone-group', 'crowd' );
	const reserves = Array.from( { length: 6 }, ( _, index ) => handle( `reserve-${String( index + 1 ).padStart( 2, '0' )}`, 'squad' ) );
	const context = { time: 5, signal: new AbortController().signal,
		observation: { people: [], actors: [ { handle: loner, center: [ 200, 0 ], alive: 100 }, ...reserves.map( ( reserve ) => ( { handle: reserve, center: [ 100 + reserve.id.length, 0 ], alive: 26 } ) ) ] },
		locations: { get: () => [ 0, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? 0 : radius === 40 ? 100 : 0 },
		actors: { resolve: ( id ) => reserves.find( ( reserve ) => reserve.id === id ) },
		movement: { move: ( ...args ) => { returns.push( args ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		spawn: { squad: ( options ) => ( { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) } ) },
		commands: { execute: ( command, request ) => { orders.push( { command, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {} } };
	hooks.start( context ); hooks.update( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( orders[ 0 ].command, 'kettle' );
	assert.deepEqual( orders[ 0 ].request.selection, reserves.slice( 0, 2 ) );
	const release = timers.find( ( timer ) => timer.seconds === 90 );
	assert.ok( release ); release.callback( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.deepEqual( returns.slice( - 2 ).map( ( order ) => order[ 0 ] ), reserves.slice( 0, 2 ) );

} );

test( 'Rally snatch reserves one squad until the factual task event', async () => {

	const { behavior } = buildRally(), hooks = behavior.create(), orders = [];
	const handle = ( id, kind ) => ( { id, kind, run: 1 } ), targetActor = handle( 'radicals', 'crowd' );
	const reserves = Array.from( { length: 6 }, ( _, index ) => handle( `reserve-${String( index + 1 ).padStart( 2, '0' )}`, 'squad' ) );
	const leader = { id: 'leader-1', actor: targetActor, faction: 'protester', status: 'active', leader: true, identified: true, position: [ 100, 0 ] };
	const context = { time: 5, signal: new AbortController().signal, observation: { people: [ leader ],
		actors: [ { handle: targetActor, center: [ 100, 0 ], alive: 100 }, ...reserves.map( ( reserve ) => ( { handle: reserve, center: [ 200, 0 ], alive: 26 } ) ) ] },
		locations: { get: () => [ 0, 0 ] }, resources: { get: () => ( { available: 46 } ) }, random: () => 0,
		spatial: { walkable: ( at ) => at, count: ( { radius } ) => radius === 60 ? 3000 : 0 }, actors: { resolve: ( id ) => reserves.find( ( reserve ) => reserve.id === id ) },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		spawn: { squad: ( options ) => ( { settled: Promise.resolve( { status: 'completed', value: { id: options.id } } ) } ) },
		commands: { execute: ( command, request ) => { const operation = { id: 'snatch-op-1', command, request,
			settled: Promise.resolve( { status: 'completed' } ) }; orders.push( operation ); return operation; } },
		timeline: { after: () => ( { state: 'pending', cancel() {} } ) }, presentation: { notice() {} } };
	hooks.start( context ); hooks.update( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( orders[ 0 ].command, 'snatch' );
	assert.deepEqual( orders[ 0 ].request.selection, [ reserves[ 0 ] ] );
	hooks.onEvent( context, { type: 'snatch.completed', operation: orders[ 0 ].id, squad: reserves[ 0 ] } );
	context.time = 10; hooks.update( context ); await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( orders.length, 2 ); assert.deepEqual( orders[ 1 ].request.selection, [ reserves[ 0 ] ] );

} );

test( 'Rally key calls spawn momentum-scaled arrivals and respect the 30-second cooldown', async () => {

	const { behavior } = buildRally(), hook = behavior.create(), calls = [], notices = [];
	let time = 0;
	const cursor = [ 25, 30 ];
	const context = { time, signal: new AbortController().signal, metrics: { opinion: 50 }, locations: { get: () => [ 0, 0 ] },
		spatial: { entries: () => [ { position: [ 100, 0 ] }, { position: [ 0, 100 ] } ], count: () => 2500, walkable: ( at ) => at },
		presentation: { notice: ( message, kind, at ) => notices.push( { message, kind, at } ) }, random: () => 0,
		spawn: { crowd: ( options ) => { calls.push( options ); return { settled: Promise.resolve( { status: 'completed', value: {} } ) }; } } };
	hook.onAction( context, { type: 'key', key: 'r', at: cursor } );
	await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( calls.reduce( ( total, group ) => total + group.people, 0 ), 650 );
	assert.ok( calls.every( ( group ) => group.goal === cursor ) ); assert.deepEqual( notices[ 0 ].at, cursor );
	assert.ok( calls.every( ( group ) => Math.hypot( group.at[ 0 ] - cursor[ 0 ], group.at[ 1 ] - cursor[ 1 ] ) === 300 ) );
	assert.ok( calls.every( ( group ) => group.goalRadius === 20 && group.spread === 4 ) );
	time = 20; context.time = time; hook.onAction( context, { type: 'key', key: 'r', at: cursor } );
	assert.match( notices.at( - 1 ).message, /ready in 10 s/ );
	time = 30; context.time = time; hook.onAction( context, { type: 'key', key: 'R', at: cursor } );
	await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( calls.reduce( ( total, group ) => total + group.people, 0 ), 1300 );

} );

test( 'Rally crowd-hold objective matches native win boundary and full-duration timeout', async () => {

	const definition = defineScenario( { id: 'rally-parity', side: 'protest', title: 'Rally', subtitle: 'Hold', brief: 'Hold.',
		locations: { square: place( 'Square' ) }, objectives: ( rallyScenario as any )( sdk ).objectives } );
	const run = async ( populationAt, totalAt: ( seconds: number ) => number = () => 2500 ) => {
		const runtime = new ScenarioRuntime( definition, { place: () => [ 0, 0 ], readMetrics: () => ( { opinion: 50, counters: {} } ), release() {} } );
		await runtime.setup();
		runtime.observation = { actors: [], people: [] }; await runtime.start();
		let headcount = 0, nativeResult = null;
		const native = { ai: { tick() {} }, goal: 5000, holdNeed: 180, held: 0, flags: {}, target: [ 0, 0 ], t: 0,
			stats: new Uint32Array( 16 ), get headcount() { return headcount; }, event() {},
			zone: () => headcount, end: ( win, reason ) => { nativeResult = { win, reason, time: native.t }; } };
		for ( let step = 1; step <= 1201 && ! nativeResult; step ++ ) {

			headcount = populationAt( step );
			native.t = step; native.stats[ STAT.PROT ] = Math.max( headcount, totalAt( step ) );
			RallyMission.prototype.tick.call( native, 1 );
			const inSquare = Array.from( { length: headcount }, () => ( { faction: 'protester', status: 'active', agitation: 0, position: [ 0, 0 ] } ) );
			const outside = Array.from( { length: Math.max( 0, totalAt( step ) - headcount ) }, () => ( { faction: 'protester', status: 'active', agitation: 0, position: [ 100, 100 ] } ) );
			runtime.observation = { actors: [], people: [ ...inSquare, ...outside ] };
			runtime.update( 1 );
			assert.equal( runtime.heldCrowdSeconds, native.held );
			assert.equal( Boolean( runtime.result ), Boolean( nativeResult ), `terminal state at ${step}s` );
			if ( nativeResult ) {

				assert.deepEqual( { win: runtime.result.win, reason: runtime.result.reason, time: runtime.time }, nativeResult );
				break;

			}

		}
		const result = { nativeResult, sdkResult: runtime.result && { win: runtime.result.win, reason: runtime.result.reason, time: runtime.time } };
		runtime.dispose();
		return result;
	};

	const win = await run( ( second ) => second >= 101 && second <= 280 ? 5000 : 0 );
	assert.deepEqual( win.nativeResult, { win: true, reason: 'Trg republike belongs to the people tonight.', time: 280 } );
	const interrupted = await run( ( second ) => second <= 90 || second >= 1000 ? 5000 : 4999 );
	assert.deepEqual( interrupted.sdkResult, { win: true, reason: 'Trg republike belongs to the people tonight.', time: 1089 } );
	const collapse = await run( () => 0, () => 499 );
	assert.deepEqual( collapse.sdkResult, { win: false, reason: 'The protest fizzled out.', time: 61 } );
	const timeout = await run( () => 0 );
	assert.deepEqual( timeout.nativeResult, { win: false, reason: 'The night is over — the square was never held long enough.', time: 1201 } );
	assert.deepEqual( timeout.sdkResult, timeout.nativeResult );

} );

test( 'Rally candidate score matches the native time, casualty boundaries and result rows', () => {

	const { definition } = buildRally();
	for ( const win of [ false, true ] ) for ( const time of [ 719.9, 720, 720.1, 1201 ] ) for ( const officersInjured of [ 10, 11 ] ) {

		const counters = { injByPolice: 30, injPolice: officersInjured, arrested: 40, gone: 50 };
		const expected = RallyMission.prototype.score.call( { t: time, opinion: 54.6, counters } as any, win );
		const actual = definition.score( { win, time, metrics: { opinion: 54.6,
			counters: { injuriesByPolice: 30, officersInjured, arrests: 40, peopleGone: 50 } } } );
		assert.deepEqual( actual, expected );

	}

} );