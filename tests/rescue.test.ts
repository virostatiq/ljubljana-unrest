import assert from 'node:assert/strict';
import test from 'node:test';
import rescueScenario from '../examples/rescue-scenario.ts';
import { RescueMission } from '../src/game/missions/rescue.ts';
import { FACTION } from '../src/sim/crowd.ts';
import * as sdk from '../src/game/scenarios/index.ts';
import { path as missionPath } from '../examples/mission-path.ts';

function nativeSetup() {

	const crowds = [], squads = [], vehicles = [], groups = [], bystanderCounts = [];
	const world = {
		groups, wind: [ 0, 0 ], exits: async () => {}, field: async () => ( {} ),
		bloc: async ( options ) => {

			crowds.push( options );
			return Array.from( { length: Math.ceil( options.n / options.groupSize ) }, ( _, index ) => ( { id: `crowd-${crowds.length}-${index}`, members: [] } ) );

		},
		squad: async ( options ) => {

			squads.push( options );
			const group = { id: `squad-${squads.length}`, faction: FACTION.POLICE, members: [], anchor: options.at };
			groups.push( group ); return group;

		},
		crowd: { setGroup() {} },
		patrols: { snap: ( x, y ) => [ x, y ], add: async ( options ) => { vehicles.push( options ); return { x: options.at[ 0 ], y: options.at[ 1 ], crew: null }; } },
	};
	const mission = Object.assign( Object.create( RescueMission.prototype ), {
		world, crowd: { u: { revealLeaders: { value: 0 }, parting: { value: - 1 } } }, counters: {}, t: 0,
		bystanders: async ( people ) => { bystanderCounts.push( people ); },
	} );
	return { mission, crowds, squads, vehicles, bystanderCounts };

}

test( 'Rescue SDK setup matches native crowd, squad, vehicle, bystander, resource and opinion setup', async () => {

	const native = nativeSetup(), definition = ( rescueScenario as any )( sdk ), sdkCrowds = [], sdkSquads = [], sdkVehicles = [], sdkBystanders = [], configured = [];
	let sdkWind;
	const originalRandom = Math.random; Math.random = () => 0.25;
	try { await RescueMission.prototype.setup.call( native.mission ); } finally { Math.random = originalRandom; }
	const vehicle = Object.freeze( { id: 'rescue-car', kind: 'vehicle', run: 1 } );
	await definition.setup( {
		presentation: { focus() {} },
		spawn: {
			crowd: ( options ) => { sdkCrowds.push( options ); return { settled: Promise.resolve( { status: 'completed', value: { id: options.id, kind: 'crowd', run: 1 } } ) }; },
			squad: ( options ) => { sdkSquads.push( options ); return { settled: Promise.resolve( { status: 'completed', value: { id: options.id, kind: 'squad', run: 1 } } ) }; },
			vehicle: ( options ) => { sdkVehicles.push( options ); return { settled: Promise.resolve( { status: 'completed', value: vehicle } ) }; },
			bystanders: ( options ) => sdkBystanders.push( options.people ),
		},
		protected: { create: () => Object.freeze( { id: 'speaker-person', run: 1 } ) },
		actors: { configure: ( actor, options ) => { configured.push( [ actor.id, options ] ); return { status: 'completed' }; } },
		environment: { configure: async ( options ) => { sdkWind = options.wind; } }, random: () => 0.25,
	} );

	const normalizeCrowd = ( options, candidate ) => ( {
		label: options.label, at: options.at, people: candidate ? options.people : options.n, groupSize: options.groupSize,
		spread: options.spread, agitation: options.agitation, resolve: options.resolve, morale: options.morale, speed: options.speed,
		medic: candidate ? options.medic === true : options.kind === 'medics',
	} );
	assert.deepEqual( sdkCrowds.map( ( options ) => normalizeCrowd( options, true ) ), native.crowds.map( ( options ) => normalizeCrowd( options, false ) ) );
	assert.deepEqual( sdkSquads.map( ( squad ) => [ squad.at, squad.people ] ), native.squads.map( ( squad ) => [ squad.at, squad.n ] ) );
	assert.deepEqual( sdkVehicles.map( ( item ) => item.at ), native.vehicles.map( ( item ) => item.at ) );
	assert.deepEqual( sdkBystanders, native.bystanderCounts );
	assert.deepEqual( configured, [ [ 'speaker', { closed: true, parting: true, leaderSuccession: false } ], [ 'antifa-1', { closed: true } ], [ 'antifa-2', { closed: true } ], [ 'antifa-3', { closed: true } ],
		[ 'snatcher-0', { speed: 1.45 } ], [ 'snatcher-1', { speed: 1.45 } ], [ 'snatcher-2', { speed: 1.45 } ] ] );
	assert.deepEqual( sdkWind, native.mission.world.wind );
	assert.equal( native.mission.sp.group.closed, true );
	assert.equal( native.mission.opinion, definition.opinion.initial );
	assert.equal( native.mission.crowd.u.revealLeaders.value, 1 );
	assert.deepEqual( [ native.mission.resources.umbrella.max ], [ definition.resources.umbrella.capacity ] );

} );

