import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { gap, ringDistance, timeText } from './mission-path.ts';

export const sdkVersion = 1;
const REACTIONS = { charge: [ 45, 0.15 ], kettle: [ 50, 0.2 ], gas: [ 60, 0.2 ], water: [ 50, 0.15 ], 'shield-push': [ 40, 0.12 ] };

export default ( { defineScenario, defineBehavior, defineOutcome, survive, place, landmark, target, policeCommands, scenarioCommand }: typeof Sdk ) => {

	const run: any = { fires: 0, smashed: 0, hurt: 0, hurtByPolice: 0, innocent: 0, held: 0, down: 0, buildings: [], normals: [], cells: [], acts: [], sites: [], rallies: [], endAt: 1000, lastViolence: - 999 };
	const director = defineBehavior( { id: 'blackbloc-actions', create() {

		let lastDirector = 0, arrestOpinion = 0, lastInnocent = 0, lastHeld = 0;
		const home = new Set(), previousHurt = new Map();
		const rejoin = ( ctx, cell ) => {

			cell.busy = null; cell.volley = null; cell.masked = false; ctx.actors.configure( cell.id, { masked: false, speed: 1 } );
			const actor = ctx.actors.get( ctx.actors.resolve( cell.id ) ), hosts = run.normals.map( ( state ) => ( { state, actor: ctx.actors.get( ctx.actors.resolve( state.id ) ) } ) ).filter( ( host ) => host.actor?.center && host.actor.alive > 10 && ! home.has( host.state.id ) );
			if ( ! actor?.center || ! hosts.length ) return;
			const host = hosts.sort( ( first, second ) => gap( first.actor.center, actor.center ) - gap( second.actor.center, actor.center ) )[ 0 ];
			ctx.movement.move( ctx.actors.resolve( cell.id ), host.state.rally.at, { radius: host.state.rally.radius } ); ctx.crowd.setMode( cell.id, 'hold' ); ctx.crowd.nudge( cell.id, { agitation: - 0.25 } );

		};
		const pickCell = ( ctx, role, at ) => {

			const active = run.cells.filter( ( cell ) => ! cell.busy && ! cell.broken ).map( ( cell ) => ( { cell, actor: ctx.actors.get( ctx.actors.resolve( cell.id ) ) } ) ).filter( ( entry ) => entry.actor?.center && entry.actor.alive >= 3 );
			const preferred = active.filter( ( entry ) => entry.cell.role === role ), options = preferred.length ? preferred : active;
			return at ? options.sort( ( first, second ) => gap( first.actor.center, at ) - gap( second.actor.center, at ) )[ 0 ]?.cell : options[ Math.floor( ctx.random() * options.length ) ]?.cell;

		};
		return {
			start( ctx ) {

				ctx.timeline.after( 2, () => ctx.presentation.notice( `Intelligence: a BlackBloc of ~110 is hiding in the crowds. First action in ${timeText( run.acts[ 0 ].at - ctx.time )}.`, 'warn', 'square' ) );
				for ( const [ index, act ] of run.acts.entries() ) {

					const lead = act.kind === 'fire' ? 60 : act.kind === 'smash' ? 80 : 40;
					ctx.timeline.after( act.at - lead, () => {

						const cell = act.cell = pickCell( ctx, act.kind === 'fire' ? 'arson' : 'provoke', act.building?.position );
						if ( act.kind === 'fire' ) ctx.timeline.after( 40, () => { act.building.due = act.at; ctx.presentation.notice( `Fuel canisters spotted: they are going for ${act.building.short}! Get people away from it.`, 'bad', act.building.position ); } );
						if ( ! cell ) return; cell.busy = act; cell.masked = true; ctx.actors.configure( cell.id, { masked: true, speed: 1.35 } ); ctx.crowd.nudge( cell.id, { agitation: 0.35, resolve: 0.3 } );
						if ( act.kind === 'fire' ) ctx.movement.move( ctx.actors.resolve( cell.id ), act.building.at, { radius: 8 } );
						if ( act.kind === 'smash' ) { const actor = ctx.actors.get( ctx.actors.resolve( cell.id ) ); act.site = [ ...run.sites ].sort( ( first, second ) => gap( first.at, actor.center ) - gap( second.at, actor.center ) )[ 0 ]; ctx.movement.move( actor.handle, act.site.at, { radius: 8 } ); }
						ctx.presentation.notice( `A group is masking up inside the ${cell.host}`, 'warn', ctx.actors.get( ctx.actors.resolve( cell.id ) )?.center );

					} );
					ctx.timeline.after( act.at, () => {

						act.done = true; run.lastViolence = ctx.time; const cell = act.cell;
						if ( act.kind === 'fire' ) {

							const building = act.building; building.burning = true; building.litAt = ctx.time; building.due = null; run.fires ++;
							ctx.presentation.notice( `${building.name} is on fire.`, 'bad', building.position );
							for ( const state of run.normals ) { const actor = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( ! actor?.center || gap( actor.center, building.position ) >= building.radius + 70 ) continue;
								if ( ! home.has( state.id ) && ctx.random() < 0.6 ) { home.add( state.id ); ctx.actors.configure( state.id, { home: true } ); } else ctx.crowd.nudge( state.id, { agitation: 0.3 } ); }
							if ( cell ) ctx.timeline.after( 12, () => rejoin( ctx, cell ) ); return;

						}
						if ( ! cell || cell.broken || ( ctx.actors.get( ctx.actors.resolve( cell.id ) )?.alive ?? 0 ) < 2 ) return;
						const actor = ctx.actors.get( ctx.actors.resolve( cell.id ) ); let back = 30;
						if ( act.kind === 'stones' || act.kind === 'flares' ) { const stones = act.kind === 'stones'; cell.volley = { until: ctx.time + ( stones ? 25 : 15 ), rate: stones ? 1.5 : 2.2, hit: stones ? 0.06 : 0.03, stress: stones ? 0.1 : 0.2 }; back = stones ? 50 : 35; }
						else if ( act.kind === 'smash' ) { if ( gap( actor.center, act.site.at ) < 50 && ( ctx.spatial.count( { at: act.site.at, radius: 30, faction: 'police' } ) ?? 0 ) < 6 ) run.smashed ++; }
						else { ctx.crowd.setMode( cell.id, 'riot' ); for ( const state of run.normals ) { const host = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( host?.center && gap( host.center, actor.center ) < 45 ) { ctx.crowd.nudge( state.id, { agitation: 0.35, resolve: 0.1 } ); ctx.crowd.setMode( state.id, 'riot' ); state.riot = true; } } }
						ctx.presentation.notice( `Masked cell: ${act.kind}`, 'bad', actor.center ); ctx.timeline.after( back, () => rejoin( ctx, cell ) );

					} );

				}

			},
			observe( ctx, sample ) {

				let hurt = 0, byPolice = 0, innocent = 0, held = 0, down = 0;
				for ( const state of run.normals ) {

					const members = ctx.people.members( state.id ), actor = ctx.actors.get( ctx.actors.resolve( state.id ) );
					const injuries = members.filter( ( person ) => person.status === 'injured' || person.status === 'dead' ), police = injuries.filter( ( person ) => person.injurySource === 'police' ).length;
					hurt += injuries.length; byPolice += police; innocent += members.filter( ( person ) => person.status === 'detained' ).length;
					const fresh = police - ( previousHurt.get( state.id ) ?? 0 ); previousHurt.set( state.id, police );
					if ( fresh > 0 ) { const delta = Math.min( 0.3, 0.08 * fresh ); ctx.crowd.nudge( state.id, { agitation: delta } );
						for ( const neighbor of run.normals ) { const other = ctx.actors.get( ctx.actors.resolve( neighbor.id ) ); if ( neighbor !== state && actor?.center && other?.center && gap( actor.center, other.center ) < 40 ) ctx.crowd.nudge( neighbor.id, { agitation: delta / 3 } ); } }

				}
				for ( const cell of run.cells ) {

					const members = ctx.people.members( cell.id ), actor = ctx.actors.get( ctx.actors.resolve( cell.id ) ); held += members.filter( ( person ) => person.status === 'detained' ).length; down += members.filter( ( person ) => person.status === 'injured' || person.status === 'dead' ).length;
					if ( cell.masked && ! cell.tagged && actor?.center && ctx.spatial.cctv( actor.center ) > 0 ) { cell.tagged = true; ctx.actors.configure( cell.id, { identified: true } ); ctx.presentation.notice( 'CCTV tagged a masked BlackBloc cell. It stays marked after they unmask.', 'info', actor.center ); }

				}
				arrestOpinion += - 0.6 * Math.max( 0, innocent - lastInnocent ) + 0.2 * Math.max( 0, held - lastHeld );
				if ( Math.abs( arrestOpinion ) >= 1 ) { ctx.opinion.adjust( Math.trunc( arrestOpinion ), arrestOpinion < 0 ? 'innocent people detained' : 'BlackBloc detained' ); arrestOpinion %= 1; }
				lastInnocent = innocent; lastHeld = held; Object.assign( run, { hurt, hurtByPolice: byPolice, innocent, held, down } );
				for ( const building of run.buildings ) if ( building.burning && ctx.time - building.litAt <= 45 ) for ( const person of sample.people ) {

					if ( person.status !== 'active' || gap( person.position, building.position ) > building.radius + 10 ) continue;
					if ( ctx.random() < 0.02 && building.rings.some( ( ring ) => ringDistance( ring, person.position ) < 6 ) ) ctx.effects.apply( person.handle, { status: 'injured', source: 'other', expectedSample: sample.sequence } );

				}

			},
			update( ctx, dt ) {

				const sample = ctx.observation; if ( ! sample ) return;
				for ( const cell of run.cells ) {

					const volley = cell.volley, actor = ctx.actors.get( ctx.actors.resolve( cell.id ) ); if ( ! volley || ctx.time > volley.until || ! actor?.center || actor.alive < 2 || ctx.random() > dt * volley.rate ) continue;
					const targets = sample.people.filter( ( person ) => person.faction === 'police' && person.status === 'active' && gap( person.position, actor.center ) > 5 && gap( person.position, actor.center ) < 28 );
					if ( ! targets.length ) { if ( ! volley.closing ) { volley.closing = true; volley.until += 20; const squad = sample.actors.filter( ( entry ) => entry.handle.kind === 'squad' && entry.center ).sort( ( first, second ) => gap( first.center, actor.center ) - gap( second.center, actor.center ) )[ 0 ]; if ( squad ) ctx.movement.move( actor.handle, squad.center, { radius: 15 } ); } continue; }
					const target = targets[ Math.floor( ctx.random() * targets.length ) ]; if ( ctx.random() < volley.hit ) ctx.effects.apply( target.handle, { status: 'injured', source: 'other', expectedSample: sample.sequence } );
					for ( const officer of sample.people ) if ( officer.faction === 'police' && officer.status === 'active' && gap( officer.position, target.position ) < 6 ) ctx.effects.nudge( officer.handle, { agitation: volley.stress, expectedSample: sample.sequence } );
					for ( const state of run.normals ) { const host = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( host?.center && gap( host.center, actor.center ) < 30 ) ctx.crowd.nudge( state.id, { agitation: 0.015 } ); }

				}
				if ( ctx.time - lastDirector >= 8 ) { lastDirector = ctx.time;
					for ( const cell of run.cells ) { const actor = ctx.actors.get( ctx.actors.resolve( cell.id ) ); if ( ! actor || cell.broken ) continue; if ( actor.alive < 3 ) { cell.broken = true; cell.volley = null; ctx.actors.configure( cell.id, { masked: false } ); ctx.crowd.nudge( cell.id, { agitation: - 0.3, resolve: - 2 } ); continue; } ctx.crowd.nudge( cell.id, { agitation: cell.masked ? 0.15 : 0, resolve: 0.25 } ); }
					for ( const state of run.normals ) { const actor = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( ! actor?.center || home.has( state.id ) ) continue;
						const active = ctx.people.members( state.id ).filter( ( person ) => person.status === 'active' ), agitation = active.reduce( ( total, person ) => total + person.agitation, 0 ) / ( active.length || 1 );
						if ( ! state.riot && agitation > 0.75 && ( ctx.spatial.count( { at: actor.center, radius: 30, faction: 'police' } ) ?? 0 ) > 0 ) { state.riot = true; ctx.crowd.setMode( state.id, 'riot' ); }
						else if ( state.riot && agitation < 0.35 ) { state.riot = false; ctx.movement.move( actor.handle, state.rally.at, { radius: state.rally.radius } ); }
						else if ( ! state.riot && ctx.random() < 0.03 ) { state.rally = run.rallies[ Math.floor( ctx.random() * run.rallies.length ) ]; ctx.movement.move( actor.handle, state.rally.at, { radius: state.rally.radius } ); }
					} }
				ctx.presentation.markers( run.buildings.filter( ( building ) => building.burning || building.due ).map( ( building, index ) => ( { id: `fire-${index}`, at: building.position, radius: building.radius, label: building.burning ? `${building.short} · FIRE` : building.short, kind: 'bad', shape: 'polygon', points: Array.from( { length: building.rings[ 0 ].length / 2 }, ( _, point ) => [ building.rings[ 0 ][ point * 2 ], building.rings[ 0 ][ point * 2 + 1 ] ] ), ...( building.due ? { countdownTo: building.due } : {} ) } ) ) );

			},
			onEvent( ctx, event ) {

				if ( event.type !== 'command.applied' ) return;
				const reaction = REACTIONS[ event.command ];
				if ( reaction ) for ( const state of run.normals ) { const actor = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( actor?.center && ! home.has( state.id ) && gap( actor.center, event.at ) < reaction[ 0 ] ) ctx.crowd.nudge( state.id, { agitation: reaction[ 1 ] } ); }
				if ( event.command === 'dispersal-order' ) { let sent = 0; for ( const state of run.normals ) { const actor = ctx.actors.get( ctx.actors.resolve( state.id ) ); if ( ! actor?.center || home.has( state.id ) || gap( actor.center, event.at ) >= 70 ) continue;
					const members = ctx.people.members( state.id ).filter( ( person ) => person.status === 'active' ), agitation = members.reduce( ( total, person ) => total + person.agitation, 0 ) / ( members.length || 1 );
					if ( ! state.ordered && ( agitation < 0.4 || ctx.random() < 0.3 ) ) { home.add( state.id ); ctx.actors.configure( state.id, { home: true } ); sent += actor.alive; } else ctx.crowd.nudge( state.id, { agitation: 0.15 } ); state.ordered = true; }
					if ( sent && ctx.time - run.lastViolence > 60 && ! run.buildings.some( ( building ) => building.due ) ) ctx.opinion.adjust( - 2, 'dispersing a peaceful rally' ); }

			},
		};

	} } );
	return defineScenario( { id: 'blackbloc-rules', menu: false, title: 'BlackBloc Rules Preview', subtitle: 'Protect the ordinary rally through three fires',
		brief: 'Masked cells emerge from peaceful rallies. Three fires cannot be prevented; protect ordinary protesters and distinguish the cells from the crowd.',
		goals: [ 'Get through the night', 'Fewer than 200 ordinary protesters hurt', 'Opinion at least 10' ],
		locations: { square: place( 'Trg republike' ), preseren: place( 'Prešernov trg' ), kongresni: place( 'Kongresni trg' ), church: landmark( 'Frančiškanska cerkev' ), assembly: target( 'Državni zbor' ), government: target( 'Vlada RS' ), station: landmark( 'PU Ljubljana' ), cankar: landmark( 'Cankarjev dom' ), tower: landmark( 'Nebotičnik' ), mestni: place( 'Mestni trg' ), metelkova: place( 'Metelkova' ), railway: landmark( 'Železniška postaja' ), tivoli: place( 'Park Tivoli' ), dragon: place( 'Zmajski most' ) },
		opinion: { initial: 60, water: - 2, weights: { injuriesByPolice: - 0.35, officersInjured: 0.25, arrests: 0, sitterArrests: 0, otherInjuries: - 0.05 } },
		resources: { gas: { capacity: 4 }, water: { capacity: 4 }, reinforce: { capacity: 3 }, order: { capacity: 99, cooldown: 15 } },
		commands: [ ...policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ), scenarioCommand( { id: 'dispersal-order', key: 'b', label: 'Dispersal order', resource: 'order' } ) ],
		setup( ctx ) {

			Object.assign( run, { fires: 0, smashed: 0, hurt: 0, hurtByPolice: 0, innocent: 0, held: 0, down: 0, normals: [], cells: [], acts: [], sites: [], lastViolence: - 999 } );
			ctx.presentation.focus( [ - 250, - 70 ], 0.75 );
			run.buildings = [ [ 'church', 'Frančiškanska cerkev', 'the Franciscan church' ], [ 'assembly', 'Državni zbor', 'the Assembly' ], [ 'government', 'Vlada RS', 'the Government building' ] ].map( ( [ alias, name, short ] ) => {

				const position = ctx.locations.get( alias ), rings = alias === 'church' ? [ ctx.spatial.footprint( position ) ] : ctx.targets.get( alias ).footprints;
				if ( ! rings[ 0 ] ) throw new Error( `Footprint unavailable: ${name}` );
				let radius = 0; for ( const ring of rings ) for ( let index = 0; index < ring.length; index += 2 ) radius = Math.max( radius, gap( position, [ ring[ index ], ring[ index + 1 ] ] ) );
				const ring = rings[ 0 ]; let at = ctx.spatial.sample( position, { radius: 30 } ), longest = 0;
				for ( let index = 0; index < ring.length; index += 2 ) { const start: Sdk.Point = [ ring[ index ], ring[ index + 1 ] ], end: Sdk.Point = [ ring[ ( index + 2 ) % ring.length ], ring[ ( index + 3 ) % ring.length ] ];
					const middle: Sdk.Point = [ ( start[ 0 ] + end[ 0 ] ) / 2, ( start[ 1 ] + end[ 1 ] ) / 2 ], length = gap( start, end ), offset = gap( middle, position ) || 1;
					const candidate: Sdk.Point = [ middle[ 0 ] + ( middle[ 0 ] - position[ 0 ] ) / offset * 6, middle[ 1 ] + ( middle[ 1 ] - position[ 1 ] ) / offset * 6 ];
					if ( length > longest && ( ctx.spatial.clearance( candidate ) ?? 0 ) > 1 && ctx.spatial.cost( candidate ) <= 12 ) { longest = length; at = candidate; } }
				return { name, short, position, rings, radius, at };

			} );
			const government = run.buildings[ 2 ], delta = gap( government.at, government.position ) || 1;
			const picket = ctx.spatial.sample( [ government.at[ 0 ] + ( government.at[ 0 ] - government.position[ 0 ] ) / delta * 22, government.at[ 1 ] + ( government.at[ 1 ] - government.position[ 1 ] ) / delta * 22 ], { radius: 10 } );
			run.rallies = [ { at: ctx.locations.get( 'square' ), radius: 45 }, { at: ctx.locations.get( 'preseren' ), radius: 30 }, { at: picket, radius: 20 }, { at: ctx.locations.get( 'kongresni' ), radius: 35 } ];
			for ( const [ crowd, people ] of [ [ 0, 2000 ], [ 1, 900 ], [ 2, 500 ] ] ) for ( let offset = 0; offset < people; offset += 50 ) { const id = `rally-${crowd}-${offset}`, rally = run.rallies[ crowd ]; run.normals.push( { id, rally } );
				ctx.spawn.crowd( { id, label: [ 'Trg republike rally', 'Prešernov trg rally', 'Gregorčiškova picket' ][ crowd ], at: rally.at, people: Math.min( 50, people - offset ), groupSize: 50, spread: rally.radius, goal: rally.at, goalRadius: rally.radius, mode: 'hold', agitation: [ 0.05, 0.25 ], morale: 0.6, resolve: [ 0.6, 1.1 ] } ); }
			for ( let index = 0; index < 9; index ++ ) { const crowd = index < 3 ? index : ( index - 3 ) % 2, rally = run.rallies[ crowd ], id = `cell-${index + 1}`, people = index < 3 ? 15 : 10;
				run.cells.push( { id, role: index < 3 ? 'arson' : 'provoke', host: `rally-${crowd}` } ); ctx.spawn.crowd( { id, label: 'Rally group', at: rally.at, people, groupSize: people, spread: rally.radius,
					goal: rally.at, goalRadius: rally.radius, mode: 'hold', agitation: [ 0.3, 0.45 ], morale: 0.9, resolve: [ 1, 1.3 ] } ); }
			run.sites = [ { name: 'Čopova', at: [ - 138, 24 ] }, { name: 'Nebotičnik', at: ctx.locations.get( 'tower' ) }, { name: 'Slovenska', at: [ - 330, - 240 ] }, { name: 'Mestni trg', at: ctx.locations.get( 'mestni' ) } ].map( ( site ) => ( { ...site, at: ctx.spatial.sample( site.at as Sdk.Point, { radius: 8 } ) } ) );
			const assembly = ctx.targets.get( 'assembly' ).position, around = Array.from( { length: 12 }, ( _, index ) => ctx.spatial.walkable( [ government.position[ 0 ] + Math.cos( index * Math.PI / 6 ) * ( government.radius + 20 ), government.position[ 1 ] + Math.sin( index * Math.PI / 6 ) * ( government.radius + 20 ) ] ) ).filter( Boolean ).sort( ( first, second ) => gap( second, picket ) - gap( first, picket ) );
			for ( const [ index, at ] of [ [ assembly[ 0 ] + 15, assembly[ 1 ] + 35 ], [ assembly[ 0 ] + 40, assembly[ 1 ] + 15 ], around[ 0 ], around[ 1 ], [ - 60, 30 ], ctx.locations.get( 'station' ), ctx.locations.get( 'station' ), ctx.locations.get( 'cankar' ), ctx.locations.get( 'kongresni' ) ].entries() ) ctx.spawn.squad( { id: `police-${index}`, at: at as Sdk.Point, people: 24 } );
			ctx.spawn.vehicle( { id: 'patrol-1', type: 'police-patrol', at: 'station' } ); ctx.spawn.vehicle( { id: 'patrol-2', type: 'police-patrol', at: [ - 300, - 330 ] } ); const station = ctx.locations.get( 'station' ); ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: [ station[ 0 ] + 15, station[ 1 ] ] } );
			ctx.spawn.bystanders( { id: 'onlookers', people: 1500, destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );
			const acts = [ ...[ 'stones', 'stones', 'flares', 'smash', 'smash', 'push' ].map( ( kind ) => ( { kind, building: null } ) ), ...run.buildings.map( ( building ) => ( { kind: 'fire', building } ) ) ];
			for ( let index = acts.length - 1; index > 0; index -- ) { const other = Math.floor( ctx.random() * ( index + 1 ) ); [ acts[ index ], acts[ other ] ] = [ acts[ other ], acts[ index ] ]; }
			const lastFire = acts.findLastIndex( ( act ) => act.kind === 'fire' ); [ acts[ lastFire ], acts[ acts.length - 1 ] ] = [ acts.at( - 1 ), acts[ lastFire ] ];
			let at = 100 + ctx.random() * 25; run.acts = acts.map( ( act ) => { const result = { ...act, at }; at += 65 + ctx.random() * 45; return result; } ); run.endAt = run.acts.at( - 1 ).at + 45;

		}, behaviors: [ director( { id: 'blackbloc' } ) ], objectives: [ survive( { id: 'night', seconds: 1500 } ) ],
		outcomes: [ defineOutcome( { id: 'night-result', evaluate: ( { time, metrics } ) => run.hurt >= 200 ? { win: false, reason: 'Hundreds of ordinary protesters hurt. The BlackBloc got the pictures it came for; the operation is called off.' }
			: metrics.opinion < 10 ? { win: false, reason: 'The public blames the police for the night. The minister orders a withdrawal.' } : time >= run.endAt ? { win: true, reason: 'Three buildings burned, as planned. What the cameras show around them is your doing.' } : null } ) ],
		phase: ( { time } ) => { const act = run.acts.find( ( entry ) => ! entry.done ); return act ? `Next BlackBloc action in ${timeText( act.at - time )} · fires ${run.fires}/3 · ${run.hurt} protesters hurt` : `All three buildings are burning · the night ends in ${timeText( run.endAt - time )}`; },
		score: ( { win, metrics } ) => ( { stars: Number( win ) + Number( win && run.held + run.down >= 35 ) + Number( win && run.hurt <= 30 && metrics.opinion >= 40 ), lines: [
			[ 'BlackBloc detained', `${run.held} of 105` ], [ 'BlackBloc injured', run.down ], [ 'Ordinary protesters hurt', `${run.hurt} (${run.hurtByPolice} by police)` ], [ 'Innocent people detained', run.innocent ],
			[ 'Officers injured', metrics.counters.officersInjured ], [ 'Shop fronts smashed', `${run.smashed} of 4` ], [ 'Tear gas used', metrics.counters.gasUsed ], [ 'Public opinion', Math.round( metrics.opinion ) ] ] } ),
	} );

};
