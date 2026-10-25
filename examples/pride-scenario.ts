import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { gap, path, timeText } from './mission-path.ts';

export const sdkVersion = 1;
const ROUTE: Sdk.Point[] = [ [ 829, 565 ], [ 812, 642 ], [ 560, 649 ], [ 300, 647 ], [ 60, 645 ], [ - 30, 642 ], [ - 79, 482 ], [ - 119, 352 ], [ - 143, 295 ], [ - 164, 237 ], [ - 187, 170 ], [ - 220, 73 ], [ - 242, - 2 ], [ - 268, - 88 ], [ - 271, - 109 ], [ - 225, - 155 ] ];
const GAUNTLET: Sdk.Point[] = ROUTE.slice( 8, 15 );
const LEGS: { at: Sdk.Point; radius: number }[] = [ { at: [ 812, 642 ], radius: 15 }, { at: [ 300, 647 ], radius: 15 }, { at: [ - 30, 642 ], radius: 15 }, { at: [ - 225, - 155 ], radius: 30 } ];
const SIDES: { name: string; junction: Sdk.Point; up: Sdk.Point }[] = [ { name: 'Tavčarjeva', junction: [ - 119, 352 ], up: [ 124, 281 ] }, { name: 'Dalmatinova', junction: [ - 143, 295 ], up: [ - 29, 249 ] },
	{ name: 'Štefanova', junction: [ - 187, 170 ], up: [ - 277, 198 ] }, { name: 'Nazorjeva', junction: [ - 204, 118 ], up: [ - 101, 85 ] }, { name: 'Cankarjeva', junction: [ - 220, 73 ], up: [ - 458, 136 ] },
	{ name: 'Čopova', junction: [ - 223, 64 ], up: [ - 138, 24 ] }, { name: 'Tomšičeva', junction: [ - 242, - 2 ], up: [ - 482, 73 ] }, { name: 'Knafljev prehod', junction: [ - 243, - 4 ], up: [ - 119, - 50 ] } ];
const clock = ( time ) => { const minutes = time < 60 ? 1020 + time : 1080 + ( time - 60 ) / 20; return `${Math.floor( minutes / 60 )}:${String( Math.floor( minutes % 60 ) ).padStart( 2, '0' )}`; };