test( 'Rescue SDK briefing announcements retain native offsets', () => {

	const native = Object.assign( Object.create( RescueMission.prototype ), { t: 0, timers: [] } );
	RescueMission.prototype.start.call( native );
	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [];
	behavior.start( { timeline: { after: ( seconds, callback ) => timers.push( { seconds, callback } ) }, presentation: { notice() {} } } );
	assert.deepEqual( timers.map( ( timer ) => timer.seconds ), native.timers.map( ( timer ) => timer.at ) );
	assert.deepEqual( timers.map( ( timer ) => timer.seconds ), [ 2, 14, 45 ] );

} );

test( 'Rescue charge phase follows native three-second cadence and kettles 14 seconds after landing', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [], commands = [], moves = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), center = [ - 195, - 178 ];
	const notices = [], markerSnapshots = [];
	const context = { time: 0, signal: new AbortController().signal,
		observation: { people: Array.from( { length: 2500 }, () => ( { faction: 'protester', status: 'active', position: center } ) ) },
		protected: { get: () => ( { actor: speaker, state: 'active', position: [ - 205, - 178 ] } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice: ( ...args ) => notices.push( args ), markers: ( markers ) => markerSnapshots.push( markers ) },
		commands: { execute: ( id, request ) => { commands.push( { id, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		actors: { resolve: ( id ) => Object.freeze( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { handle, alive: 24, center: [ - 205, - 178 ] } ) },
		movement: { move: ( actor, at, options ) => { moves.push( { actor, at, options } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		resources: { get: () => ( { available: false } ) },
	};
	behavior.start( context );
	const existingKettleTimers = timers.filter( ( timer ) => timer.seconds === 14 ).length;
	for ( context.time = 3; context.time < 67; context.time += 3 ) behavior.update( context );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 8 ).length, 0 );
	context.time = 69; behavior.update( context );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 8 ).length, 3 );
	const forcePositions = [ [ - 325, - 275 ], [ - 322, - 88 ], [ - 62, - 76 ] ];
	assert.deepEqual( notices.filter( ( [ text ] ) => text.includes( 'charge' ) ).map( ( [ text ] ) => text ),
		[ 'Police: baton charges from Slovenska, Šubičeva and Prešernov trg in 8 s' ] );
	assert.deepEqual( markerSnapshots.at( - 1 ).map( ( marker ) => marker.at ), forcePositions.map( ( at ) => {

		const delta = [ at[ 0 ] - center[ 0 ], at[ 1 ] - center[ 1 ] ], length = Math.hypot( ...delta );
		return [ center[ 0 ] + delta[ 0 ] / length * 25, center[ 1 ] + delta[ 1 ] / length * 25 ];

	} ) );
	assert.equal( timers.filter( ( timer ) => timer.seconds === 14 ).length, existingKettleTimers );
	const force = [ - 325, - 275 ], delta = [ force[ 0 ] - center[ 0 ], force[ 1 ] - center[ 1 ] ], distance = Math.hypot( ...delta );
	context.time = 77; timers.find( ( timer ) => timer.seconds === 8 ).callback();
	assert.deepEqual( commands.find( ( command ) => command.id === 'charge' ).request.at,
		[ center[ 0 ] + delta[ 0 ] / distance * 25, center[ 1 ] + delta[ 1 ] / distance * 25 ] );
	const kettleTimer = timers.filter( ( timer ) => timer.seconds === 14 ).at( - 1 );
	assert.ok( kettleTimer ); kettleTimer.callback();
	const kettle = commands.find( ( command ) => command.id === 'kettle' );
	assert.deepEqual( kettle.request.at, center ); assert.equal( kettle.request.radius, Math.sqrt( 2500 / 1.6 / Math.PI ) ); assert.equal( kettle.request.tighten, 0.8 );
	context.time = 77; behavior.update( context ); assert.equal( timers.filter( ( timer ) => timer.seconds === 5 ).length, 0 );
	context.time = 96; behavior.update( context ); assert.equal( timers.filter( ( timer ) => timer.seconds === 5 ).length, 1 );

} );

test( 'Rescue SDK scoring rows and star thresholds match the native mission', () => {

	const definition = ( rescueScenario as any )( sdk );
	for ( const win of [ false, true ] ) for ( const time of [ 599.9, 600, 900 ] ) for ( const opinion of [ 49, 50 ] ) {

		const counters = { injuriesByPolice: 3, treatedByMedics: 2, arrests: 4, officersInjured: 5 };
		const native = RescueMission.prototype.score.call( { t: time, opinion, sp: { carriers: 0 },
			counters: { injByPolice: counters.injuriesByPolice, treated: counters.treatedByMedics, arrested: counters.arrests, injPolice: counters.officersInjured, broken: 0 }, ai: { gasUsed: 1 } }, win );
		const actual = definition.score( { win, time, metrics: { opinion, counters: { ...counters, gasUsed: 1 } } } );
		assert.deepEqual( actual, native );

	}

} );

test( 'Rescue SDK outcome reasons preserve native captured, escaped and timeout results', () => {

	const definition = ( rescueScenario as any )( sdk ), outcome = definition.outcomes[ 0 ].evaluate;
	const protectedObservation = ( state ) => ( { handle: { id: 'speaker-person' }, state } );
	assert.deepEqual( outcome( { time: 100, observation: { protected: [ protectedObservation( 'captured' ) ] }, metrics: {} } ),
		{ win: false, reason: 'The police took the Speaker.' } );
	assert.deepEqual( outcome( { time: 239.9, observation: { protected: [ protectedObservation( 'exited' ) ] }, metrics: {} } ),
		{ win: true, reason: 'The Speaker got away at 3:59.' } );
	assert.deepEqual( outcome( { time: 900, observation: { protected: [ protectedObservation( 'active' ) ] }, metrics: {} } ),
		{ win: false, reason: 'The police sealed off the district. The Speaker is trapped.' } );

} );

test( 'Rescue selects its exit by road distance and police along the route, not straight-line distance', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), drives = [], countCalls = [];
	const car = { handle: { id: 'rescue-car', kind: 'vehicle', run: 1 }, position: [ 0, 0 ], speed: 0, moving: true, revision: 0 };
	const routePoints = new Map( [
		[ '-330,-948', [ [ 0, 0 ], [ 0, - 900 ], [ - 330, - 948 ] ] ],
		[ '-60,-657', [ [ 0, 0 ], [ 500, 0 ], [ 500, - 657 ], [ - 60, - 657 ] ] ],
		[ '-75,-903', [ [ 0, 0 ], [ - 75, - 903 ] ] ],
	] );
	const length = ( points ) => points.slice( 1 ).reduce( ( total, point, index ) => total + Math.hypot( point[ 0 ] - points[ index ][ 0 ], point[ 1 ] - points[ index ][ 1 ] ), 0 );
	const context = {
		time: 0, protected: { get: () => ( { state: 'aboard', position: [ 0, 0 ], revision: 1 } ) },
		vehicles: { get: () => car, drive: ( handle, at ) => { drives.push( at ); return { status: 'completed' }; }, exit() {} },
		spatial: {
			roadRoute: ( from, to ) => { const points = routePoints.get( `${to[ 0 ]},${to[ 1 ]}` ); return points ? { points, length: length( points ) } : null; },
			count: ( options ) => { countCalls.push( options ); return 0; },
		},
	};
	behavior.observe( context, { sequence: 1, elapsed: 0, people: [] } );
	assert.deepEqual( drives, [ [ - 75, - 903 ] ] );
	assert.ok( countCalls.length > 3 );

} );

