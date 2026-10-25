import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;
const STAND: Sdk.Point = [ - 205, - 178 ];
const LEGS: Sdk.Point[] = [ [ - 191, - 247 ], [ - 233, - 402 ], [ - 278, - 510 ], [ - 300, - 585 ], [ - 296, - 645 ] ];
const PICKUPS: Sdk.Point[] = [ [ - 318, - 772 ], [ - 84, - 760 ] ];
const EXITS: Sdk.Point[] = [ [ - 330, - 948 ], [ - 60, - 657 ], [ - 75, - 903 ] ];
const FORCES: { name: string; at: Sdk.Point }[] = [ { name: 'Slovenska', at: [ - 325, - 275 ] }, { name: 'Šubičeva', at: [ - 322, - 88 ] }, { name: 'Prešernov trg', at: [ - 62, - 76 ] } ];
const distance = ( first, second ) => Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ] );
const timeText = ( seconds ) => `${Math.floor( Math.max( 0, seconds ) / 60 )}:${String( Math.floor( Math.max( 0, seconds ) % 60 ) ).padStart( 2, '0' )}`;

export default ( { defineScenario, defineBehavior, defineOutcome, extract, landmark, place, policeCommands, protestCommands }: typeof Sdk ) => {

	const run: any = { speaker: null, car: null, escaping: false, leg: 0, pickup: 0, movedAt: - 99, threat: 0, heldCar: 0, taken: false, carried: false, carriers: 0, gas: 0, broken: 0 };
	const police = FORCES.flatMap( ( force, index ) => [ ...Array.from( { length: 3 }, ( _, part ) => ( { id: `force-${index}-${part}`, at: [ force.at[ 0 ] + ( part - 1 ) * 10, force.at[ 1 ] ] as Sdk.Point, people: 24 } ) ),
		{ id: `snatcher-${index}`, at: [ force.at[ 0 ], force.at[ 1 ] + 10 ] as Sdk.Point, people: 14 } ] ).concat( [ { id: 'reserve-1', at: [ - 436, - 41 ], people: 20 }, { id: 'reserve-2', at: [ - 426, - 41 ], people: 20 } ] );
	const friendly = [ 'speaker', 'stewards', 'listeners', 'antifa-1', 'antifa-2', 'antifa-3', 'medics' ];
	const behavior = defineBehavior( { id: 'rescue-escape-and-police', create() {

		let routeOperation, routeDestination, detouring = false, lastPolice = 0, lastSnatch = - 99, lastGas = - 99, lastDown = - 99;
		let carOrigin, exit: Sdk.Point, phase = 'stand', pendingId = 0;
		const chasing = new Set<string>(), waiting = new Map<string, Sdk.MapMarker>();
		const move = ( ctx ) => {

			const speaker = ctx.protected.get( run.speaker ); if ( ! speaker.actor || ! [ 'active', 'carried' ].includes( speaker.state ) ) return;
			routeDestination = run.leg < LEGS.length ? LEGS[ run.leg ] : ctx.vehicles.get( run.car ).position;
			routeOperation = ctx.movement.move( speaker.actor, routeDestination, { radius: run.leg < LEGS.length ? 6 : 3 } );

		};
		const tell = ( ctx, at, radius, label, seconds, action ) => {

			const id = `rescue-action-${++ pendingId}`;
			waiting.set( id, { id, at, radius, label, kind: 'bad', countdownTo: ctx.time + seconds } ); ctx.presentation.markers( [ ...waiting.values() ] );
			ctx.presentation.notice( `Police: ${label} in ${seconds} s`, 'warn', at );
			ctx.timeline.after( seconds, () => { waiting.delete( id ); ctx.presentation.markers( [ ...waiting.values() ] ); action(); } );

		};
		const chase = ( ctx, id, at ) => ctx.commands.execute( 'arrest', { at: [ Math.round( at[ 0 ] / 12 ) * 12, Math.round( at[ 1 ] / 12 ) * 12 ], selection: [ ctx.actors.resolve( id ) ] } );
		return {
			start( ctx ) {

				ctx.timeline.after( 2, () => ctx.presentation.notice( 'The Speaker is on the stand. Riot squads are forming up on Slovenska, Šubičeva and Prešernov trg', 'info', STAND ) );
				ctx.timeline.after( 45, () => ctx.presentation.notice( 'The riot squads are lining up: the charge is coming', 'warn', FORCES[ 0 ].at ) );
				ctx.timeline.after( 67, () => {

					for ( const [ index, force ] of FORCES.entries() ) tell( ctx, STAND, 14, `charge from ${force.name}`, 8, () => {

						const gap = distance( force.at, STAND ) || 1, at = STAND.map( ( value, axis ) => value + ( force.at[ axis ] - value ) / gap * 25 );
						ctx.commands.execute( 'charge', { at: [ at[ 0 ], at[ 1 ] ], selection: Array.from( { length: 3 }, ( _, part ) => ctx.actors.resolve( `force-${index}-${part}` ) ) } );
						if ( ! run.escaping ) { run.escaping = true; phase = 'escape'; move( ctx ); }

					} );
					ctx.timeline.after( 22, () => ctx.commands.execute( 'kettle', { at: STAND, selection: police.filter( ( squad ) => squad.id.startsWith( 'force-' ) ).map( ( squad ) => ctx.actors.resolve( squad.id ) ) } ) );

				} );
				for ( const [ delay, origin ] of [ [ 95, [ - 372, - 385 ] ], [ 130, [ - 515, - 1300 ] ], [ 170, [ - 372, - 385 ] ], [ 215, [ - 515, - 1300 ] ] ] as [ number, Sdk.Point ][] ) {

					ctx.timeline.after( delay, () => {

						const id = `mobile-${delay}`, operation = ctx.spawn.vehicle( { id, at: origin, type: 'police-patrol', selectable: false } );
						void operation.settled.then( ( outcome ) => { if ( outcome.status !== 'completed' || ctx.signal.aborted ) return;
							const vehicle = ctx.vehicles.get( outcome.value ); ctx.vehicles.drive( vehicle.handle, PICKUPS[ run.pickup ], { expectedRevision: vehicle.revision } ); } );

					} );

				}

			},
			observe( ctx, sample ) {

				const speaker = ctx.protected.get( run.speaker ), car = ctx.vehicles.get( run.car );
				if ( speaker.state === 'down' && speaker.position && speaker.capture?.available && speaker.capture.friendly >= 4 && speaker.capture.hostile < speaker.capture.friendly ) {

					const carrier = sample.people.filter( ( person ) => friendly.includes( person.actor.id ) && person.actor.id !== 'medics' && person.status === 'active' && distance( person.position, speaker.position ) < 8 )
						.sort( ( first, second ) => distance( first.position, speaker.position ) - distance( second.position, speaker.position ) )[ 0 ];
					if ( carrier && ctx.protected.transfer( run.speaker, { carrier: carrier.handle, expectedRevision: speaker.revision, expectedSample: sample.sequence, promote: true, radius: 8 } ).status === 'completed' ) {

						run.carried = true; run.carriers ++; if ( run.escaping ) move( ctx );

					}
					return;

				}
				if ( speaker.state === 'aboard' ) {

					if ( phase !== 'car' ) { phase = 'car'; carOrigin = car.position;
						exit = [ ...EXITS ].sort( ( first, second ) => distance( first, car.position ) + ( ctx.spatial.count( { at: first, radius: 40, faction: 'police' } ) ?? 0 ) * 60
							- distance( second, car.position ) - ( ctx.spatial.count( { at: second, radius: 40, faction: 'police' } ) ?? 0 ) * 60 )[ 0 ];
						ctx.vehicles.drive( run.car, exit, { expectedRevision: car.revision } ); }
					const policeAtCar = ctx.spatial.count( { at: car.position, radius: 8, faction: 'police' } );
					run.heldCar = car.speed < 0.5 && policeAtCar !== null && policeAtCar >= 8 ? run.heldCar + sample.elapsed : 0;
					if ( run.heldCar > 10 ) run.taken = true;
					if ( ! car.moving && distance( car.position, exit ) < 30 ) ctx.vehicles.exit( run.speaker, { expectedRevision: speaker.revision, at: exit, radius: 30 } );
					return;

				}
				if ( ! run.escaping || ! speaker.position || ! [ 'active', 'carried' ].includes( speaker.state ) ) return;
				if ( ! car.moving && distance( speaker.position, car.position ) < 7 ) {

					ctx.vehicles.board( run.speaker, run.car, { expectedRevision: speaker.revision, expectedVehicleRevision: car.revision, expectedSample: sample.sequence } ); return;

				}
				if ( ! detouring && run.leg < LEGS.length && distance( speaker.position, LEGS[ run.leg ] ) < 14 ) { run.leg ++; move( ctx ); }
				if ( ! detouring && run.leg === LEGS.length && ( ! routeDestination || distance( routeDestination, car.position ) > 8 ) ) move( ctx );
				if ( ! car.moving ) {

					const officers = ctx.spatial.count( { at: car.position, radius: 14, faction: 'police' } ), supporters = ctx.spatial.count( { at: car.position, radius: 14, faction: 'protester' } );
					if ( officers === null || supporters === null ) return;
					run.threat = officers >= 6 && officers > supporters ? run.threat + sample.elapsed : 0;
					if ( run.threat > 8 && ctx.time - run.movedAt > 30 ) { run.pickup = 1 - run.pickup; run.movedAt = ctx.time; run.threat = 0; ctx.vehicles.drive( run.car, PICKUPS[ run.pickup ], { expectedRevision: car.revision } ); }

				}

			},
			update( ctx ) {

				if ( ! ctx.observation || ctx.time - lastPolice < 3 ) return; lastPolice = ctx.time;
				const speaker = ctx.protected.get( run.speaker ); if ( ! speaker.position || [ 'aboard', 'exited' ].includes( speaker.state ) ) return;
				for ( const id of chasing ) { const squad = ctx.actors.get( ctx.actors.resolve( id ) ); if ( squad?.alive > 5 ) chase( ctx, id, speaker.position ); }
				if ( speaker.state === 'down' && ctx.time - lastDown >= 6 ) {

					lastDown = ctx.time;
					for ( const squad of police.map( ( entry ) => ctx.actors.get( ctx.actors.resolve( entry.id ) ) ).filter( ( actor ) => actor?.center && actor.alive > 5 ).sort( ( first, second ) => distance( first.center, speaker.position ) - distance( second.center, speaker.position ) ).slice( 0, 2 ) ) ctx.movement.move( squad.handle, speaker.position );

				}
				if ( ctx.time < 75 || ctx.time - lastSnatch < ( run.escaping ? 25 : 35 ) ) return;
				const available = police.filter( ( entry ) => entry.id.startsWith( 'snatcher-' ) || entry.id.startsWith( 'reserve-' ) )
					.map( ( entry ) => ctx.actors.get( ctx.actors.resolve( entry.id ) ) ).filter( ( actor ) => actor?.center && actor.alive > 5 && ! chasing.has( actor.handle.id ) && distance( actor.center, speaker.position ) < 260 )
					.sort( ( first, second ) => distance( first.center, speaker.position ) - distance( second.center, speaker.position ) );
				if ( available.length ) { lastSnatch = ctx.time; const id = available[ 0 ].handle.id;
					tell( ctx, speaker.position, 10, `${id} for the Speaker`, 5, () => { chasing.add( id ); chase( ctx, id, ctx.protected.get( run.speaker ).position ?? speaker.position );
						ctx.timeline.after( 45, () => { chasing.delete( id ); const at = ctx.protected.get( run.speaker ).position; if ( at ) ctx.movement.move( ctx.actors.resolve( id ), at ); } ); } ); }
				if ( ctx.time - lastGas > 40 && ctx.resources.get( 'gas' ).available ) for ( const id of chasing ) {

					const squad = ctx.actors.get( ctx.actors.resolve( id ) );
					if ( ! squad?.center || distance( squad.center, speaker.position ) >= 50 || ( ctx.spatial.count( { at: squad.center, radius: 15, faction: 'protester' } ) ?? 0 ) < 80 ) continue;
					lastGas = ctx.time; const at = squad.center.map( ( value, axis ) => value + ( speaker.position[ axis ] - value ) * 0.6 );
					tell( ctx, at, 20, 'tear gas', 6, () => { void ctx.commands.execute( 'gas', { at: [ at[ 0 ], at[ 1 ] ], opinion: { delta: 1.5, reason: 'tear gas on camera' } } ).settled.then( ( outcome ) => { if ( outcome.status === 'completed' ) run.gas ++; } ); } ); break;

				}

			},
			onEvent( ctx, event ) {

				const actor = ctx.protected.get( run.speaker ).actor;
				if ( event.type === 'player.move' && event.actor === actor ) { detouring = true; run.escaping = true; }
				if ( event.type === 'movement.arrived' && event.actor === actor && event.source === 'player' ) { detouring = false;
					const position = ctx.protected.get( run.speaker ).position; if ( position ) { let nearest = run.leg;
						for ( let index = run.leg; index < LEGS.length; index ++ ) if ( distance( LEGS[ index ], position ) < distance( LEGS[ nearest ], position ) ) nearest = index;
						run.leg = nearest; move( ctx ); } }

			},
		};

	} } );
	return defineScenario( { id: 'rescue-rules', menu: false, title: 'Rescue Rules Preview', subtitle: 'Get the Speaker to the rescue car', side: 'protest',
		brief: 'Protect the Speaker on Kongresni trg. Escape through Vegova and Emonska to the car before the police seal off the district.',
		goals: [ 'Get the Speaker into the rescue car', 'Do not let the police take the Speaker', 'Within 15:00' ],
		locations: { square: place( 'Kongresni trg' ), preseren: place( 'Prešernov trg' ), metelkova: place( 'Metelkova' ), railway: landmark( 'Železniška postaja' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ), exit: EXITS[ 0 ] },
		opinion: { initial: 55, weights: { injuriesByPolice: 0.15, officersInjured: - 0.3, arrests: 0.02, sitterArrests: 0.05, otherInjuries: - 0.1 } },
		resources: { gas: { capacity: 4 }, umbrella: { capacity: 3 } }, commands: [ ...policeCommands( { gas: 'gas', crew: true } ), ...protestCommands( { umbrella: 'umbrella' } ) ],
		async setup( ctx ) {

			Object.assign( run, { escaping: false, leg: 0, pickup: 0, movedAt: - 99, threat: 0, heldCar: 0, taken: false, carried: false, carriers: 0, gas: 0, broken: 0 } );
			ctx.presentation.focus( [ - 215, - 250 ], 0.6 );
			const crowds: Sdk.CrowdSpawnOptions[] = [ { id: 'speaker', label: 'Speaker', at: STAND, people: 14, groupSize: 14, spread: 2, agitation: [ 0, 0.05 ], resolve: [ 1.5, 2 ], morale: 0.95, speed: [ 1.3, 1.3 ] },
				{ id: 'stewards', label: 'Stewards', at: STAND, people: 120, groupSize: 40, spread: 10, agitation: [ 0.05, 0.15 ], resolve: [ 1, 1.3 ], morale: 0.85 },
				{ id: 'listeners', label: 'Listeners', at: [ STAND[ 0 ] + 5, STAND[ 1 ] + 15 ], people: 2200, groupSize: 100, spread: 42, morale: 0.6 },
				...[ [ - 255, - 140 ], [ - 150, - 140 ], [ - 160, - 225 ] ].map( ( at, index ): Sdk.CrowdSpawnOptions => ( { id: `antifa-${index + 1}`, label: `AntiFa ${index + 1}`, at: [ at[ 0 ], at[ 1 ] ], people: 24, groupSize: 24, spread: 4, agitation: [ 0.35, 0.5 ], resolve: [ 1.3, 1.6 ], morale: 0.9, speed: [ 1.2, 1.25 ] } ) ),
				{ id: 'medics', label: 'Medics', at: [ STAND[ 0 ], STAND[ 1 ] - 25 ], people: 20, groupSize: 20, spread: 6, agitation: [ 0, 0.05 ], morale: 0.9, resolve: [ 1, 1.3 ], medic: true } ];
			for ( const options of crowds ) ctx.spawn.crowd( { ...options, goal: STAND, goalRadius: 30, mode: 'hold' } );
			for ( const squad of police ) ctx.spawn.squad( squad );
			const car = await ctx.spawn.vehicle( { id: 'rescue-car', label: 'Rescue car', at: PICKUPS[ 0 ], capacity: 2, selectable: false } ).settled;
			if ( car.status !== 'completed' ) throw new Error( 'Rescue car allocation failed' ); run.car = car.value;
			run.speaker = ctx.protected.create( { id: 'speaker-person', kind: 'person', label: 'Speaker', carrier: 'speaker',
				protection: { friendly, hostile: police.map( ( squad ) => squad.id ), radius: 2.5, downRadius: 8, seconds: 4, downSeconds: 8, minimum: 2, downMinimum: 4, advantage: 2, recoveryMinimum: 4 } } );
			ctx.spawn.bystanders( { id: 'onlookers', people: 800, destinations: [ 'preseren', 'square', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		}, behaviors: [ behavior( { id: 'rescue' } ) ], objectives: [ extract( { id: 'escape', protected: 'speaker-person', at: 'exit', radius: 30, seconds: 900 } ) ],
		outcomes: [ defineOutcome( { id: 'rescue-result', evaluate: () => run.taken ? { win: false, reason: 'The police stopped the car and dragged the Speaker out.' } : null } ) ],
		phase: ( { time } ) => `${run.escaping ? 'Escape to the car' : 'The Speaker is on the stand'} · ${timeText( 900 - time )} left`,
		score: ( { win, time, metrics } ) => ( { stars: Number( win ) + Number( win && time < 600 ) + Number( win && metrics.opinion >= 50 ),
			lines: [ [ 'Time', timeText( time ) ], [ 'Public sympathy', Math.round( metrics.opinion ) ], [ 'Protesters injured', metrics.counters.injuriesByPolice ], [ 'Officers injured', metrics.counters.officersInjured ],
				[ 'Arrested', metrics.counters.arrests ], [ 'Speaker carried', run.carried ? 'yes' : 'no' ], [ 'Carriers', run.carriers ], [ 'Police squads broken', run.broken ] ] } ),
	} );

};
