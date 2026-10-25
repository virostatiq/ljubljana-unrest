import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { defenseDirector, defenseTargets, defenseWarnings, deployDefense } from './defense-common.ts';

export const sdkVersion = 1;

function inRing( ring, x, y ) {

	let inside = false;
	const count = ring.length / 2;
	for ( let current = 0, previous = count - 1; current < count; previous = current ++ ) {

		const x0 = ring[ current * 2 ], y0 = ring[ current * 2 + 1 ], x1 = ring[ previous * 2 ], y1 = ring[ previous * 2 + 1 ];
		if ( ( y0 > y ) !== ( y1 > y ) && x < ( x1 - x0 ) * ( y - y0 ) / ( y1 - y0 ) + x0 ) inside = ! inside;

	}
	return inside;

}

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

const FORCE_REACTIONS = Object.freeze( {
	charge: Object.freeze( { radius: 45, agitation: 0.2, label: 'Baton charge' } ),
	kettle: Object.freeze( { radius: 50, agitation: 0.25, label: 'Kettle' } ),
	gas: Object.freeze( { radius: 60, agitation: 0.25, label: 'Tear gas' } ),
	water: Object.freeze( { radius: 50, agitation: 0.2, label: 'Water cannon' } ),
	arrest: Object.freeze( { radius: 35, agitation: 0.12, label: 'Arrests' } ),
	snatch: Object.freeze( { radius: 35, agitation: 0.12, label: 'Snatch squad' } ),
	'shield-push': Object.freeze( { radius: 40, agitation: 0.15, label: 'Shield push' } ),
} );

function injuryCounts( observation ) {

	const counts = new Map<any, any>();
	for ( const person of observation?.people ?? [] ) if ( person.faction === 'protester' && [ 'injured', 'detained' ].includes( person.status ) ) {
		counts.set( person.actor.id, ( counts.get( person.actor.id ) ?? 0 ) + 1 );
	}
	return counts;

}