test( 'Rescue mobile interception leads are compensated by native road travel time', async () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create();
	const native = nativeSetup(); await RescueMission.prototype.setup.call( native.mission );
	const route = missionPath( native.mission.route.pts ), speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } );
	const timers = [], spawns = [], roadRoutes = [], drives = [];
	const vehicle = Object.freeze( { id: 'mobile-1', kind: 'vehicle', run: 1 } );
	const context = {
		time: 0, signal: new AbortController().signal,
		protected: { get: () => ( { actor: speaker, state: 'active', position: native.mission.sp.pos } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		spawn: { vehicle: ( options ) => { spawns.push( options ); return { settled: Promise.resolve( { status: 'completed', value: vehicle } ) }; } },
		vehicles: { get: () => ( { handle: vehicle, position: [ - 372, - 385 ], revision: 0 } ),
			drive: ( handle, at, options ) => { drives.push( { handle, at, options } ); return { status: 'completed' }; } },
		spatial: { roadRoute: ( from, to ) => { roadRoutes.push( [ from, to ] ); return { points: [ from, to ], length: 180 }; }, walkable: ( at ) => at },
	};
	behavior.onEvent( context, { type: 'player.move', actor: speaker } );
	timers.find( ( timer ) => timer.seconds === 20 ).callback(); await Promise.resolve();
	assert.deepEqual( spawns[ 0 ], { id: 'mobile-1', at: [ - 372, - 385 ], type: 'police-patrol', crew: 12, selectable: false } );
	assert.equal( drives.length, 0 );
	assert.ok( timers.find( ( timer ) => timer.seconds === 1.5 ) );
	timers.find( ( timer ) => timer.seconds === 1.5 ).callback();
	assert.deepEqual( roadRoutes[ 0 ][ 1 ], route.at( 110 ) );
	assert.deepEqual( drives[ 0 ].at, route.at( 50 + 180 / 9 * 1.7 ) );

} );

