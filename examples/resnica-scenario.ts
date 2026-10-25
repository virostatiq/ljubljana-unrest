import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { gap, path, timeText } from './mission-path.ts';

export const sdkVersion = 1;
const FORCE_RADIUS = { charge: 150, kettle: 150, 'shield-push': 150, arrest: 120, snatch: 120, gas: 300, water: 300, firearms: Infinity };
const clockAt = ( time ) => { const minutes = 16 * 60 + 20 + time / 15; return `${Math.floor( minutes / 60 )}:${String( Math.floor( minutes % 60 ) ).padStart( 2, '0' )}`; };

export default ( { defineScenario, defineBehavior, defineOutcome, survive, place, landmark, policeCommands }: typeof Sdk ) => {

	const run: any = { closed: 0, water: 0, march: [], onlookers: [], ring: [], roads: [], traffic: [], inter: null, spots: [], side: [], dissolved: false, backlog: 0, tailback: 0 };
	const advanceTraffic = ( traffic, ring, dt ) => {

		let tailback = 0;
		for ( const [ index, road ] of traffic.entries() ) {
			road.wait += dt; const first = road.cars.at( - 1 );
			if ( road.wait > 1.4 ) { road.wait = 0; if ( ! first || first.s > 7.5 ) road.cars.push( { s: 0, v: 17 } ); else road.backlog ++; }
			if ( road.backlog && ( ! first || first.s > 15 ) ) { road.backlog --; road.cars.push( { s: 0, v: 8.5 } ); }
			let ahead = ring[ index ] >= 6 ? road.block - 6 : Infinity;
			for ( const car of road.cars ) { const limit = Math.min( ahead, road.length + 50 ) - car.s; car.v = limit < 0.5 ? 0 : Math.min( 17, car.v + 6 * dt, limit / Math.max( dt, 0.05 ) ); car.s += car.v * dt; ahead = car.s - 7.5; }
			road.cars = road.cars.filter( ( car ) => car.s < road.length );
			tailback += road.cars.filter( ( car ) => car.v < 1 ).length * 7.5 + road.backlog * 7.5;
		}
		return tailback;

	};
	const director = defineBehavior( { id: 'ring-road-crowds', create() {

		const decided = new Set(), home = new Set(), slow = new Set(), onRoad = new Set(); let lastDecision = 0, nextOrder = 0;
		const nearestRoad = ( at ) => run.roads.map( ( road ) => road.at( road.project( at ) ) ).sort( ( first, second ) => gap( first, at ) - gap( second, at ) )[ 0 ];
		const recruit = ( ctx, at, radius ) => {

			for ( const id of run.onlookers ) {

				const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( ! actor?.center || radius < Infinity && ( decided.has( id ) || gap( actor.center, at ) >= radius ) ) continue;
				if ( radius < Infinity ) { decided.add( id ); if ( ctx.random() >= 1 / 3 ) continue; }
				if ( ctx.actors.recruit( id ).status === 'completed' ) { run.march.push( id ); ctx.movement.move( ctx.actors.resolve( id ), run.inter, { radius: 30 } ); }

			}

		};
		return {
			start( ctx ) {

				ctx.timeline.after( 2, () => ctx.presentation.notice( 'The march is on Celovška, heading for the ring road', 'warn', run.inter ) );
				for ( const [ at, count, target, label ] of [ [ 540, 300, run.side[ 0 ], 'Vodnikova' ], [ 660, 200, run.side[ 1 ], 'Litostrojska' ] ] ) {

					ctx.timeline.after( at, () => { for ( let offset = 0; offset < count; offset += 100 ) {

						const id = `side-${at}-${offset}`; run.march.push( id ); ctx.spawn.crowd( { id, label: 'Side march', at: ctx.spatial.sample( [ target[ 0 ], target[ 1 ] - 350 ], { radius: 30 } ), people: Math.min( 100, count - offset ), groupSize: 100,
							spread: 20, goal: target, goalRadius: 15, agitation: [ 0.1, 0.4 ], morale: 0.9, resolve: [ 1.3, 1.5 ] } );

					} ctx.presentation.notice( `A group is heading for ${label}`, 'bad', target ); } );

				}

			},
			observe( ctx, sample ) {

				const counts = run.roads.map( () => 0 ), blocks = run.roads.map( () => Infinity );
				for ( const person of sample.people ) {

					if ( person.status !== 'active' || person.faction !== 'protester' ) continue;
					for ( const [ index, road ] of run.roads.entries() ) if ( gap( person.position, road.at( road.project( person.position ) ) ) < 9 ) { counts[ index ] ++; blocks[ index ] = Math.min( blocks[ index ], road.project( person.position ) ); break; }

				}
				run.ring = counts; run.traffic.forEach( ( road, index ) => { road.block = counts[ index ] >= 6 ? blocks[ index ] : Infinity; } );

			},
			update( ctx, dt ) {

				run.tailback = advanceTraffic( run.traffic, run.ring, dt );
				if ( run.ring.some( ( count ) => count >= 12 ) ) run.closed += dt;
				if ( ! ctx.observation || ctx.time - lastDecision < 8 ) return; lastDecision = ctx.time;
				for ( const id of run.march ) {

					const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( ! actor?.center || home.has( id ) ) continue;
					if ( ! slow.has( id ) && gap( actor.center, run.inter ) < 350 ) { slow.add( id ); ctx.actors.configure( id, { speed: 0.9 + ctx.random() * 0.2 } ); }
					if ( ctx.time > 1200 && ctx.random() < 0.08 ) { home.add( id ); ctx.actors.configure( id, { home: true } ); continue; }
					const closest = nearestRoad( actor.center ); if ( gap( closest, actor.center ) > 90 || onRoad.has( id ) && ctx.random() < 0.7 ) continue;
					const target = run.spots.map( ( at ) => ( { at, score: ( ctx.spatial.count( { at, radius: 30, faction: 'police' } ) ?? 0 ) * 3 + gap( at, actor.center ) * 0.3 + ctx.random() * 20 } ) ).sort( ( first, second ) => first.score - second.score )[ 0 ].at;
					onRoad.add( id ); ctx.movement.move( actor.handle, target, { radius: 14 } );

				}

			},
			onEvent( ctx, event ) {

				if ( event.type !== 'command.applied' ) return;
				if ( FORCE_RADIUS[ event.command ] ) { recruit( ctx, event.at, FORCE_RADIUS[ event.command ] );
					if ( ! run.dissolved && ! run.early && ( ctx.spatial.count( { at: event.at, radius: 60, faction: 'protester' } ) ?? 0 ) > 30 ) { run.early = true; ctx.opinion.adjust( - 4, 'force before dispersal order' ); } }
				if ( event.command === 'water' ) { run.water ++; const truck = ctx.vehicles.get( 'water-cannon' ), angle = Math.atan2( event.at[ 1 ] - truck.position[ 1 ], event.at[ 0 ] - truck.position[ 0 ] );
					ctx.timeline.after( 4, () => { const current = ctx.vehicles.get( 'water-cannon' ), hit: Sdk.Point = [ current.position[ 0 ] + Math.cos( angle ) * 28 * 0.6, current.position[ 1 ] + Math.sin( angle ) * 28 * 0.6 ];
						for ( const id of run.march ) { const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( ! actor?.center || home.has( id ) || gap( actor.center, hit ) >= 35 ) continue;
							const people = ctx.people.members( actor.handle ).filter( ( person ) => person.status === 'active' ); const agitation = people.reduce( ( total, person ) => total + person.agitation, 0 ) / ( people.length || 1 );
							if ( agitation < 0.35 && ctx.random() < 0.6 || ctx.random() < 0.15 ) { home.add( id ); ctx.actors.configure( id, { home: true } ); } else ctx.crowd.nudge( id, { agitation: 0.1, resolve: - 0.3 } ); }
					} ); }

			},
			onAction( ctx, action ) {

				if ( action.type !== 'key' || action.key?.toLowerCase() !== 'b' || ! action.at || ctx.time < nextOrder ) return; nextOrder = ctx.time + 12;
				if ( ( ctx.spatial.count( { at: action.at, radius: 70, faction: 'protester' } ) ?? 0 ) > 30 ) run.dissolved = true;
				for ( const id of run.march ) { const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( ! actor?.center || gap( actor.center, action.at ) >= 70 || home.has( id ) ) continue;
					if ( ! decided.has( id ) && ctx.random() < 0.1 ) { home.add( id ); ctx.actors.configure( id, { home: true } ); } else ctx.crowd.nudge( id, { agitation: 0.15 } ); decided.add( id ); }

			},
		};

	} } );
	return defineScenario( { id: 'resnica-rules', menu: false, city: 'north', title: 'Resni.ca Rules Preview', subtitle: 'Keep the northern ring road open',
		brief: 'A determined march travels up Celovška. Police force can turn roadside onlookers into marchers. Keep total ring-road closure below seven minutes until 18:00.',
		goals: [ 'Closure below 7:00', 'Hold until 18:00', 'Keep injuries and opinion under control' ],
		locations: { aleja: place( 'Aleja' ), litostrojska: place( 'Priključek Litostrojska' ), station: landmark( 'Policija' ), koseze: place( 'Tržnica Koseze' ), tivoli: place( 'Hala Tivoli' ), siska: place( 'Celovška · Šiška' ), zak: place( 'Stadion ŽAK' ) },
		opinion: { initial: 55, gas: - 5, water: - 1.5, weights: { injuriesByPolice: - 0.6, officersInjured: 0.2, arrests: - 0.04, sitterArrests: 0, otherInjuries: - 0.1 } },
		resources: { gas: { capacity: 1 }, water: { capacity: 10 }, reinforce: { capacity: 3 } }, commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ),
		async setup( ctx ) {

			Object.assign( run, { closed: 0, water: 0, march: [], onlookers: [], ring: [], traffic: [], spots: [], dissolved: false, early: false } );
			await ctx.environment.configure( { resolveDecay: 0.0004, southExits: true } );
			const route = path( ctx.spatial.route() ); run.inter = route.points.at( - 1 ); run.roads = ctx.spatial.carriageways().map( path );
			if ( ! run.roads.length ) throw new Error( 'Ring-road carriageways unavailable' );
			run.traffic = run.roads.map( ( road ) => ( { length: road.length, block: Infinity, wait: 0, cars: [], backlog: 0 } ) ); run.ring = run.roads.map( () => 0 );
			const roadPoint = ( at ) => run.roads.map( ( road ) => road.at( road.project( at ) ) ).sort( ( first, second ) => gap( first, at ) - gap( second, at ) )[ 0 ];
			run.side = [ roadPoint( [ - 1097, 715 ] ), roadPoint( ctx.locations.get( 'litostrojska' ) ) ];
			for ( const crossing of [ run.inter, ...run.side ] ) {

				const near = run.roads.flatMap( ( road ) => [ - 60, 0, 60 ].map( ( offset ) => road.at( road.project( crossing ) + offset ) ) ).filter( ( at ) => gap( at, crossing ) < 110 );
				for ( let choice = 0; choice < 3 && near.length; choice ++ ) run.spots.push( near.splice( Math.floor( ctx.random() * near.length ), 1 )[ 0 ] );

			}
			ctx.presentation.focus( route.at( route.length - 260 ), 0.95 );
			for ( let index = 0; index < 100; index ++ ) { const id = `march-${index}`; run.march.push( id ); ctx.spawn.crowd( { id, label: 'March', at: route.at( 420 - index * 4 ), people: 100, groupSize: 100, spread: 10,
				goal: run.inter, goalRadius: 30, agitation: [ 0.05, 0.3 ], morale: 0.9, resolve: [ 1.3, 1.5 ], speed: [ 2.16, 2.64 ] } ); }
			for ( let index = 0; index < 500; index ++ ) { const along = 40 + Math.floor( index / 2 ) / 250 * ( route.length - 120 ), side = index % 2 ? 1 : - 1;
				const from = route.at( along ), to = route.at( along + 5 ), length = gap( from, to ) || 1, id = `onlooker-${index}`; run.onlookers.push( id );
				ctx.spawn.crowd( { id, label: 'Onlookers', at: [ from[ 0 ] - ( to[ 1 ] - from[ 1 ] ) / length * side * 17, from[ 1 ] + ( to[ 0 ] - from[ 0 ] ) / length * side * 17 ], people: 20, groupSize: 20,
					spread: 3, faction: 'bystander', speed: [ 0, 0 ], agitation: [ 0, 0.1 ], resolve: [ 1.3, 1.5 ], mode: 'hold' } ); }
			const staging = ctx.locations.get( 'aleja' ), onRing = roadPoint( run.inter );
			const posts: Sdk.Point[] = [ [ onRing[ 0 ] * 2 - run.inter[ 0 ], onRing[ 1 ] * 2 - run.inter[ 1 ] ], ...run.side, staging, staging, staging, staging, staging ];
			for ( const [ index, along ] of [ 650, 950, 1250, 1550, 1850, 2150, 2450, 2700 ].entries() ) { const from = route.at( along ), to = route.at( along + 5 ), length = gap( from, to ) || 1;
				const side = index % 2 ? 1 : - 1; posts.push( ctx.spatial.walkable( [ from[ 0 ] - ( to[ 1 ] - from[ 1 ] ) / length * side * 30, from[ 1 ] + ( to[ 0 ] - from[ 0 ] ) / length * side * 30 ], 12 ) ?? from ); }
			for ( const [ index, at ] of posts.entries() ) ctx.spawn.squad( { id: `police-${index}`, at, people: 24 } );
			for ( const [ index, at ] of [ [ run.inter[ 0 ] - 20, run.inter[ 1 ] - 25 ], ...run.side ].entries() ) ctx.spawn.vehicle( { id: `patrol-${index}`, type: 'police-patrol', at } );
			ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: route.at( route.length - 50 ) } );
			ctx.spawn.bystanders( { id: 'wanderers', people: 900, destinations: [ 'koseze', 'aleja', 'tivoli', 'siska', 'zak' ] } );

		}, behaviors: [ director( { id: 'ring-road' } ) ], objectives: [ survive( { id: 'hold', seconds: 1500, reason: 'It is 18:00. The ring road is open and the march is heading back to the centre.' } ) ],
		outcomes: [ defineOutcome( { id: 'closure', evaluate: () => run.closed >= 420 ? { win: false, reason: 'The ring road was shut for too long. Rush-hour traffic is gridlocked across the north of the city.' } : null } ) ],
		phase: ( { time } ) => `${Math.floor( ( 980 + time / 15 ) / 60 )}:${String( Math.floor( ( 980 + time / 15 ) % 60 ) ).padStart( 2, '0' )} · closed ${timeText( run.closed )}`,
		hud: ( { time } ) => [ { label: 'Ring road closed (max 7:00)', value: run.closed / 420, text: `${timeText( run.closed )}${run.ring.some( ( count ) => count >= 12 ) ? ' · BLOCKED' : ''}`, state: run.ring.some( ( count ) => count >= 12 ) ? 'bad' : run.closed > 210 ? 'warn' : 'ok', invert: true },
			{ label: 'Hold until 18:00', value: time / 1500, text: `${clockAt( time )}`, state: 'ok' },
			{ label: 'Traffic tailback', value: Math.min( 1, run.tailback / 3000 ), text: `${( run.tailback / 1000 ).toFixed( 1 )} km`, state: run.tailback > 1500 ? 'bad' : run.tailback > 300 ? 'warn' : 'ok', invert: true } ],
		score: ( { win, time, metrics } ) => ( { stars: Number( win ) + Number( win && run.closed <= 210 ) + Number( win && metrics.counters.injuriesByPolice <= 25 && metrics.opinion >= 40 ),
			lines: [ [ 'Ring road closed', timeText( run.closed ) ], [ 'Finished at', clockAt( time ) ], [ 'Tailback', `${( run.tailback / 1000 ).toFixed( 1 )} km` ],
				[ 'Injuries caused by police', metrics.counters.injuriesByPolice ], [ 'Officers injured', metrics.counters.officersInjured ], [ 'Arrests', metrics.counters.arrests ], [ 'Water cannon sprays', run.water ], [ 'Public opinion', Math.round( metrics.opinion ) ] ] } ),
	} );

};
