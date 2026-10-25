import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { defenseDirector, defenseTargets, defenseWarnings, deployDefense } from './defense-common.ts';

export const sdkVersion = 1;

const SOURCE_NAMES = { kongresni: 'Kongresni trg', preseren: 'Prešernov trg', station: 'PU Ljubljana', finance: 'Ministrstvo za finance' };

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

export default ( { defineScenario, defineBehavior, defineOutcome, holdBuilding, landmark, place, policeCommands, target }: typeof Sdk ) => {

	const waves: { id: string, at: number, people: number, label: string, from?: string, bikes?: number, morale?: number, agitation?: Sdk.CrowdSpawnOptions[ 'agitation' ] }[] = [
		{ id: 'students', at: 8, people: 2200, from: 'kongresni', label: 'Students', agitation: [ 0.1, 0.35 ] },
		{ id: 'metelkova', at: 120, people: 1800, from: 'preseren', label: 'Metelkova bloc', agitation: [ 0.1, 0.35 ] },
		{ id: 'cyclists', at: 190, people: 450, from: 'preseren', label: 'Friday cyclists', bikes: 1, agitation: [ 0.1, 0.35 ] },
		{ id: 'radicals', at: 250, people: 1100, from: 'station', label: 'Radicals', agitation: [ 0.5, 0.8 ], morale: 0.8 },
		{ id: 'unions', at: 400, people: 2600, from: 'kongresni', label: 'Trade unions', agitation: [ 0.1, 0.35 ] },
		{ id: 'late', at: 560, people: 1500, from: 'finance', label: 'Late arrivals', agitation: [ 0.1, 0.35 ] },
	];
	const arrivals = defineBehavior( {
		id: 'assembly-director',
		create() {

			const groups = new Map<any, any>();
			const direct = defenseDirector();
			const spawnedWaves = new Set<string>();
			const warn = defenseWarnings( 'assembly', { 1: [ - 404, - 55 ] } );
			let rally, targets;
			const refreshMarkers = ( ctx ) => {

				const next = waves.find( ( wave ) => ! spawnedWaves.has( wave.id ) );
				ctx.presentation.markers( next && next.at - ctx.time < 60
					? [ { id: 'next-wave', at: next.from, radius: 40, label: next.label, kind: 'warn', countdownTo: next.at } ] : [] );

			};
			const move = ( ctx, state, at, radius ) => {

				state.goalKind = at === state.rally ? 'rally' : 'target';
				return ctx.movement.move( state.actor, at, { radius } );

			};
			return {
				start( ctx ) {

				const building = ctx.spatial.buildingGeometry( 'assembly', { 1: [ - 404, - 55 ] } );
				rally = ctx.locations.get( 'square' );
				targets = defenseTargets( ctx, 'assembly', { 1: [ - 404, - 55 ] } );
				for ( const wave of waves ) {

					const from = ctx.locations.get( wave.from ), agitation = wave.agitation ?? [ 0.1, 0.35 ], angry = agitation[ 0 ] > 0.45;
					ctx.timeline.after( Math.max( 0, wave.at - 30 ), () => ctx.presentation.notice( `${wave.label}: ~${wave.people.toLocaleString()} people from ${SOURCE_NAMES[ wave.from ]} in ${formatTime( Math.min( 30, wave.at ) )}`, 'warn', from ) );
					ctx.timeline.after( wave.at, () => {

						const at = angry ? targets[ Math.floor( ctx.random() * targets.length ) ] : rally;
						const operations = [];
						for ( let offset = 0, index = 0; offset < wave.people; offset += 100, index ++ ) {

							const people = Math.min( 100, wave.people - offset );
							const operation = ctx.spawn.crowd( { id: `${wave.id}-${String( index + 1 ).padStart( 2, '0' )}`, label: wave.label,
								at: from, people, groupSize: 100, spread: 50, agitation, morale: wave.morale ?? 0.55, bikes: wave.bikes ?? 0,
								goal: at, goalRadius: angry ? 12 : 35 } );
							operations.push( operation );
							operation.settled.then( ( outcome ) => {

								if ( outcome.status === 'completed' ) groups.set( outcome.value, { actor: outcome.value, label: wave.label,
									rally, target: angry ? at : null, goalKind: angry ? 'target' : 'rally', committedAt: angry ? ctx.time : 0 } );

							} );

						}
						void Promise.all( operations.map( ( operation ) => operation.settled ) ).then( ( outcomes ) => {

							if ( ctx.signal.aborted || outcomes.some( ( outcome ) => outcome.status !== 'completed' ) ) return;
							spawnedWaves.add( wave.id ); refreshMarkers( ctx );

						} ).catch( () => {} );
						ctx.presentation.notice( `${wave.label} ${angry ? 'are heading straight for the building!' : 'are marching to the square'}`, angry ? 'bad' : 'warn', from );

					} );

				}
				ctx.timeline.after( 2, () => ctx.presentation.notice( 'Hold for 12 minutes. Keep them off the façade and keep the exits open.', 'info', building.position ) );
				refreshMarkers( ctx );

			},
				update( ctx ) {

					refreshMarkers( ctx );
					direct( ctx, groups, targets );

				},
				onEvent: warn,
			};

		},
	} );
	return defineScenario( {
		id: 'assembly-rules', menu: false, title: 'Assembly Rules Preview', subtitle: 'Hold the building and exits',
		brief: 'Students, cyclists, unions and radicals arrive near the National Assembly. Hold the building for twelve minutes and keep an evacuation exit open.',
		goals: [ 'Hold for 12:00', 'Prevent a facade breach', 'Keep an exit open' ],
		phase: ( { time } ) => {

			const wave = waves.find( ( entry ) => entry.at > time );
			if ( ! wave ) return `Hold out · ${formatTime( 720 - time )} left`;
			const from = SOURCE_NAMES[ wave.from ];
			return `Next: ${wave.label} from ${from} in ${formatTime( wave.at - time )}`;

		},
		indicators: [ { id: 'police-injuries', label: '★ Injuries caused by police ≤ 25', counter: 'injuriesByPolice', maximum: 25, warnAt: 15 } ],
		outcomes: [
			defineOutcome( { id: 'facade-breach', evaluate: ( { building } ) => building?.breach >= 1
				? { win: false, reason: 'Protesters forced their way into the Assembly.' } : null } ),
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
		resources: { gas: { capacity: 4 }, water: { capacity: 4 }, reinforce: { capacity: 3 } },
		commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ),
		locations: { assembly: target( 'Državni zbor' ), square: place( 'Trg republike' ), kongresni: place( 'Kongresni trg' ),
			preseren: place( 'Prešernov trg' ), metelkova: place( 'Metelkova' ), railway: landmark( 'Železniška postaja' ),
			tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ),
			station: landmark( 'PU Ljubljana' ), finance: landmark( 'Ministrstvo za finance' ) },
		setup( ctx ) {
			deployDefense( ctx, 'assembly', { 1: [ - 404, - 55 ] } );
		}, behaviors: [ arrivals( { id: 'arrivals' } ) ],
		objectives: [ holdBuilding( { id: 'hold', target: 'assembly', seconds: 720, exitAt: { 1: [ - 404, - 55 ] }, reason: 'the Assembly held. The crowd is going home.' } ) ],
	} );

};