test( 'Rescue pauses new snatches while the Speaker is down and sends nearby squads to help', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [], moves = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), position = [ - 205, - 178 ];
	const context = {
		time: 69, observation: {}, protected: { get: () => ( { actor: speaker, state: 'down', position } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		actors: { resolve: ( id ) => Object.freeze( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { handle, center: [ - 210, - 180 ], alive: 24 } ) },
		movement: { move: ( actor, at ) => { moves.push( [ actor, at ] ); return {}; } },
		spatial: { count: () => 0 }, resources: { get: () => ( { available: false } ) },
	};
	behavior.update( context ); context.time = 120; behavior.update( context );
	assert.equal( timers.some( ( timer ) => timer.seconds === 5 ), false );
	assert.equal( moves.length, 4 ); assert.ok( moves.every( ( [ actor, at ] ) => actor.kind === 'squad' && at === position ) );

} );

test( 'Rescue snatch pursuit shares the native 12 m field and retains the exact Speaker aim', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [], commands = [], moves = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), position = [ - 205.37, - 178.61 ];
	const context = {
		time: 69, observation: {}, protected: { get: () => ( { actor: speaker, state: 'active', position } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		actors: { resolve: ( id ) => Object.freeze( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { handle, center: [ - 205, - 180 ], alive: 24 } ) },
		commands: { execute: ( id, request ) => { commands.push( { id, request } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		movement: { move: ( actor, at, options ) => { moves.push( { actor, at, options } ); return { settled: Promise.resolve( { status: 'completed' } ) }; } },
		spatial: { count: () => 0 }, resources: { get: () => ( { available: false } ) },
	};
	behavior.onEvent( context, { type: 'player.move', actor: speaker } );
	behavior.update( context ); context.time = 120; behavior.update( context );
	const warning = timers.find( ( timer ) => timer.seconds === 5 ); assert.ok( warning ); warning.callback();
	assert.equal( commands[ 0 ].id, 'arrest' ); assert.deepEqual( commands[ 0 ].request.at, [ - 204, - 180 ] );
	assert.deepEqual( commands[ 0 ].request.aim, position ); assert.equal( commands[ 0 ].request.radius, 14 );
	timers.find( ( timer ) => timer.seconds === 45 ).callback();
	assert.deepEqual( moves.at( - 1 ), { actor: context.actors.resolve( 'snatcher-0' ), at: [ - 204, - 180 ], options: undefined } );

} );

test( 'Rescue snatch pursuit retargets the same squad without cancelling earlier preparation', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create(), timers = [], commands = [];
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), position = [ - 205.37, - 178.61 ];
	const context = {
		time: 69, observation: {}, protected: { get: () => ( { actor: speaker, state: 'active', position } ) },
		timeline: { after: ( seconds, callback ) => { timers.push( { seconds, callback } ); return { state: 'pending', cancel() {} }; } },
		presentation: { notice() {}, markers() {} },
		actors: { resolve: ( id ) => Object.freeze( { id, kind: 'squad', run: 1 } ), get: ( handle ) => ( { handle, center: [ - 205, - 180 ], alive: 24 } ) },
		commands: { execute: ( id, request ) => {
			let resolve;
			const operation = { id: `operation-${commands.length}`, state: 'preparing', settled: new Promise( ( done ) => { resolve = done; } ),
				cancel( reason ) { this.state = 'cancelled'; resolve( { status: 'cancelled', reason } ); return { status: 'requested' }; } };
			commands.push( { id, request, operation } ); return operation;
		} },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		spatial: { count: () => 0 }, resources: { get: () => ( { available: false } ) },
	};
	behavior.update( context ); context.time = 120; behavior.update( context );
	timers.find( ( timer ) => timer.seconds === 5 ).callback();
	context.time = 123; behavior.update( context );
	assert.equal( commands.length, 2 ); assert.equal( commands[ 0 ].operation.state, 'preparing' );
	assert.deepEqual( commands[ 1 ].request.at, [ - 204, - 180 ] ); assert.deepEqual( commands[ 1 ].request.aim, position );
	assert.equal( commands[ 1 ].request.retarget, true );

} );

test( 'Rescue recovery rejoins the carrier to the Speaker actor at native speed', async () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create();
		const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } ), protectedHandle = Object.freeze( { id: 'speaker-person', kind: 'protected-person', run: 1 } );
		const carrier = Object.freeze( { id: 'carrier', kind: 'person', run: 1 } );
		await definition.setup( {
			random: () => 0.5, environment: { configure: async () => {} }, presentation: { focus() {} },
			spawn: {
				crowd: ( options ) => { const actor = Object.freeze( { id: options.id, kind: 'crowd', run: 1 } ); return { settled: Promise.resolve( { status: 'completed', value: actor } ) }; },
				squad: ( options ) => { const actor = Object.freeze( { id: options.id, kind: 'squad', run: 1 } ); return { settled: Promise.resolve( { status: 'completed', value: actor } ) }; },
				vehicle: () => ( { settled: Promise.resolve( { status: 'completed', value: Object.freeze( { id: 'rescue-car', kind: 'vehicle', run: 1 } ) } ) } ),
				bystanders() {},
			},
			actors: { configure: () => ( { status: 'completed' } ) }, protected: { create: () => protectedHandle },
		} );
		let transfer;
		const position = [ - 205, - 178 ];
		const context = { time: 120, signal: new AbortController().signal,
			protected: {
				get: () => ( { handle: protectedHandle, actor: speaker, state: 'down', position, revision: 4, capture: { available: true, friendly: 5, hostile: 2 } } ),
				transfer: ( handle, options ) => { transfer = { handle, options }; return { status: 'completed' }; },
			},
			vehicles: { get: () => ( { position: [ - 318, - 772 ], moving: true, speed: 8 } ) },
			spatial: { count: () => 0 }, resources: { get: () => ( { available: false } ) },
			crowd: { recall() {} }, timeline: { after: () => ( { state: 'pending', cancel() {} } ) },
			presentation: { notice() {}, markers() {} },
		};
		behavior.observe( context, { sequence: 10, elapsed: 0.5, people: [ { handle: carrier, actor: { id: 'stewards' }, status: 'active', position: [ - 204, - 177 ] } ] } );
		assert.equal( transfer.handle, protectedHandle );
		assert.equal( transfer.options.expectedRevision, 4 ); assert.equal( transfer.options.expectedSample, 10 );
		assert.equal( transfer.options.promote, true ); assert.deepEqual( transfer.options.joinGroup, { speed: 0.85 } );

	} );

