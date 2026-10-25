import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;
const distance = ( first, second ) => Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ] );
const timeText = ( seconds ) => `${Math.floor( Math.max( 0, seconds ) / 60 )}:${String( Math.floor( Math.max( 0, seconds ) % 60 ) ).padStart( 2, '0' )}`;
const street = ( y ) => [ 10 + ( y - 75 ) * 190 / 666, y ];

function inside( ring, at ) {

	let result = false;
	for ( let current = 0, previous = ring.length - 2; current < ring.length; previous = current, current += 2 ) {

		const startX = ring[ current ], startY = ring[ current + 1 ], endX = ring[ previous ], endY = ring[ previous + 1 ];
		if ( ( startY > at[ 1 ] ) !== ( endY > at[ 1 ] ) && at[ 0 ] < ( endX - startX ) * ( at[ 1 ] - startY ) / ( endY - startY ) + startX ) result = ! result;

	}
	return result;

}

export default ( { defineScenario, defineBehavior, defineOutcome, survive, landmark, place, policeCommands, protestCommands, scenarioCommand }: typeof Sdk ) => {

	const run: any = { held: 0, captured: 0, lost: false, bearers: 1, gas: 0, facade: null, steps: null, banner: null, posts: [], cordons: [] };
	const director = defineBehavior( { id: 'court-banner-and-police', create() {

		const busy = new Set<string>(), modes = new Map<string, string>(), pending = new Map<string, Sdk.MapMarker>();
		let lastDecision = 0, lastGas = - 99, lastCharge = - 99, lastKettle = - 99, lastSnatch = - 99, nextCall = 0, calls = 0;
		const selection = ( ctx, ids ) => ids.map( ( id ) => ctx.actors.resolve( id ) );
		const line = ( ctx, post ) => {

			for ( const [ index, id ] of post.ids.entries() ) {

				const from = post.a.map( ( value, axis ) => value + ( post.b[ axis ] - value ) * index / post.ids.length );
				const to = post.a.map( ( value, axis ) => value + ( post.b[ axis ] - value ) * ( index + 1 ) / post.ids.length );
				ctx.movement.move( ctx.actors.resolve( id ), to, { line: from } );

			}

		};
		const announce = ( ctx, id, at, radius, label, seconds, action ) => {

			pending.set( id, { id, at, radius, label, kind: 'bad', countdownTo: ctx.time + seconds } ); ctx.presentation.markers( [ ...pending.values() ] );
			ctx.presentation.notice( `Police: ${label} in ${seconds} s`, 'warn', at );
			ctx.timeline.after( seconds, () => { pending.delete( id ); ctx.presentation.markers( [ ...pending.values() ] ); action(); } );

		};
		const crowdAt = ( ctx, at, radius ) => {

			const people = ( ctx.observation?.people ?? [] ).filter( ( person ) => person.status === 'active' && person.faction === 'protester' && distance( person.position, at ) <= radius );
			return { n: people.length, at: people.length ? [ people.reduce( ( total, person ) => total + person.position[ 0 ], 0 ) / people.length,
				people.reduce( ( total, person ) => total + person.position[ 1 ], 0 ) / people.length ] : at };

		};
		const release = ( ctx, ids ) => {

			for ( const id of ids ) { busy.delete( id ); const post = run.posts.find( ( entry ) => entry.id === id ); if ( post ) ctx.movement.move( ctx.actors.resolve( id ), post.at ); }

		};
		return {
			start( ctx ) {

				for ( const post of run.cordons ) line( ctx, post );
				ctx.timeline.after( 2, () => ctx.presentation.notice( 'Select the Banner bloc and march it up Miklošičeva. The court is waiting.', 'info', run.steps ) );
				ctx.timeline.after( 540, () => ctx.presentation.notice( 'The verdict is read in 1:00', 'warn', run.steps ) );
				ctx.timeline.after( 600, () => ctx.presentation.notice( 'The verdict is read. The banner can still make the evening news: keep going', 'warn', run.steps ) );

			},
			observe( ctx, sample ) {

				const banner = ctx.protected.get( run.banner ); run.position = banner.position;
				if ( banner.state !== 'dropped' || ! banner.position ) return;
				const friends = ctx.spatial.count( { at: banner.position, radius: 8, faction: 'protester' } ), police = ctx.spatial.count( { at: banner.position, radius: 8, faction: 'police' } );
				if ( friends === null || police === null ) return;
				run.captured = police >= 5 && friends < 5 ? run.captured + sample.elapsed : 0;
				if ( run.captured > 10 ) { run.lost = true; return; }
				if ( friends < 5 || police >= friends ) return;
				const bearer = sample.people.filter( ( person ) => person.faction === 'protester' && person.status === 'active' && person.actor.id !== 'medics' && distance( person.position, banner.position ) < 8 )
					.sort( ( first, second ) => distance( first.position, banner.position ) - distance( second.position, banner.position ) )[ 0 ];
				if ( bearer && ctx.protected.transfer( run.banner, { carrier: bearer.handle, expectedRevision: banner.revision, expectedSample: sample.sequence, promote: true, radius: 8 } ).status === 'completed' ) run.bearers ++;

			},
			update( ctx, dt ) {

				const banner = ctx.protected.get( run.banner ), count = ctx.spatial.count( { at: run.steps, radius: 40, faction: 'protester' } );
				run.position = banner.position; run.bannerState = banner.state; run.stepsCount = count ?? 0;
				run.held = banner.state === 'carried' && banner.position && distance( banner.position, run.steps ) < 18 && count !== null && count >= 300 ? run.held + dt : 0;
				if ( ! ctx.observation || ctx.time - lastDecision < 4 ) return;
				lastDecision = ctx.time;
				const close = banner.state === 'carried' && banner.position && distance( banner.position, run.steps ) < 170;
				for ( const post of run.cordons ) {

					if ( ! post.ids.some( ( id ) => ( ctx.actors.get( ctx.actors.resolve( id ) )?.alive ?? 0 ) > 5 ) ) continue;
					const crowd = crowdAt( ctx, post.at, 30 );
					if ( crowd.n > 150 && ctx.resources.get( 'gas' ).available > 0 && ctx.time - lastGas > 35 ) {

						lastGas = ctx.time; const at = post.at.map( ( value, axis ) => value + ( crowd.at[ axis ] - value ) * 0.6 );
						announce( ctx, 'police-gas', at, 20, 'tear gas', 6, () => {

							void ctx.commands.execute( 'gas', { at, opinion: { delta: 1.5, reason: 'tear gas on camera' } } ).settled.then( ( outcome ) => { if ( outcome.status === 'completed' ) run.gas ++; } );

						} ); break;

					}
					if ( close && crowd.n > 220 && ctx.time - lastCharge > 60 && post.ids.every( ( id ) => ! busy.has( id ) ) ) {

						lastCharge = ctx.time; announce( ctx, 'police-charge', crowd.at, 15, 'baton charge', 6, () => {

							for ( const id of post.ids ) busy.add( id ); ctx.commands.execute( 'charge', { at: crowd.at, selection: selection( ctx, post.ids ) } );
							ctx.timeline.after( 12, () => { for ( const id of post.ids ) busy.delete( id ); line( ctx, post ); } );

						} ); break;

					}

				}
				const free = () => run.posts.filter( ( post ) => ! busy.has( post.id ) ).map( ( post ) => ( { ...post, actor: ctx.actors.get( ctx.actors.resolve( post.id ) ) } ) ).filter( ( post ) => post.actor?.center && post.actor.alive > 10 );
				if ( banner.state === 'carried' && banner.position && ctx.time - lastSnatch > 40 ) {

					const squad = free().find( ( post ) => distance( post.actor.center, banner.position ) < 80 );
					if ( squad ) { lastSnatch = ctx.time; busy.add( squad.id ); announce( ctx, 'police-snatch', banner.position, 10, 'snatch squad for the banner bearer', 5, () => {

						const current = ctx.protected.get( run.banner );
						if ( current.state !== 'carried' || ! current.position ) { release( ctx, [ squad.id ] ); return; }
						ctx.commands.execute( 'arrest', { at: current.position, selection: selection( ctx, [ squad.id ] ) } ); ctx.timeline.after( 40, () => release( ctx, [ squad.id ] ) );

					} ); }

				}
				if ( ctx.time - lastKettle > 60 ) {

					const team = free().slice( 0, 2 );
					const lone = ctx.observation.actors.filter( ( actor ) => actor.handle.kind === 'crowd' && actor.handle.id !== 'medics' && actor.center && actor.alive > 20
						&& ctx.people.members( actor.handle ).some( ( person ) => person.faction === 'protester' ) && crowdAt( ctx, actor.center, 40 ).n < 170 && team.length === 2 && team.every( ( post ) => distance( post.actor.center, actor.center ) < 160 ) );
					const actor = lone.find( ( actor ) => actor.handle === banner.actor ) ?? lone[ Math.floor( ctx.random() * lone.length ) ];
					if ( actor ) { lastKettle = ctx.time; const ids = team.map( ( post ) => post.id ); for ( const id of ids ) busy.add( id );
						announce( ctx, 'police-kettle', actor.center, 18, `kettle around ${actor.handle.id}`, 8, () => {

							const current = ctx.actors.get( actor.handle ); if ( current?.center ) ctx.commands.execute( 'kettle', { at: current.center, selection: selection( ctx, ids ) } );
							ctx.timeline.after( 90, () => release( ctx, ids ) );

						} ); }

				}

			},
			onAction( ctx, action ) {

				if ( action.type !== 'key' || action.key?.toLowerCase() !== 'r' || ! action.at || ctx.time < nextCall ) return;
				nextCall = ctx.time + 40; calls ++;
				const entries = [ ...ctx.spatial.entries(), { name: 'Railway station', position: ctx.locations.get( 'railway' ) } ];
				const entry = entries.sort( ( first, second ) => distance( first.position, action.at ) - distance( second.position, action.at ) )[ 0 ];
				ctx.spawn.crowd( { id: `court-arrivals-${calls}`, label: 'Arrivals', at: entry.position, people: Math.round( 80 + ctx.metrics.opinion * 4 ), groupSize: 100,
					spread: 20, goal: action.at, goalRadius: 20, morale: 0.6, resolve: [ 0.6, 1 ] } );

			},
			onEvent( ctx, event ) { if ( event.type === 'command.applied' && event.command === 'rally-call' ) this.onAction( ctx, { type: 'key', key: 'r', at: event.at } ); },
		};

	} } );
	return defineScenario( {
		id: 'court-rules', menu: false, title: 'The Court Rules Preview', subtitle: 'Carry the banner to the court', side: 'protest',
		brief: 'Carry the banner from Prešernov trg to the Palace of Justice. Hold the steps with at least 300 people for 20 uninterrupted seconds.',
		goals: [ 'Banner on the steps with 300 people for 20 s', 'Do not lose the banner', 'Within 15:00' ],
		locations: { start: place( 'Prešernov trg' ), square: place( 'Kongresni trg' ), bridge: place( 'Tromostovje' ), court: landmark( 'Vrhovno sodišče' ),
			station: landmark( 'PP Ljubljana Center' ), railway: landmark( 'Železniška postaja' ), metelkova: place( 'Metelkova' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ) },
		opinion: { initial: 50, weights: { injuriesByPolice: 0.4, officersInjured: - 0.6, arrests: 0.05, sitterArrests: 0.1, otherInjuries: - 0.1 } },
		resources: { gas: { capacity: 6 }, umbrella: { capacity: 3 }, rally: { capacity: 99, cooldown: 40 } }, commands: [ ...policeCommands( { gas: 'gas' } ), ...protestCommands( { umbrella: 'umbrella' } ), scenarioCommand( { id: 'rally-call', key: 'r', label: 'Rally call', resource: 'rally', side: 'protest' } ) ],
		setup( ctx ) {

			Object.assign( run, { held: 0, captured: 0, lost: false, bearers: 1, gas: 0, posts: [], cordons: [], stepsCount: 0,
				position: ctx.locations.get( 'start' ), bannerState: 'pending' } );
			const ring = ctx.spatial.footprint( 'court' ); if ( ! ring ) throw new Error( 'Court footprint unavailable' );
			let best: any;
			for ( let index = 0; index < ring.length; index += 2 ) {

				const start = [ ring[ index ], ring[ index + 1 ] ], end = [ ring[ ( index + 2 ) % ring.length ], ring[ ( index + 3 ) % ring.length ] ], length = distance( start, end );
				const middle = [ ( start[ 0 ] + end[ 0 ] ) / 2, ( start[ 1 ] + end[ 1 ] ) / 2 ]; let normal = [ ( end[ 1 ] - start[ 1 ] ) / length, - ( end[ 0 ] - start[ 0 ] ) / length ];
				if ( inside( ring, middle.map( ( value, axis ) => value + normal[ axis ] * 2 ) ) ) normal = normal.map( ( value ) => - value );
				if ( length < 25 || ( ctx.spatial.clearance( [ middle[ 0 ] + normal[ 0 ] * 8, middle[ 1 ] + normal[ 1 ] * 8 ] ) ?? 0 ) <= 1 ) continue;
				const separation = Math.abs( middle[ 0 ] - street( middle[ 1 ] )[ 0 ] ); if ( ! best || separation < best.separation ) best = { start, end, middle, normal, separation };

			}
			if ( ! best ) throw new Error( 'Court facade unavailable' ); run.facade = best;
			run.steps = ctx.spatial.sample( best.middle.map( ( value, axis ) => value + best.normal[ axis ] * 7 ) as Sdk.Point, { radius: 4 } );
			ctx.presentation.focus( [ 30, 160 ], 0.55 );
			for ( const options of [ { id: 'banner', label: 'Banner bloc', at: 'start', people: 250, groupSize: 250, spread: 15, morale: 0.75, agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.2 ], goalRadius: 20 },
				{ id: 'students', label: 'Students', at: 'start', people: 600, groupSize: 100, spread: 35, morale: 0.6, goalRadius: 30 },
				{ id: 'unions', label: 'Unions', at: 'square', people: 500, groupSize: 100, spread: 30, morale: 0.65, resolve: [ 0.8, 1.1 ], goalRadius: 30 },
				{ id: 'cyclists', label: 'Kolesarji', at: 'bridge', people: 120, groupSize: 40, spread: 15, morale: 0.7, bikes: 1, goalRadius: 20 },
				{ id: 'medics', label: 'Medics', at: 'start', people: 20, groupSize: 20, spread: 8, morale: 0.9, agitation: [ 0, 0.05 ], resolve: [ 1, 1.3 ], goalRadius: 15, medic: true } ] ) {

				ctx.spawn.crowd( { ...options, mode: 'hold', goal: options.at } as Sdk.CrowdSpawnOptions );

			}
			run.banner = ctx.protected.create( { id: 'court-banner', label: 'Banner', carrier: 'banner' } );
			for ( const [ index, at ] of [ street( 110 ), street( 220 ), best.middle.map( ( value, axis ) => value + best.normal[ axis ] * 12 ) ].entries() ) {

				const center = ctx.spatial.walkable( at as Sdk.Point, 30 ) ?? at;
				const span = index < 2 ? ctx.spatial.roadSpan( center, 30 ) : { a: best.start.map( ( value, axis ) => value + best.normal[ axis ] * 12 ), b: best.end.map( ( value, axis ) => value + best.normal[ axis ] * 12 ) };
				const ids = [ `court-line-${index}-1`, `court-line-${index}-2` ]; run.cordons.push( { ids, at: center, a: span.a, b: span.b } );
				for ( const id of ids ) ctx.spawn.squad( { id, at: center, people: 24 } );
				if ( index < 2 ) ctx.spawn.vehicle( { id: `court-van-${index}`, at: ctx.spatial.walkable( [ center[ 0 ] + 2, center[ 1 ] + 14 ], 20 ) ?? center, type: 'police-patrol', crew: 0, selectable: false } );

			}
			for ( const [ index, at ] of [ [ 20, 285 ], [ 160, 330 ], ctx.locations.get( 'station' ), ctx.locations.get( 'station' ), [ 130, 200 ] ].entries() ) {

				const id = `court-reserve-${index}`; ctx.spawn.squad( { id, at: at as Sdk.Point, people: 24 } ); run.posts.push( { id, at } );

			}
			ctx.spawn.bystanders( { id: 'onlookers', people: 1500, destinations: [ 'start', 'square', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		}, behaviors: [ director( { id: 'court' } ) ],
		objectives: [ survive( { id: 'deadline', seconds: 901 } ) ],
		outcomes: [ defineOutcome( { id: 'court-result', evaluate: ( { time, metrics } ) => {

			if ( run.held >= 20 ) return { win: true, reason: time < 600 ? 'The banner stood on the court steps as the verdict was read.' : 'The banner made it to the court steps, and onto every front page.' };
			if ( run.lost ) return { win: false, reason: 'The police confiscated the banner. The march breaks up.' };
			if ( time >= 900 ) return { win: false, reason: 'The evening is over and the banner never reached the court.' }; return null;

		} } ) ],
		hud: ( { time, metrics } ) => [ { label: 'Banner to the court steps', value: Math.max( 0, 1 - ( run.position ? distance( run.position, run.steps ) : 420 ) / 420 ), text: run.position ? `${Math.round( distance( run.position, run.steps ) )} m` : 'dropped!', state: run.bannerState === 'dropped' ? 'bad' : 'ok' },
			{ label: 'People on the steps (300)', value: Math.min( 1, run.stepsCount / 300 ), text: `${run.stepsCount ?? 0}${run.held > 0 ? ` · ${Math.ceil( 20 - run.held )} s` : ''}`, state: run.stepsCount >= 300 ? 'done' : 'ok' },
			{ label: 'Before the verdict', value: Math.min( 1, time / 600 ), text: time < 600 ? timeText( 600 - time ) : 'read', state: time < 600 ? 'ok' : 'bad', invert: true },
			{ label: '★ Sympathy ≥ 50 · officers hurt ≤ 10', value: Math.min( 1, metrics.counters.officersInjured / 10 ), text: `${Math.round( metrics.opinion )} · ${metrics.counters.officersInjured}`, state: metrics.opinion < 50 || metrics.counters.officersInjured > 10 ? 'bad' : 'ok', invert: true } ],
		phase: ( { time } ) => `Banner ${run.position && run.steps ? Math.round( distance( run.position, run.steps ) ) : 0} m from the steps · ${time < 600 ? `verdict in ${timeText( 600 - time )}` : `${timeText( 900 - time )} left`}`,
		score: ( { win, time, metrics } ) => ( { stars: Number( win ) + Number( win && time < 600 ) + Number( win && metrics.opinion >= 50 && metrics.counters.officersInjured <= 10 ),
			lines: [ [ 'Time', timeText( time ) ], [ 'Banner bearers', run.bearers ], [ 'Public sympathy', Math.round( metrics.opinion ) ], [ 'Protesters injured', metrics.counters.injuriesByPolice ], [ 'Treated by medics', metrics.counters.treatedByMedics ?? 0 ],
				[ 'Officers injured', metrics.counters.officersInjured ], [ 'Arrested', metrics.counters.arrests ], [ 'Tear gas fired', run.gas ] ] } ),
	} );

};
