import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { path } from './mission-path.ts';

export const sdkVersion = 1;
const STAND: Sdk.Point = [ - 205, - 178 ];
const LEGS: Sdk.Point[] = [ [ - 191, - 247 ], [ - 233, - 402 ], [ - 278, - 510 ], [ - 300, - 585 ], [ - 296, - 645 ] ];
const PICKUPS: Sdk.Point[] = [ [ - 318, - 772 ], [ - 84, - 760 ] ];
const ROUTE = path( [ STAND, [ - 191, - 245 ], [ - 201, - 278 ], [ - 216, - 338 ], [ - 233, - 402 ], [ - 245, - 446 ], [ - 264, - 497 ], [ - 277, - 508 ],
	[ - 289, - 521 ], [ - 294, - 534 ], [ - 298, - 548 ], [ - 301, - 605 ], [ - 302, - 620 ], [ - 299, - 632 ], [ - 295, - 645 ], [ - 294, - 675 ], [ - 297, - 688 ],
	[ - 307, - 719 ], [ - 310, - 730 ], [ - 316, - 759 ], PICKUPS[ 0 ] ] );
const EXITS: Sdk.Point[] = [ [ - 330, - 948 ], [ - 60, - 657 ], [ - 75, - 903 ] ];
const FORCES: { name: string; at: Sdk.Point }[] = [ { name: 'Slovenska', at: [ - 325, - 275 ] }, { name: 'Šubičeva', at: [ - 322, - 88 ] }, { name: 'Prešernov trg', at: [ - 62, - 76 ] } ];
const MOBILE_ORIGINS = { Slovenska: [ - 372, - 385 ], Barjanska: [ - 515, - 1300 ] };
const MOBILE_RESPONSE = [ [ 20, 'Slovenska', 'ahead' ], [ 55, 'Barjanska', 'car' ], [ 95, 'Slovenska', 'ahead' ], [ 140, 'Barjanska', 'ahead' ] ] as const;
const distance = ( first, second ) => Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ] );
const protestCluster = ( ctx ) => {

	const people = ( ctx.observation?.people ?? [] ).filter( ( person ) => person.faction === 'protester' && person.status === 'active' && distance( person.position, STAND ) <= 70 );
	if ( ! people.length ) return { count: 0, center: STAND };
	return { count: people.length, center: [ people.reduce( ( sum, person ) => sum + person.position[ 0 ], 0 ) / people.length,
		people.reduce( ( sum, person ) => sum + person.position[ 1 ], 0 ) / people.length ] as Sdk.Point };

};
const timeText = ( seconds ) => `${Math.floor( Math.max( 0, seconds ) / 60 )}:${String( Math.floor( Math.max( 0, seconds ) % 60 ) ).padStart( 2, '0' )}`;
const windArrow = ( wind ) => [ '→', '↗', '↑', '↖', '←', '↙', '↓', '↘' ][ ( Math.round( Math.atan2( wind[ 1 ], wind[ 0 ] ) / ( Math.PI / 4 ) ) + 8 ) % 8 ];