test( 'Rescue phase reports the native stand, route distance, down and in-car states', () => {

	const definition = ( rescueScenario as any )( sdk ), behavior = definition.behaviors[ 0 ].create();
	const speaker = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } );
	let state = 'active', position: [ number, number ] = [ - 205, - 178 ]; const recalls = [];
	const context = {
		time: 0, signal: new AbortController().signal,
		protected: { get: () => ( { actor: speaker, state, position } ) },
		timeline: { after: () => ( { state: 'pending', cancel() {} } ) }, presentation: { notice() {}, markers() {} },
		crowd: { recall: ( actor, floor ) => recalls.push( [ actor, floor ] ) },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		vehicles: { get: () => ( { position: [ - 318, - 772 ], moving: true, speed: 8 } ), drive() {} },
		spatial: { count: () => 0, roadRoute: ( from, to ) => ( { points: [ from, to ], length: 100 } ) },
	};
	const route = missionPath( [
		[ - 205, - 178 ], [ - 191, - 245 ], [ - 201, - 278 ], [ - 216, - 338 ], [ - 233, - 402 ], [ - 245, - 446 ], [ - 264, - 497 ], [ - 277, - 508 ],
		[ - 289, - 521 ], [ - 294, - 534 ], [ - 298, - 548 ], [ - 301, - 605 ], [ - 302, - 620 ], [ - 299, - 632 ], [ - 295, - 645 ], [ - 294, - 675 ], [ - 297, - 688 ],
		[ - 307, - 719 ], [ - 310, - 730 ], [ - 316, - 759 ], [ - 318, - 772 ],
	] );
	assert.equal( definition.phase( { time: 0 } ), 'the Speaker is on the stand · 15:00 left · wind →' );
	behavior.start( context ); behavior.onEvent( context, { type: 'player.move', actor: speaker } );
	context.time = 6; position = [ - 233, - 402 ]; behavior.observe( context, { sequence: 1, elapsed: 0.5 } );
	assert.equal( definition.phase( { time: 10 } ), `Speaker ${Math.round( route.length - route.project( position ) )} m from the car · 14:50 left · wind →` );
	context.time = 12; behavior.observe( context, { sequence: 2, elapsed: 0.5 } );
	assert.deepEqual( recalls, [ [ speaker, 0.8 ], [ speaker, 0.8 ] ] );
	state = 'down'; context.time = 18; behavior.observe( context, { sequence: 3, elapsed: 0.5 } );
	assert.equal( definition.phase( { time: 20 } ), 'SPEAKER DOWN · 14:40 left · wind →' );
	state = 'aboard'; context.time = 30; behavior.observe( context, { sequence: 4, elapsed: 0.5 } );
	assert.equal( definition.phase( { time: 30 } ), 'SPEAKER IN THE CAR · 14:30 left · wind →' );
	assert.equal( recalls.length, 2 );

} );