export default ( { defineBehavior, defineOutcome, defineScenario, holdBuilding, landmark, place, policeCommands, target }: typeof Sdk ) => {

	const routes: { name: string, legs: Sdk.Point[], rally: Sdk.Point }[] = [
		{ name: 'Prešernova', legs: [ [ - 668, - 216 ], [ - 700, - 300 ] ], rally: [ - 682, - 308 ] },
		{ name: 'Igriška', legs: [ [ - 410, - 279 ], [ - 500, - 361 ] ], rally: [ - 548, - 350 ] },
	];
	const waves: { id: string, at: number, people: number, label: string, from?: string, bikes?: number, morale?: number, agitation?: Sdk.CrowdSpawnOptions[ 'agitation' ] }[] = [
		{ id: 'students', at: 8, people: 2000, label: 'Students', agitation: [ 0.35, 0.6 ] },
		{ id: 'farmers', at: 130, people: 2000, label: 'Farmers', agitation: [ 0.35, 0.6 ] },
		{ id: 'cyclists', at: 200, people: 450, label: 'Friday cyclists', bikes: 1, agitation: [ 0.35, 0.6 ] },
		{ id: 'radicals', at: 270, people: 1000, label: 'Radicals', agitation: [ 0.55, 0.85 ], morale: 0.8 },
		{ id: 'everyone-else', at: 420, people: 2400, label: 'Everyone else', agitation: [ 0.35, 0.6 ] },
	];
	const columns = defineBehavior( {
		id: 'government-route-columns',
		create() {

			const groups = new Map<any, any>(), riotActors = new Set<any>();
			const direct = defenseDirector( ( actor ) => riotActors.add( actor.id ) );
			const warn = defenseWarnings( 'government' ), spawnedWaves = new Set<string>();
			let targets;
			const refreshMarkers = ( ctx ) => {

				const next = waves.find( ( wave ) => ! spawnedWaves.has( wave.id ) );
				ctx.presentation.markers( next && next.at - ctx.time < 60 ? [ { id: 'next-wave', at: [ - 545, - 243 ], radius: 40,
					label: next.label, kind: 'warn', countdownTo: next.at } ] : [] );

			};
			let previousHurt = new Map<any, any>(), lastForceNotice = - 99, lastHurtNotice = - 99;
			const issueMove = ( ctx, state, at, radius, next ) => {

				state.pending = true;
				const operation = ctx.movement.move( state.actor, at, { radius } );
				state.operation = operation;
				operation.settled.then( ( outcome ) => {

					if ( state.operation !== operation ) return;
					state.pending = false;
					if ( outcome.status !== 'completed' || ctx.signal.aborted ) return;
					state.destination = at;
					state.moving = true;
					state.goalKind = next.kind;
					state.leg = next.leg;

				} );

			};
			return {
				start( ctx ) {

					const counts = injuryCounts( ctx.observation );
					previousHurt = new Map( ( ctx.observation?.actors ?? [] ).filter( ( actor ) => actor.handle.kind === 'crowd' )
						.map( ( actor ) => [ actor.handle.id, counts.get( actor.handle.id ) ?? 0 ] ) );

					for ( const wave of waves ) {

						const at: Sdk.Point = [ - 545, - 243 ];
						ctx.timeline.after( Math.max( 0, wave.at - 30 ), () => ctx.presentation.notice(
							`${wave.label}: ~${wave.people.toLocaleString()} people from Erjavčeva in ${formatTime( Math.min( 30, wave.at ) )}`, 'warn', at ) );
						ctx.timeline.after( wave.at, () => {

							const operations = [];
							for ( let offset = 0, index = 0; offset < wave.people; offset += 100, index ++ ) {

								const people = Math.min( 100, wave.people - offset ), route = routes[ index % routes.length ];
								const operation = ctx.spawn.crowd( { id: `${wave.id}-${String( index + 1 ).padStart( 2, '0' )}`,
									label: wave.label, at, people, groupSize: 100, spread: 35, agitation: wave.agitation,
									morale: wave.morale ?? 0.55, bikes: wave.bikes ?? 0, goal: route.legs[ 0 ], goalRadius: 12 } );
								operations.push( operation );
								operation.settled.then( ( outcome ) => {

									if ( outcome.status === 'completed' && ! ctx.signal.aborted ) groups.set( outcome.value.id, {
										actor: outcome.value, label: wave.label, route, leg: 0, goalKind: 'route', destination: route.legs[ 0 ], moving: true, pending: false,
									} );

								} );

							}
							void Promise.all( operations.map( ( operation ) => operation.settled ) ).then( ( outcomes ) => {

								if ( ctx.signal.aborted || outcomes.some( ( outcome ) => outcome.status !== 'completed' ) ) return;
								spawnedWaves.add( wave.id ); refreshMarkers( ctx );

							} ).catch( () => {} );
							ctx.presentation.notice( `${wave.label} set off from Erjavčeva by ${routes.map( ( route ) => route.name ).join( ' and ' )}`, 'bad', at );

						} );

					}
					refreshMarkers( ctx );

				},
				onEvent( ctx, event ) {

					warn( ctx, event );
					if ( event.type !== 'command.applied' ) return;
					const reaction = FORCE_REACTIONS[ event.command ];
					if ( ! reaction || ! event.at ) return;
					let affected = 0;
					for ( const actor of ctx.observation?.actors ?? [] ) {

						if ( actor.handle.kind !== 'crowd' || ! actor.center || Math.hypot( actor.center[ 0 ] - event.at[ 0 ], actor.center[ 1 ] - event.at[ 1 ] ) >= reaction.radius ) continue;
						const active = ctx.people.members( actor.handle ).filter( ( person ) => person.faction === 'protester' && person.status === 'active' );
						if ( ! active.length ) continue;
						const result = ctx.crowd.nudge( actor.handle, { agitation: reaction.agitation } );
						if ( result.status !== 'completed' ) continue;
						const state = groups.get( actor.handle.id );
						if ( reaction.agitation >= 0.2 && state?.goalKind !== 'route' && ! riotActors.has( actor.handle.id ) ) {

							if ( ctx.crowd.setMode( actor.handle, 'riot' ).status === 'completed' ) riotActors.add( actor.handle.id );

						}
						affected += result.value?.people ?? active.length;

					}
					if ( affected > 50 && ctx.time - lastForceNotice > 10 ) {

						lastForceNotice = ctx.time;
						ctx.presentation.notice( `${reaction.label}: ~${affected} people around it turn on the police`, 'bad', event.at );

					}

				},
				observe( ctx, sample ) {

					const counts = injuryCounts( sample ), protesters = new Set( sample.people.filter( ( person ) => person.faction === 'protester' ).map( ( person ) => person.actor.id ) );
					let worst = null, worstFresh = 0;
					for ( const actor of sample.actors ) {

						if ( actor.handle.kind !== 'crowd' || ! protesters.has( actor.handle.id ) ) continue;
						const current = counts.get( actor.handle.id ) ?? 0, previous = previousHurt.get( actor.handle.id ) ?? 0;
						previousHurt.set( actor.handle.id, current );
						const fresh = current - previous;
						if ( fresh <= 0 || ! actor.center ) continue;
						const agitation = Math.min( 0.35, 0.1 * fresh );
						if ( ctx.crowd.nudge( actor.handle, { agitation, resolve: 0.05 } ).status !== 'completed' ) continue;
						for ( const neighbor of sample.actors ) {

							if ( neighbor.handle.id === actor.handle.id || neighbor.handle.kind !== 'crowd' || ! protesters.has( neighbor.handle.id ) || ! neighbor.center
								|| Math.hypot( neighbor.center[ 0 ] - actor.center[ 0 ], neighbor.center[ 1 ] - actor.center[ 1 ] ) >= 50 ) continue;
							ctx.crowd.nudge( neighbor.handle, { agitation: agitation / 2 } );

						}
						if ( fresh > worstFresh ) { worst = { label: groups.get( actor.handle.id )?.label ?? actor.handle.id, center: actor.center }; worstFresh = fresh; }

					}
					if ( worst && ctx.time - lastHurtNotice > 15 ) {

						lastHurtNotice = ctx.time;
						ctx.presentation.notice( `${worst.label}: they saw their own people beaten — the crowd around them boils over`, 'bad', worst.center );

					}

				},
				update( ctx ) {

					refreshMarkers( ctx );
					for ( const state of groups.values() ) {

						if ( state.pending ) continue;
						const actor = ctx.actors.get( state.actor );
						if ( ! actor?.center ) continue;
						if ( state.moving ) {

							if ( Math.hypot( actor.center[ 0 ] - state.destination[ 0 ], actor.center[ 1 ] - state.destination[ 1 ] ) > 25 ) continue;
							state.moving = false;

						}
						if ( state.goalKind !== 'route' ) continue;
						if ( state.leg + 1 < state.route.legs.length ) {

							const leg = state.leg + 1;
							issueMove( ctx, state, state.route.legs[ leg ], 12, { kind: 'route', leg } );

						} else issueMove( ctx, state, state.route.rally, 25, { kind: 'rally', leg: state.leg } );

					}
					direct( ctx, groups, () => targets ??= defenseTargets( ctx, 'government' ) );

				},
			};

		},
	} );
	return defineScenario( {
		id: 'government-rules', menu: false, title: 'Government Palace Rules Preview', subtitle: 'Hold the building and exits',
		brief: 'Students, farmers, cyclists and radicals gather on Erjavčeva. Keep the two protest columns off the Government building and preserve an evacuation exit.',
		goals: [ 'Hold for 12:00', 'Prevent a facade breach', 'Keep an exit open' ],
		phase: ( { time } ) => {

			const wave = waves.find( ( entry ) => entry.at > time );
			return wave ? `Next: ${wave.label} from Erjavčeva in ${formatTime( wave.at - time )}` : `Hold out · ${formatTime( 720 - time )} left`;

		},
		indicators: [ { id: 'police-injuries', label: '★ Injuries caused by police ≤ 25', counter: 'injuriesByPolice', maximum: 25, warnAt: 15 } ],
		outcomes: [
			defineOutcome( { id: 'facade-breach', evaluate: ( { building } ) => building?.breach >= 1
				? { win: false, reason: 'Protesters forced their way into the Government building.' } : null } ),
			defineOutcome( { id: 'evacuation-blocked', evaluate: ( { building } ) => building?.evacuation >= 1
				? { win: false, reason: 'Every exit was blocked — the evacuation could not proceed.' } : null } ),
		],
		score: ( { win, metrics } ) => {

			const second = win && metrics.opinion >= 45, third = win && metrics.counters.injuriesByPolice <= 25;
			const lines: [ string, string | number ][] = [
				[ 'Public opinion', Math.round( metrics.opinion ) ], [ 'Injuries caused by police', metrics.counters.injuriesByPolice ],
				[ 'Officers injured', metrics.counters.officersInjured ], [ 'Arrests', metrics.counters.arrests ], [ 'Tear gas used', metrics.counters.gasUsed ],
			];
			let stars = Number( win ) + Number( second ) + Number( third );
			if ( metrics.escalation >= 4 ) { stars = Math.min( stars, 1 ); lines.push( [ 'Firearms used', 'yes — max ★' ] ); }
			return { stars, lines };

		},
		resources: { gas: { capacity: 4 }, water: { capacity: 6 }, reinforce: { capacity: 3 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ),
		locations: { government: target( 'Vlada RS' ), preseren: place( 'Prešernov trg' ),
			kongresni: place( 'Kongresni trg' ), metelkova: place( 'Metelkova' ), railway: landmark( 'Železniška postaja' ),
			tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ), station: landmark( 'PU Ljubljana' ) },
		setup( ctx ) {
			deployDefense( ctx, 'government' );
		},
		behaviors: [ columns( { id: 'route-columns' } ) ],
		objectives: [ holdBuilding( { id: 'hold', target: 'government', seconds: 720, reason: 'the Government building held. The crowd is going home.' } ) ],
	} );

};