export default ( { defineScenario, defineBehavior, defineOutcome, survive, place, landmark, policeCommands }: typeof Sdk ) => {

	const route = path( ROUTE ), gauntlet = path( GAUNTLET );
	const run: any = { march: [], clusters: [], attacks: [], banner: null, goal: null, remaining: 3000, arrived: null, bearers: 1, capture: 0, lost: false, progress: 0, brawls: 0, halted: false, haltedAt: 0, haltedSeconds: 0, blockade: null,
		arrests: { march: 0, counter: 0, violent: 0, blockade: 0, brawler: 0 } };
	const director = defineBehavior( { id: 'pride-march-and-screening', create() {

		const previous = new Map(), carry = new Map(); let arrestOpinion = 0, lastAttack = - 99, lastMechanicsSample = 0;
		const lead = ( ctx, state ) => { if ( run.halted || ! state.started ) return; ctx.actors.configure( state.id, { speed: state.leg < 3 ? 2 : 1.3 } ); ctx.movement.move( ctx.actors.resolve( state.id ), LEGS[ state.leg ].at, { radius: LEGS[ state.leg ].radius } ); };
		return {
			start( ctx ) {

				for ( const cluster of run.clusters ) if ( cluster.squad ) ctx.movement.move( ctx.actors.resolve( cluster.squad ), cluster.lineB, { line: cluster.lineA } );
				ctx.timeline.after( 2, () => ctx.presentation.notice( 'The march sets off from Metelkova at 18:00 (in 1:00). Fill the gaps along Slovenska before it gets there', 'info', 'start' ) );
				ctx.timeline.after( 8, () => ctx.presentation.notice( 'Blue lines stand in front of every other pavement group; the others are unscreened', 'info', GAUNTLET[ 2 ] ) );
				ctx.timeline.after( 60, () => {

					const order = [ run.march[ 0 ], ...run.march.slice( 1 ).sort( ( first, second ) => { const a = ctx.actors.get( ctx.actors.resolve( first.id ) )?.center ?? ROUTE[ 0 ], b = ctx.actors.get( ctx.actors.resolve( second.id ) )?.center ?? ROUTE[ 0 ]; return gap( a, LEGS[ 0 ].at ) - gap( b, LEGS[ 0 ].at ); } ) ];
					for ( const [ index, state ] of order.entries() ) ctx.timeline.after( index * 2.5, () => { state.started = true; state.leg = 0; lead( ctx, state ); } );

				} );

			},
			observe( ctx, sample ) {

				let remaining = 0;
				for ( const state of run.march ) { const actor = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( ! actor ) continue; remaining += actor.alive;
					const people = ctx.people.members( state.id ).filter( ( person ) => person.status === 'active' ); const agitation = people.reduce( ( total, person ) => total + person.agitation, 0 ) / ( people.length || 1 );
					if ( agitation > 0.25 ) ctx.crowd.nudge( state.id, { agitation: - 0.06 - ( agitation - 0.25 ) * 0.15 } );
					if ( state.started && actor.center && state.leg < 3 && route.project( actor.center ) > route.project( LEGS[ state.leg ].at ) - 30 ) { state.leg ++; lead( ctx, state ); } }
				run.remaining = remaining;
				const banner = ctx.protected.get( run.banner );
				run.position = banner.position; run.bannerCarried = banner.state === 'carried';
				if ( banner.position ) run.progress = route.project( banner.position );
				if ( banner.state === 'dropped' && banner.position ) {

					const friends = ctx.spatial.count( { at: banner.position, radius: 8, faction: 'protester' } ), enemies = ctx.spatial.count( { at: banner.position, radius: 8, faction: 'counter' } ), officers = ctx.spatial.count( { at: banner.position, radius: 8, faction: 'police' } );
					if ( friends !== null && enemies !== null && officers !== null ) { run.capture = enemies >= 4 && friends < enemies && officers < 3 ? run.capture + sample.elapsed : 0;
						if ( run.capture > 8 ) run.lost = true;
						if ( friends >= 5 && enemies < friends ) { const next = sample.people.filter( ( person ) => person.status === 'active' && run.march.some( ( state ) => state.id === person.actor.id ) && gap( person.position, banner.position ) < 8 ).sort( ( first, second ) => gap( first.position, banner.position ) - gap( second.position, banner.position ) )[ 0 ];
							if ( next && ctx.protected.transfer( run.banner, { carrier: next.handle, expectedRevision: banner.revision, expectedSample: sample.sequence, radius: 8, promote: true } ).status === 'completed' ) run.bearers ++; } }

				}
				for ( const cluster of run.clusters ) {

					const actor = ctx.actors.get( ctx.actors.resolve( cluster.id ) ); if ( ! actor || actor.alive <= 3 ) continue;
					let marchers = 0, screen = 0; const close = [];
					for ( const person of sample.people ) { if ( person.status !== 'active' || gap( person.position, cluster.at ) > 22 ) continue;
						if ( person.faction === 'protester' ) { marchers ++; close.push( person ); }
						if ( person.faction === 'police' ) { const deltaX = person.position[ 0 ] - cluster.at[ 0 ], deltaY = person.position[ 1 ] - cluster.at[ 1 ], along = deltaX * cluster.tangent[ 0 ] + deltaY * cluster.tangent[ 1 ], across = deltaX * cluster.normal[ 0 ] + deltaY * cluster.normal[ 1 ]; if ( Math.abs( along ) < 13 && across > 0.8 && across < 9 ) screen ++; } }
					const exposed = marchers >= 8 ? ( 1 - Math.min( 1, screen / 14 ) ) ** 1.5 : 0;
					cluster.tension = Math.max( 0, Math.min( 1, cluster.tension + ( exposed > 0.05 ? exposed / 35 : - 1 / 120 ) * sample.elapsed ) );
					if ( cluster.tension > 0.5 && exposed > 0.05 ) { ctx.crowd.nudge( cluster.id, { agitation: 0.03 * cluster.tension * sample.elapsed } ); for ( const person of close ) if ( ctx.random() < 0.3 ) ctx.effects.nudge( person.handle, { agitation: 0.02 * sample.elapsed, expectedSample: sample.sequence } ); }
					if ( cluster.tension >= 1 && ! cluster.riotUntil ) { cluster.riotUntil = ctx.time + 45; run.brawls ++; ctx.crowd.setMode( cluster.id, 'riot' ); ctx.crowd.nudge( cluster.id, { agitation: 0.6, resolve: 0.3 } ); ctx.opinion.adjust( - 3, 'brawl at Pride' );
						for ( const state of run.march ) { const group = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( group?.center && gap( group.center, cluster.at ) < 45 ) ctx.crowd.nudge( state.id, { agitation: ctx.random() < 0.15 ? 0.5 : 0.05, resolve: group.handle === banner.actor ? 0 : - 0.35 } ); } }
					if ( cluster.riotUntil && ctx.time > cluster.riotUntil ) { const active = ctx.people.members( cluster.id ).filter( ( person ) => person.status === 'active' ); if ( active.reduce( ( total, person ) => total + person.agitation, 0 ) / ( active.length || 1 ) < 0.55 ) { cluster.riotUntil = 0; cluster.tension = 0.5; ctx.crowd.setMode( cluster.id, 'hold' ); } }

				}
				const blockade = run.blockade;
				if ( blockade.state === 'sitting' ) {

					for ( const person of ctx.people.members( 'blockade' ) ) { if ( person.status !== 'active' ) { carry.delete( person.handle ); continue; }
						const near = sample.people.some( ( officer ) => officer.status === 'active' && officer.faction === 'police' && gap( officer.position, person.position ) < 2.2 );
						const held = near ? ( carry.get( person.handle ) ?? 0 ) + sample.elapsed : Math.max( 0, ( carry.get( person.handle ) ?? 0 ) - sample.elapsed ); carry.set( person.handle, held );
						if ( held >= 4 ) ctx.effects.apply( person.handle, { status: 'detained', expectedSample: sample.sequence } ); }
					const sitting = ctx.spatial.count( { at: blockade.at, radius: 15, faction: 'counter' } ) ?? 0, close = run.progress > blockade.distance - 30 && run.progress < blockade.distance + 5;
					if ( ! run.halted && close && sitting >= 15 ) { run.halted = true; run.haltedAt = ctx.time; for ( const state of run.march ) if ( state.started ) ctx.crowd.setMode( state.id, 'hold' ); }
					if ( run.halted && sitting < 15 ) { run.halted = false; blockade.state = 'cleared'; run.haltedSeconds += ctx.time - run.haltedAt; for ( const state of run.march ) lead( ctx, state ); }

				}
				for ( const person of sample.people ) { if ( person.status === 'detained' && previous.get( person.handle ) === 'active' ) {

					const cluster = run.clusters.find( ( entry ) => entry.id === person.actor.id ); const kind = person.actor.id === 'blockade' ? 'blockade' : person.actor.id.startsWith( 'attacker-' ) || cluster?.riotUntil ? 'violent' : person.agitation >= 0.5 ? 'brawler' : run.march.some( ( state ) => state.id === person.actor.id ) ? 'march' : cluster ? 'counter' : null;
					if ( kind ) { run.arrests[ kind ] ++; arrestOpinion += { march: - 1, counter: - 0.6, violent: 0.4, blockade: - 0.05, brawler: - 0.1 }[ kind ]; }

				} previous.set( person.handle, person.status ); }
				if ( Math.abs( arrestOpinion ) >= 1 ) { const delta = Math.trunc( arrestOpinion ); ctx.opinion.adjust( delta, 'arrests at Pride' ); arrestOpinion -= delta; }

			},
			update( ctx ) {

				if ( ! ctx.observation || ctx.observation.sequence === lastMechanicsSample ) return; lastMechanicsSample = ctx.observation.sequence;
				const banner = ctx.protected.get( run.banner ); if ( ! banner.position ) return;
				for ( const attack of run.attacks ) {

					if ( attack.state === 'wait' && run.progress > attack.distance - 200 && ctx.time - lastAttack > 60 ) { attack.state = 'spawning'; attack.from = ctx.time; lastAttack = ctx.time;
						void ctx.spawn.crowd( { id: attack.id, label: `Attackers · ${attack.name}`, at: attack.lurk, people: 22, groupSize: 22, spread: 6, goal: attack.lurk, goalRadius: 8, mode: 'hold', faction: 'counter', agitation: [ 0.6, 0.8 ], resolve: [ 1.1, 1.4 ], morale: 0.9, speed: [ 1.1, 1.25 ] } ).settled.then( ( outcome ) => { if ( outcome.status === 'completed' ) attack.state = 'gather'; } ); }
					if ( ! [ 'gather', 'strike' ].includes( attack.state ) ) continue; const actor = ctx.actors.get( ctx.actors.resolve( attack.id ) ); if ( ! actor?.center ) continue;
					const officers = ctx.spatial.count( { at: actor.center, radius: attack.state === 'gather' ? 14 : 12, faction: 'police' } ) ?? 0;
					if ( actor.alive < 5 || officers >= 12 && ctx.random() < ( attack.state === 'gather' ? 0.3 : 0.4 ) || attack.struck && ctx.time - attack.struck > 75 ) { attack.state = 'gone'; ctx.actors.configure( attack.id, { home: true } ); continue; }
					if ( attack.state === 'gather' && ctx.time - attack.from > 45 && ( run.progress > attack.distance - 70 || ctx.time - attack.from > 150 ) ) { attack.state = 'strike'; attack.struck = ctx.time; ctx.crowd.setMode( attack.id, 'riot' ); }
					if ( attack.state === 'strike' && ctx.time - ( attack.aimed ?? 0 ) >= 4 ) { attack.aimed = ctx.time; const goal = gap( banner.position, actor.center ) < 140 ? banner.position
						: run.march.map( ( state ) => ctx.actors.get( ctx.actors.resolve( state.id ) ) ).filter( ( marcher ) => marcher?.center && marcher.alive > 0 ).sort( ( first, second ) => gap( first.center, actor.center ) - gap( second.center, actor.center ) )[ 0 ]?.center;
						if ( goal ) void ctx.movement.move( actor.handle, goal, { radius: 6 } ).settled.then( ( outcome ) => { if ( outcome.status === 'completed' && ! ctx.signal.aborted ) ctx.crowd.setMode( actor.handle, 'riot' ); } ); }

				}
				const blockade = run.blockade;
				if ( blockade.state === 'wait' && run.progress > blockade.distance - 320 ) { blockade.state = 'announced'; blockade.atTime = ctx.time + 40; ctx.presentation.notice( `Counter-protesters are about to sit down in the road at ${blockade.name} (0:40)`, 'warn', blockade.at );
					ctx.timeline.after( 40, () => { const span = ctx.spatial.roadSpan( blockade.at, 24 ), length = gap( span.a, span.b ), tangent = [ ( span.b[ 0 ] - span.a[ 0 ] ) / length, ( span.b[ 1 ] - span.a[ 1 ] ) / length ], points: Sdk.Point[] = [];
						for ( let row = 0; row < 4; row ++ ) for ( let index = 0; index < 15; index ++ ) { const along = 1.5 + ( length - 3 ) * index / 14, across = ( row - 1.5 ) * 1.3, at: Sdk.Point = [ span.a[ 0 ] + tangent[ 0 ] * along - tangent[ 1 ] * across, span.a[ 1 ] + tangent[ 1 ] * along + tangent[ 0 ] * across ]; if ( ( ctx.spatial.clearance( at ) ?? 0 ) > 0.5 ) points.push( at ); }
						if ( ! points.length ) return; void ctx.spawn.crowd( { id: 'blockade', label: 'Blockade', at: blockade.at, people: points.length, points, groupSize: points.length, mode: 'sit', faction: 'counter', agitation: [ 0.05, 0.15 ], resolve: [ 0.9, 1.2 ], morale: 0.8 } ).settled.then( ( outcome ) => { if ( outcome.status === 'completed' ) blockade.state = 'sitting'; } ); } ); }
				const markers: Sdk.MapMarker[] = run.clusters.map( ( cluster ) => ( { id: cluster.id, at: cluster.at, radius: 11, label: `Tension ${Math.round( cluster.tension * 100 )}%`, kind: cluster.riotUntil ? 'bad' : cluster.tension > 0.5 ? 'warn' : 'info' } ) );
				for ( const attack of run.attacks ) if ( [ 'gather', 'spawning' ].includes( attack.state ) ) markers.push( { id: attack.id, at: attack.lurk, radius: 14, label: `Attackers · ${attack.name}`, kind: 'bad', countdownTo: attack.from + 45 } );
				ctx.presentation.markers( markers );

			},
		};

	} } );
	return defineScenario( { id: 'pride-rules', menu: false, title: 'Pride Rules Preview', subtitle: 'Escort the march to Kongresni trg',
		brief: 'Protect the Pride banner and keep the march together. Screen the peaceful pavement groups, stop announced attackers and clear the blockade.',
		locations: { start: place( 'Metelkova' ), square: place( 'Kongresni trg' ), preseren: place( 'Prešernov trg' ), railway: landmark( 'Železniška postaja' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ) },
		opinion: { initial: 60, gas: - 5, water: - 3, weights: { injuriesByPolice: - 0.5, officersInjured: 0.2, arrests: 0, sitterArrests: 0, otherInjuries: - 0.3 } },
		resources: { gas: { capacity: 2 }, water: { capacity: 2 }, reinforce: { capacity: 14, cooldown: 15 } }, commands: policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ),
		async setup( ctx ) {

			Object.assign( run, { march: [], clusters: [], remaining: 3000, arrived: null, bearers: 1, capture: 0, lost: false, progress: 0, brawls: 0, halted: false, haltedSeconds: 0, arrests: { march: 0, counter: 0, violent: 0, blockade: 0, brawler: 0 } } );
			await ctx.environment.configure( { holdRestraint: 0.12 } ); ctx.presentation.focus( [ 280, 270 ], 0.7 ); run.goal = ctx.spatial.sample( LEGS[ 3 ].at, { radius: 6 } );
			for ( let index = 0; index < 29; index ++ ) { const id = index === 0 ? 'pride-banner' : `march-${index}`; run.march.push( { id, leg: 0, started: false } ); ctx.spawn.crowd( { id, label: index === 0 ? 'Pride banner' : 'Pride march', at: 'start', people: index === 0 ? 200 : 100, groupSize: index === 0 ? 200 : 100, spread: index === 0 ? 12 : 45, goal: 'start', goalRadius: 30, mode: 'hold', agitation: index === 0 ? [ 0.02, 0.12 ] : [ 0.02, 0.15 ], resolve: index === 0 ? [ 1, 1.3 ] : [ 0.8, 1.2 ], morale: index === 0 ? 0.8 : 0.7, speed: [ 1, 1 ] } ); }
			run.banner = ctx.protected.create( { id: 'pride-banner-object', label: 'PRIDE BANNER', carrier: 'pride-banner' } );
			for ( let index = 0; index < 7; index ++ ) for ( const side of [ - 1, 1 ] ) {

				const distance = 20 + index * 60 + ( side > 0 ? 25 : 0 ), at = gauntlet.at( distance ), ahead = gauntlet.at( distance + 2 ), length = gap( at, ahead ) || 1, tangent = [ ( ahead[ 0 ] - at[ 0 ] ) / length, ( ahead[ 1 ] - at[ 1 ] ) / length ];
				const normal = [ - tangent[ 1 ] * side, tangent[ 0 ] * side ]; let wall = 0; while ( wall < 22 && ( ctx.spatial.clearance( [ at[ 0 ] + normal[ 0 ] * wall, at[ 1 ] + normal[ 1 ] * wall ] ) ?? 0 ) > 0.6 ) wall += 0.5; wall = Math.min( wall, 16 ); if ( wall < 7 ) continue;
				const points: Sdk.Point[] = []; for ( let row = 0; row < 3; row ++ ) for ( let along = - 8.25; along <= 8.3; along += 1.5 ) { const across = wall - 1.2 - row, point: Sdk.Point = [ at[ 0 ] + normal[ 0 ] * across + tangent[ 0 ] * along, at[ 1 ] + normal[ 1 ] * across + tangent[ 1 ] * along ]; if ( ( ctx.spatial.clearance( point ) ?? 0 ) > 0.5 ) points.push( point ); } if ( points.length < 20 ) continue;
				const id = `pavement-${index}-${side < 0 ? 'west' : 'east'}`, center: Sdk.Point = [ at[ 0 ] + normal[ 0 ] * ( wall - 2.2 ), at[ 1 ] + normal[ 1 ] * ( wall - 2.2 ) ], front: Sdk.Point = [ at[ 0 ] + normal[ 0 ] * ( wall - 5.6 ), at[ 1 ] + normal[ 1 ] * ( wall - 5.6 ) ];
				const cluster = { id, at: center, front, tangent, normal: normal.map( ( value ) => - value ), lineA: [ front[ 0 ] - tangent[ 0 ] * 11, front[ 1 ] - tangent[ 1 ] * 11 ], lineB: [ front[ 0 ] + tangent[ 0 ] * 11, front[ 1 ] + tangent[ 1 ] * 11 ], tension: 0, riotUntil: 0, squad: null };
				ctx.spawn.crowd( { id, label: 'Counter-protest', at: center, points, people: points.length, groupSize: points.length, faction: 'counter', mode: 'hold', agitation: [ 0.1, 0.3 ], resolve: [ 0.8, 1.1 ], morale: 0.6, speed: [ 0, 0 ] } );
				const order = run.clusters.length; if ( order % 4 === 0 || order % 4 === 3 ) { cluster.squad = `screen-${order}`; ctx.spawn.squad( { id: cluster.squad, at: front, people: 24 } ); } run.clusters.push( cluster );

			}
			for ( const [ index, at ] of [ [ - 40, 705 ], [ - 40, 705 ], [ - 270, 415 ], [ - 270, 415 ], [ - 330, 30 ], [ - 330, 30 ], [ - 450, - 80 ], [ - 190, - 175 ] ].entries() ) ctx.spawn.squad( { id: `reserve-${index}`, at: [ at[ 0 ], at[ 1 ] ], people: 24 } );
			for ( const [ index, at ] of [ [ - 20, 690 ], [ - 300, 40 ], [ - 200, - 190 ] ].entries() ) ctx.spawn.vehicle( { id: `patrol-${index}`, type: 'police-patrol', at: [ at[ 0 ], at[ 1 ] ] } ); ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: [ - 315, 20 ] } );
			run.attacks = [ ...SIDES ].sort( () => ctx.random() - 0.5 ).slice( 0, 4 ).map( ( side, index ) => { const length = gap( side.up, side.junction ) || 1; return { ...side, id: `attacker-${index}`, lurk: ctx.spatial.walkable( [ side.junction[ 0 ] + ( side.up[ 0 ] - side.junction[ 0 ] ) / length * 65, side.junction[ 1 ] + ( side.up[ 1 ] - side.junction[ 1 ] ) / length * 65 ], 30 ) ?? side.junction, distance: route.project( side.junction ), state: 'wait' }; } ).sort( ( first, second ) => first.distance - second.distance );
			const into = ctx.random() < 0.5 ? 150 : 250, distance = route.project( GAUNTLET[ 0 ] ) + into; run.blockade = { distance, at: route.at( distance ), name: into < 200 ? 'Nebotičnik' : 'Cankarjeva', state: 'wait' };
			ctx.spawn.bystanders( { id: 'onlookers', people: 1500, destinations: [ 'preseren', 'square', 'start', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		}, behaviors: [ director( { id: 'pride' } ) ], objectives: [ survive( { id: 'deadline', seconds: 1801 } ) ],
		outcomes: [ defineOutcome( { id: 'pride-result', evaluate: ( { time } ) => { const position = run.bannerCarried && run.position && gap( run.position, run.goal ) < 40; if ( position ) { run.arrived = run.remaining; return { win: true, reason: `The banner reached Kongresni trg at ${clock( time )} with ${Math.round( run.remaining / 3000 * 100 )} % of the march behind it.` }; }
			if ( run.lost ) return { win: false, reason: 'The banner was torn from the march and carried off. The images go round the world.' }; if ( time > 60 && run.remaining < 1200 ) return { win: false, reason: 'The march has fallen apart: too many went home, hurt or afraid.' }; if ( time >= 1800 ) return { win: false, reason: 'It is 19:30 and the march never reached Kongresni trg.' }; return null; } } ) ],
		phase: ( { time } ) => `${clock( time )} · banner ${Math.round( route.length - run.progress )} m from Kongresni trg${run.halted ? ' · MARCH HALTED' : ''}`,
		score: ( { win, time, metrics } ) => { const arrived = run.arrived ?? run.remaining, hurt = metrics.counters.injuriesByPolice + metrics.counters.otherInjuries; return { stars: Number( win ) + Number( win && arrived >= 2100 ) + Number( win && hurt <= 25 && metrics.opinion >= 50 ), lines: [
			[ 'Arrived', clock( time ) ], [ 'Marchers with the banner', `${arrived} (${Math.round( arrived / 3000 * 100 )} %)` ], [ 'Brawls on Slovenska', run.brawls ], [ 'Injured in brawls and attacks', metrics.counters.otherInjuries ], [ 'Injuries caused by police', metrics.counters.injuriesByPolice ], [ 'Officers injured', metrics.counters.officersInjured ],
			[ 'Attackers arrested', run.arrests.violent ], [ 'Peaceful counter-protesters arrested', run.arrests.counter ], [ 'Blockade cleared', run.blockade?.state === 'cleared' ? `yes (${timeText( run.haltedSeconds )} halted)` : 'no' ], [ 'Banner bearers', run.bearers ], [ 'Public opinion', Math.round( metrics.opinion ) ] ] }; },
	} );

};