test( 'Rescue SDK HUD matches native objective rows and star boundaries', async () => {

	const native = nativeSetup(), definition = ( rescueScenario as any )( sdk ); await RescueMission.prototype.setup.call( native.mission );
	const position: [ number, number ] = [ - 233, - 402 ], route = missionPath( native.mission.route.pts );
	Object.assign( native.mission, { t: 300, opinion: 48, sp: { aboard: false, down: false, escaping: true, pos: position, s: route.project( position ), grab: 1.5 } } );
	native.mission.world.countNear = () => 7;
	const expected = RescueMission.prototype.objectives.call( native.mission );

	const behavior = definition.behaviors[ 0 ].create(), actor = Object.freeze( { id: 'speaker', kind: 'crowd', run: 1 } );
	const context = { time: 0, signal: new AbortController().signal,
		protected: { get: () => ( { actor, state: 'active', position, capture: { held: 1.5, required: 4, pressure: true, available: true, friendly: 0, hostile: 7 } } ) },
		timeline: { after: () => ( { state: 'pending', cancel() {} } ) }, presentation: { notice() {}, markers() {} },
		movement: { move: () => ( { settled: Promise.resolve( { status: 'completed' } ) } ) },
		vehicles: { get: () => ( { position: [ - 318, - 772 ], moving: true, speed: 8 } ) },
		spatial: { count: () => 7, roadRoute: ( from, to ) => ( { points: [ from, to ], length: 100 } ) },
	};
	behavior.onEvent( context, { type: 'player.move', actor } ); behavior.observe( context, { sequence: 1, elapsed: 0.5 } );
	const actual = definition.hud( { time: 300, metrics: { opinion: 48, counters: {} } } );
	assert.deepEqual( actual, expected );

} );