export default ( { defineScenario, defineBehavior, defineOutcome, landmark, place, policeCommands, protect, protestCommands, scenarioCommand }: typeof Sdk ) => {

	const run: any = { speaker: null, car: null, escaping: false, position: STAND, speakerState: 'active', capture: null, policeNear: 0, wind: [ 0.3, 0 ], leg: 0, pickup: 0, movedAt: - 99, threat: 0, heldCar: 0, taken: false, carried: false, carriers: 0, broken: 0 };
	const police = FORCES.flatMap( ( force, index ) => [ ...Array.from( { length: 3 }, ( _, part ) => ( { id: `force-${index}-${part}`, at: [ force.at[ 0 ] + ( part - 1 ) * 10, force.at[ 1 ] ] as Sdk.Point, people: 24 } ) ),
		{ id: `snatcher-${index}`, at: [ force.at[ 0 ], force.at[ 1 ] + 10 ] as Sdk.Point, people: 14 } ] ).concat( [ { id: 'reserve-1', at: [ - 436, - 41 ], people: 20 }, { id: 'reserve-2', at: [ - 426, - 41 ], people: 20 } ] );
	const friendly = [ 'speaker', 'stewards', 'listeners', 'antifa-1', 'antifa-2', 'antifa-3', 'medics' ];
	const behavior = defineBehavior( { id: 'rescue-escape-and-police', create() {

		let routeOperation, routeDestination, detouring = false, lastPolice = 0, lastSnatch = - 99, lastGas = - 99, lastDown = - 99;
		let exit: Sdk.Point, phase = 'stand', pendingId = 0, mobileSequence = 0, mobileScheduled = false;
		const chasing = new Set<string>(), waiting = new Map<string, Sdk.MapMarker>();
		const mobileCars: any[] = [];
		const assaults = new Map<string, any>(), brokenTargets = new Set<string>();
		const move = ( ctx ) => {

			const speaker = ctx.protected.get( run.speaker ); if ( ! speaker.actor || ! [ 'active', 'carried' ].includes( speaker.state ) ) return;
			routeDestination = run.leg < LEGS.length ? LEGS[ run.leg ] : ctx.vehicles.get( run.car ).position;
			routeOperation = ctx.movement.move( speaker.actor, routeDestination, { radius: run.leg < LEGS.length ? 6 : 3 } );

		};
		const tell = ( ctx, at, radius, label, seconds, action, announce = true ) => {

			const id = `rescue-action-${++ pendingId}`;
			waiting.set( id, { id, at, radius, label, kind: 'bad', countdownTo: ctx.time + seconds } ); ctx.presentation.markers( [ ...waiting.values() ] );
			if ( announce ) ctx.presentation.notice( `Police: ${label} in ${seconds} s`, 'warn', at );
			ctx.timeline.after( seconds, () => { waiting.delete( id ); ctx.presentation.markers( [ ...waiting.values() ] ); action(); } );

		};
		const chase = ( ctx, id, at ) => ctx.commands.execute( 'arrest', { at, radius: 14, selection: [ ctx.actors.resolve( id ) ] } );
		const ahead = ( ctx, lead = 110 ) => {

			const speaker = ctx.protected.get( run.speaker ), progress = ROUTE.project( speaker.position ?? STAND );
			return ROUTE.at( Math.min( progress + lead, ROUTE.length - 25 ) );

		};
		const lunge = ( ctx, mobile, delay ) => {

			if ( mobile.chasing || mobile.pendingLunge || ! mobile.crew ) return;
			const go = () => {

				mobile.pendingLunge = false;
				const speaker = ctx.protected.get( run.speaker ); if ( speaker.state === 'aboard' || ! speaker.position ) return;
				mobile.chasing = true; chase( ctx, mobile.crew.id, speaker.position );
				ctx.timeline.after( 30, () => {

					mobile.chasing = false;
					const position = ctx.protected.get( run.speaker ).position;
					if ( position && ctx.protected.get( run.speaker ).state !== 'aboard' ) ctx.movement.move( mobile.crew, position, { radius: 14 } );

				} );

			};
			if ( delay ) { mobile.pendingLunge = true; const speaker = ctx.protected.get( run.speaker ); tell( ctx, speaker.position ?? STAND, 8, 'mobile squad goes for the Speaker', delay, go ); }
			else go();

		};
		const dispatchMobile = ( ctx, road, task ) => {

			const speaker = ctx.protected.get( run.speaker ); if ( [ 'aboard', 'exited' ].includes( speaker.state ) ) return;
			const id = `mobile-${++ mobileSequence}`, origin = MOBILE_ORIGINS[ road ];
			ctx.presentation.notice( `A police car with a mobile squad is coming along ${road}`, 'warn', origin );
			const operation = ctx.spawn.vehicle( { id, at: origin, type: 'police-patrol', crew: 12, selectable: false } );
			void operation.settled.then( ( outcome ) => {

				if ( outcome.status !== 'completed' || ctx.signal.aborted ) return;
				const vehicle = ctx.vehicles.get( outcome.value ); let target;
				if ( task === 'car' ) target = ctx.vehicles.get( run.car ).position;
				else {

					const initial = ahead( ctx, 50 ), approach = ctx.spatial.roadRoute( origin, initial );
					const intercept = ahead( ctx, approach ? 50 + approach.length / 9 * 1.7 : 110 );
					target = ctx.spatial.walkable( intercept, 20 ) ?? intercept;

				}
				const driven = ctx.vehicles.drive( vehicle.handle, target, { expectedRevision: vehicle.revision } );
				if ( driven.status === 'completed' ) mobileCars.push( { handle: vehicle.handle, task, goal: target, goalProgress: ROUTE.project( target ), deployed: false, crew: null, lastMove: ctx.time, chasing: false, pendingLunge: false } );

			} );

		};
		const scheduleMobile = ( ctx ) => {

			if ( mobileScheduled ) return; mobileScheduled = true;
			for ( const [ delay, road, task ] of MOBILE_RESPONSE ) ctx.timeline.after( delay, () => dispatchMobile( ctx, road, task ) );

		};
		const mobileTick = ( ctx, speaker ) => {

			for ( const mobile of mobileCars ) {

				const vehicle = ctx.vehicles.get( mobile.handle ); if ( vehicle.moving || vehicle.speed >= 0.5 ) continue;
				if ( ! mobile.deployed ) {

					if ( vehicle.crew?.state !== 'aboard' ) continue;
					const deployed = ctx.vehicles.toggleCrew( vehicle.handle, { expectedRevision: vehicle.revision } );
					if ( deployed.status !== 'completed' || ! deployed.value.crew ) continue;
					mobile.deployed = true; mobile.crew = deployed.value.crew.handle;
					if ( mobile.task === 'ahead' ) {

						if ( speaker.position && ROUTE.project( speaker.position ) > mobile.goalProgress - 10 ) lunge( ctx, mobile, 0 );
						else { const span = ctx.spatial.roadSpan( mobile.goal, 24 ); ctx.movement.move( mobile.crew, span.b, { line: span.a, radius: 8 } ); }

					} else ctx.movement.move( mobile.crew, ctx.vehicles.get( run.car ).position, { radius: 8 } );
					continue;

				}
				const crew = ctx.actors.get( mobile.crew ); if ( ! crew?.center || ! speaker.position || [ 'aboard', 'exited' ].includes( speaker.state ) ) continue;
				if ( mobile.task === 'ahead' && ROUTE.project( speaker.position ) > mobile.goalProgress - 10 ) { lunge( ctx, mobile, 0 ); continue; }
				if ( ! mobile.chasing && crew.alive > 3 && distance( crew.center, speaker.position ) < 25 ) { lunge( ctx, mobile, 2 ); continue; }
				if ( mobile.task === 'car' && ! mobile.chasing ) {

					const carPosition = ctx.vehicles.get( run.car ).position;
					if ( distance( crew.center, carPosition ) > 25 && ctx.time - mobile.lastMove > 10 ) { mobile.lastMove = ctx.time; ctx.movement.move( mobile.crew, carPosition, { radius: 8 } ); }

				}

			}

		};
		const aimAssault = ( ctx, assault ) => {

			if ( assault.aiming ) return;
			const target = ctx.actors.get( assault.target ); if ( ! target?.center ) return;
			assault.aimT = ctx.time;
			const operation = ctx.movement.move( assault.actor, target.center, { radius: 4 } ); assault.aiming = operation;
			void operation.settled.then( () => { if ( assault.aiming === operation ) assault.aiming = null; } );

		};
		const startAssault = ( ctx, event ) => {

			const attackers = event.selection.filter( ( actor ) => actor.id.startsWith( 'antifa-' ) && ctx.actors.get( actor )?.alive > 0 );
			if ( ! attackers.length ) { ctx.presentation.notice( 'Only AntiFa squads assault the police', 'warn' ); return; }
			const targetIds = [ ...police.map( ( squad ) => squad.id ), ...mobileCars.flatMap( ( mobile ) => mobile.crew ? [ mobile.crew.id ] : [] ) ];
			const targets = targetIds.map( ( id ) => ctx.actors.resolve( id ) ).filter( Boolean ).map( ( handle ) => ctx.actors.get( handle ) )
				.filter( ( actor ) => actor?.center && actor.alive > 0 && ! brokenTargets.has( actor.handle.id ) )
				.map( ( actor ) => ( { actor, distance: distance( actor.center, event.at ) } ) ).filter( ( candidate ) => candidate.distance < 30 )
				.sort( ( first, second ) => first.distance - second.distance );
			const target = targets[ 0 ]?.actor;
			if ( ! target ) { ctx.presentation.notice( 'No police squad there', 'warn' ); return; }
			for ( const actor of attackers ) {

				assaults.set( actor.id, { actor, target: target.handle, aimT: ctx.time, aiming: null } );
				ctx.actors.configure( actor, { speed: 1.7 } ); ctx.crowd.setMode( actor, 'push' ); aimAssault( ctx, assaults.get( actor.id ) );

			}
			ctx.opinion.adjust( - 2, 'AntiFa attack the police' );
			ctx.presentation.notice( `${attackers.map( ( actor ) => actor.id ).join( ', ' )} going for ${target.handle.id}`, 'warn', target.center );

		};
		const stopAssault = ( ctx, actor ) => {

			if ( ! assaults.delete( actor.id ) ) return;
			ctx.actors.configure( actor, { speed: 1.2 } );

		};
		const assaultTick = ( ctx, sample ) => {

			for ( const [ actorId, assault ] of assaults ) {

				const attacker = ctx.actors.get( assault.actor ), target = ctx.actors.get( assault.target );
				if ( ! attacker?.alive || ! target?.center ) { assaults.delete( actorId ); continue; }
				if ( brokenTargets.has( target.handle.id ) || target.alive < Math.max( 4, sample.people.filter( ( person ) => person.actor === target.handle ).length * 0.4 ) ) {

					assaults.delete( actorId );
					const gap = distance( attacker.center, target.center ) || 1;
					ctx.movement.move( assault.actor, [ attacker.center[ 0 ] + ( attacker.center[ 0 ] - target.center[ 0 ] ) / gap * 20,
						attacker.center[ 1 ] + ( attacker.center[ 1 ] - target.center[ 1 ] ) / gap * 20 ], { radius: 8 } );
					for ( const person of sample.people ) if ( person.actor === attacker.handle && person.faction === 'protester' && person.status === 'active' ) {

						ctx.effects.nudge( person.handle, { agitation: - 0.3, expectedSample: sample.sequence } );

					}
					if ( ! brokenTargets.has( target.handle.id ) ) {

						brokenTargets.add( target.handle.id ); ctx.movement.move( target.handle, [ - 436, - 41 ], { radius: 8 } ); run.broken ++;
						ctx.presentation.notice( `${target.handle.id} is broken and runs`, 'good', target.center );

					}
					continue;

				}
				if ( ! assault.aiming && ctx.time - assault.aimT > 2 ) aimAssault( ctx, assault );
				const attackers = sample.people.filter( ( person ) => person.actor === attacker.handle && person.faction === 'protester' && person.status === 'active' );
				for ( const person of attackers ) if ( person.agitation > 0.56 ) ctx.effects.nudge( person.handle, { agitation: 0.55 - person.agitation, expectedSample: sample.sequence } );
				for ( const person of sample.people ) {

					if ( person.actor !== target.handle || person.faction !== 'police' || person.status !== 'active' ) continue;
					let contacts = 0;
					for ( const protester of attackers ) if ( distance( protester.position, person.position ) < 2.5 ) contacts ++;
					if ( contacts && ctx.random() < 1 - ( 1 - 0.2 ) ** contacts ) ctx.effects.apply( person.handle, { status: 'injured', source: 'other', expectedSample: sample.sequence } );

				}

			}

		};
		let chargeStarted = false;
		const beginCharge = ( ctx ) => {

			if ( chargeStarted ) return; chargeStarted = true;
			lastSnatch = ctx.time - 10;
			const { center } = protestCluster( ctx );
			ctx.presentation.notice( 'Police: baton charges from Slovenska, Šubičeva and Prešernov trg in 8 s', 'bad', center );
			for ( const [ index, force ] of FORCES.entries() ) {

				const delta = [ force.at[ 0 ] - center[ 0 ], force.at[ 1 ] - center[ 1 ] ], length = Math.hypot( ...delta ) || 1;
				const target = [ center[ 0 ] + delta[ 0 ] / length * Math.min( length, 25 ), center[ 1 ] + delta[ 1 ] / length * Math.min( length, 25 ) ];
				tell( ctx, target, 14, `charge from ${force.name}`, 8, () => {

					ctx.commands.execute( 'charge', { at: target, selection: Array.from( { length: 3 }, ( _, part ) => ctx.actors.resolve( `force-${index}-${part}` ) ) } );
					if ( ! run.escaping ) {

						run.escaping = true; phase = 'escape'; move( ctx ); scheduleMobile( ctx );
						ctx.timeline.after( 14, () => {

							const crowd = protestCluster( ctx ); if ( crowd.count < 50 ) return;
							const selection = police.filter( ( squad ) => squad.id.startsWith( 'force-' ) ).map( ( squad ) => ctx.actors.get( ctx.actors.resolve( squad.id ) ) )
								.filter( ( actor ) => actor?.alive > 5 && ! brokenTargets.has( actor.handle.id ) ).map( ( actor ) => actor.handle );
							if ( ! selection.length ) return;
							const radius = Math.max( 20, Math.min( 45, Math.sqrt( crowd.count / 1.6 / Math.PI ) ) );
							ctx.commands.execute( 'kettle', { at: crowd.center, selection, radius } );

						} );

					}

				}, false );

			}

		};
		return {
			start( ctx ) {

				ctx.timeline.after( 2, () => ctx.presentation.notice( 'The Speaker is on the stand. Riot squads are forming up on Slovenska, Šubičeva and Prešernov trg', 'info', STAND ) );
				ctx.timeline.after( 14, () => ctx.presentation.notice( 'When the police charge, the Speaker leaves down Vegova for the car on Krakovska: keep the way clear', 'info', LEGS[ 0 ] ) );
				ctx.timeline.after( 45, () => ctx.presentation.notice( 'The riot squads are lining up: the charge is coming', 'warn', FORCES[ 0 ].at ) );
			},
			observe( ctx, sample ) {

				const speaker = ctx.protected.get( run.speaker ), car = ctx.vehicles.get( run.car );
				run.speakerState = speaker.state; run.position = speaker.position ?? run.position;
				run.capture = speaker.capture;
				const policeNear = speaker.position ? ctx.spatial.count( { at: speaker.position, radius: 15, faction: 'police' } ) : null;
				if ( policeNear !== null ) run.policeNear = policeNear;
				mobileTick( ctx, speaker );
				assaultTick( ctx, sample );
				if ( speaker.state === 'down' && speaker.position && speaker.capture?.available && speaker.capture.friendly >= 4 && speaker.capture.hostile < speaker.capture.friendly ) {

					const carrier = sample.people.filter( ( person ) => friendly.includes( person.actor.id ) && person.actor.id !== 'medics' && person.status === 'active' && distance( person.position, speaker.position ) < 8 )
						.sort( ( first, second ) => distance( first.position, speaker.position ) - distance( second.position, speaker.position ) )[ 0 ];
					if ( carrier && ctx.protected.transfer( run.speaker, { carrier: carrier.handle, expectedRevision: speaker.revision, expectedSample: sample.sequence, promote: true, radius: 8 } ).status === 'completed' ) {

						run.carried = true; run.carriers ++; if ( run.escaping ) move( ctx );

					}
					return;

				}
				if ( speaker.state === 'aboard' ) {

					if ( phase !== 'car' ) { phase = 'car';
						const exits = EXITS.map( ( at ) => {

							if ( distance( at, car.position ) < 60 ) return null;
							const route = ctx.spatial.roadRoute( car.position, at ); if ( ! route ) return null;
							const road = path( route.points ); let policeOnRoute = 0;
							for ( let along = 0; along < route.length; along += 10 ) {

								const count = ctx.spatial.count( { at: road.at( along ), radius: 10, faction: 'police' } );
								if ( count === null ) return null;
								policeOnRoute += count;

							}
							return { at, score: route.length + policeOnRoute * 60 };

						} ).filter( Boolean ).sort( ( first, second ) => first.score - second.score );
						exit = exits[ 0 ]?.at ?? EXITS[ 0 ];
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
				if ( ! chargeStarted && ctx.time >= 67 ) beginCharge( ctx );
				const speaker = ctx.protected.get( run.speaker ); if ( ! speaker.position || [ 'aboard', 'exited' ].includes( speaker.state ) ) return;
				if ( speaker.state !== 'down' ) {

					for ( const id of chasing ) { const squad = ctx.actors.get( ctx.actors.resolve( id ) ); if ( squad?.alive > 5 ) chase( ctx, id, speaker.position ); }
					for ( const mobile of mobileCars ) if ( mobile.chasing && mobile.crew && ctx.actors.get( mobile.crew )?.alive > 0 ) chase( ctx, mobile.crew.id, speaker.position );

				}
				if ( speaker.state === 'down' && ctx.time - lastDown >= 6 ) {

					lastDown = ctx.time;
					const squads = [ ...police.map( ( entry ) => ctx.actors.get( ctx.actors.resolve( entry.id ) ) ),
						...mobileCars.filter( ( mobile ) => mobile.deployed && mobile.crew ).map( ( mobile ) => ctx.actors.get( mobile.crew ) ) ];
					for ( const squad of squads.filter( ( actor ) => actor?.center && actor.alive > 5 ).sort( ( first, second ) => distance( first.center, speaker.position ) - distance( second.center, speaker.position ) ).slice( 0, 2 ) ) ctx.movement.move( squad.handle, speaker.position );

				}
				if ( speaker.state !== 'down' && ctx.time >= 75 && ctx.time - lastSnatch >= ( run.escaping ? 25 : 35 ) ) {

					const available = police.filter( ( entry ) => entry.id.startsWith( 'snatcher-' ) || entry.id.startsWith( 'reserve-' ) )
						.map( ( entry ) => ctx.actors.get( ctx.actors.resolve( entry.id ) ) ).filter( ( actor ) => actor?.center && actor.alive > 5 && ! chasing.has( actor.handle.id ) && distance( actor.center, speaker.position ) < 260 )
						.sort( ( first, second ) => distance( first.center, speaker.position ) - distance( second.center, speaker.position ) );
					if ( available.length ) { lastSnatch = ctx.time; const id = available[ 0 ].handle.id;
						tell( ctx, speaker.position, 10, `${id} for the Speaker`, 5, () => { chasing.add( id ); chase( ctx, id, ctx.protected.get( run.speaker ).position ?? speaker.position );
							ctx.timeline.after( 45, () => { chasing.delete( id ); const at = ctx.protected.get( run.speaker ).position; if ( at ) ctx.movement.move( ctx.actors.resolve( id ), at ); } ); } ); }

				}
				if ( ctx.time - lastGas > 40 && ctx.resources.get( 'gas' ).available ) for ( const id of chasing ) {

					const squad = ctx.actors.get( ctx.actors.resolve( id ) );
					if ( ! squad?.center || distance( squad.center, speaker.position ) >= 50 || ( ctx.spatial.count( { at: squad.center, radius: 15, faction: 'protester' } ) ?? 0 ) < 80 ) continue;
					lastGas = ctx.time; const at = squad.center.map( ( value, axis ) => value + ( speaker.position[ axis ] - value ) * 0.6 );
					tell( ctx, at, 20, 'tear gas', 6, () => { void ctx.commands.execute( 'gas', { at: [ at[ 0 ], at[ 1 ] ], opinion: { delta: 1.5, reason: 'tear gas on camera' } } ); } ); break;

				}

			},
			onEvent( ctx, event ) {

				if ( event.type === 'command.applied' ) {

					if ( event.command === 'antifa-assault' ) { startAssault( ctx, event ); return; }
					for ( const actor of event.selection ?? [] ) if ( assaults.has( actor.id ) ) stopAssault( ctx, actor );

				}
				const actor = ctx.protected.get( run.speaker ).actor;
				if ( event.type === 'player.move' ) stopAssault( ctx, event.actor );
				if ( event.type === 'player.move' && event.actor === actor ) { detouring = true; run.escaping = true; phase = 'escape'; scheduleMobile( ctx ); }
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
		resources: { gas: { capacity: 4 }, umbrella: { capacity: 3 } }, commands: [ ...policeCommands( { gas: 'gas', crew: true } ), ...protestCommands( { umbrella: 'umbrella' } ),
			scenarioCommand( { id: 'antifa-assault', key: 'a', label: 'Assault', selection: 'crowd', side: 'protest' } ) ],
		async setup( ctx ) {

			Object.assign( run, { escaping: false, position: STAND, speakerState: 'active', capture: null, policeNear: 0, leg: 0, pickup: 0, movedAt: - 99, threat: 0, heldCar: 0, taken: false, carried: false, carriers: 0, broken: 0 } );
			const angle = ctx.random() * Math.PI * 2, speed = 0.3 + ctx.random() * 0.5;
			run.wind = [ Math.cos( angle ) * speed, Math.sin( angle ) * speed ];
			await ctx.environment.configure( { wind: run.wind } );
			ctx.presentation.focus( [ - 215, - 250 ], 0.6 );
			const crowds: Sdk.CrowdSpawnOptions[] = [ { id: 'speaker', label: 'Speaker', at: STAND, people: 14, groupSize: 14, spread: 2, agitation: [ 0, 0.05 ], resolve: [ 1.5, 2 ], morale: 0.95, speed: [ 1.3, 1.3 ] },
				{ id: 'stewards', label: 'Stewards', at: STAND, people: 120, groupSize: 40, spread: 10, agitation: [ 0.05, 0.15 ], resolve: [ 1, 1.3 ], morale: 0.85 },
				{ id: 'listeners', label: 'Listeners', at: [ STAND[ 0 ] + 5, STAND[ 1 ] + 15 ], people: 2200, groupSize: 100, spread: 42, morale: 0.6 },
				...[ [ - 255, - 140 ], [ - 150, - 140 ], [ - 160, - 225 ] ].map( ( at, index ): Sdk.CrowdSpawnOptions => ( { id: `antifa-${index + 1}`, label: `AntiFa ${index + 1}`, at: [ at[ 0 ], at[ 1 ] ], people: 24, groupSize: 24, spread: 4, agitation: [ 0.35, 0.5 ], resolve: [ 1.3, 1.6 ], morale: 0.9, speed: [ 1.2, 1.25 ] } ) ),
				{ id: 'medics', label: 'Medics', at: [ STAND[ 0 ], STAND[ 1 ] - 25 ], people: 20, groupSize: 20, spread: 6, agitation: [ 0, 0.05 ], morale: 0.9, resolve: [ 1, 1.3 ], medic: true } ];
			for ( const options of crowds ) {

				const operation = ctx.spawn.crowd( { ...options, goal: STAND, goalRadius: 30, mode: 'hold' } );
				if ( options.id === 'speaker' || options.id.startsWith( 'antifa-' ) ) {

					const outcome = await operation.settled;
					if ( outcome.status !== 'completed' ) throw new Error( `Rescue actor ${options.id} allocation failed` );
					ctx.actors.configure( outcome.value, { closed: true, ...( options.id === 'speaker' ? { parting: true } : {} ) } );

				}

			}
			for ( const squad of police ) ctx.spawn.squad( squad );
			const car = await ctx.spawn.vehicle( { id: 'rescue-car', label: 'Rescue car', at: PICKUPS[ 0 ], capacity: 2, selectable: false } ).settled;
			if ( car.status !== 'completed' ) throw new Error( 'Rescue car allocation failed' ); run.car = car.value;
			run.speaker = ctx.protected.create( { id: 'speaker-person', kind: 'person', label: 'Speaker', carrier: 'speaker',
				protection: { friendly, hostile: police.map( ( squad ) => squad.id ), radius: 2.5, downRadius: 8, seconds: 4, downSeconds: 8, minimum: 2, downMinimum: 4, advantage: 2, recoveryMinimum: 4 } } );
			ctx.spawn.bystanders( { id: 'onlookers', people: 800, destinations: [ 'preseren', 'square', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		}, behaviors: [ behavior( { id: 'rescue' } ) ],
		objectives: [ protect( { id: 'escape', protected: 'speaker-person', seconds: 900, label: 'Get the Speaker to safety' } ) ],
		outcomes: [ defineOutcome( { id: 'rescue-result', evaluate: ( { time, observation } ) => {

			if ( run.taken ) return { win: false, reason: 'The police stopped the car and dragged the Speaker out.' };
			const speaker = observation?.protected.find( ( entity ) => entity.handle.id === 'speaker-person' );
			if ( speaker?.state === 'captured' ) return { win: false, reason: 'The police took the Speaker.' };
			if ( speaker?.state === 'exited' ) return { win: true, reason: `The Speaker got away at ${timeText( time )}${run.carried ? ', carried to the car by the crowd' : ''}.` };
			if ( time >= 900 ) return { win: false, reason: 'The police sealed off the district. The Speaker is trapped.' };
			return null;

		} } ) ],
		phase: ( { time } ) => {

			const where = [ 'aboard', 'exited' ].includes( run.speakerState ) ? 'SPEAKER IN THE CAR' : run.speakerState === 'down' ? 'SPEAKER DOWN'
				: ! run.escaping ? 'the Speaker is on the stand' : `Speaker ${Math.round( Math.max( 0, ROUTE.length - ROUTE.project( run.position ) ) )} m from the car`;
			return `${where} · ${timeText( 900 - time )} left · wind ${windArrow( run.wind )}`;

		},
		hud: ( { time, metrics } ) => {

			const boarded = [ 'aboard', 'exited' ].includes( run.speakerState ), down = run.speakerState === 'down';
			const distanceLeft = Math.max( 0, ROUTE.length - ROUTE.project( run.position ) ), captureTime = run.capture?.held ?? 0, captureRequired = run.capture?.required ?? 4;
			return [
				{ label: 'Speaker to the rescue car', value: boarded ? 1 : Math.min( 1, ROUTE.project( run.position ) / ROUTE.length ),
					text: boarded ? 'in the car' : down ? 'DOWN!' : run.escaping ? `${Math.round( distanceLeft )} m` : 'on the stand', state: down ? 'bad' : boarded ? 'done' : 'ok' },
				{ label: 'Police near the Speaker', value: captureTime > 0 ? captureTime / captureRequired : Math.min( 1, run.policeNear / 12 ),
					text: captureTime > 0 ? `SEIZED · ${Math.ceil( captureRequired - captureTime )} s` : `${run.policeNear}`,
					state: captureTime > 0 || run.policeNear > 6 ? 'bad' : run.policeNear > 2 ? 'warn' : 'ok', invert: true },
				{ label: '★ Away before 10:00', value: Math.min( 1, time / 600 ), text: time < 600 ? timeText( 600 - time ) : 'missed', state: time < 600 ? 'ok' : 'bad', invert: true },
				{ label: '★ Sympathy ≥ 50', value: metrics.opinion / 100, text: `${Math.round( metrics.opinion )}`, state: metrics.opinion < 50 ? 'bad' : 'ok' },
			];

		},
		score: ( { win, time, metrics } ) => ( { stars: Number( win ) + Number( win && time < 600 ) + Number( win && metrics.opinion >= 50 ),
			lines: [ [ 'Time', timeText( time ) ], [ 'Speaker carried', run.carriers ? `yes (${run.carriers}×)` : 'no' ], [ 'Public sympathy', Math.round( metrics.opinion ) ],
				[ 'Protesters injured', metrics.counters.injuriesByPolice ], [ 'Treated by medics', metrics.counters.treatedByMedics ], [ 'Arrested', metrics.counters.arrests ],
				[ 'Officers injured', metrics.counters.officersInjured ], [ 'Police squads broken', run.broken ], [ 'Tear gas fired', metrics.counters.gasUsed ] ] } ),
	} );

};
