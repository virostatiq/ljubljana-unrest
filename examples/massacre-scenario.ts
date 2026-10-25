import type * as Sdk from '../src/game/scenarios/sdk.d.ts';
import { gap, ringDistance, timeText } from './mission-path.ts';

export const sdkVersion = 1;
const FENCE: Sdk.Point[] = [ [ - 694, 32.9 ], [ - 694, 27.5 ], [ - 665, 20.8 ], [ - 621.9, 8.7 ], [ - 593.7, 2.5 ], [ - 587, 19.4 ], [ - 580.3, 41 ], [ - 568.2, 57.1 ], [ - 564.2, 75.9 ], [ - 560.1, 99.5 ], [ - 587, 108.1 ], [ - 611.2, 113.5 ], [ - 638.1, 119.4 ], [ - 644.5, 107.1 ], [ - 655, 93.9 ], [ - 665.6, 81.4 ], [ - 672, 67.5 ], [ - 673.9, 58 ], [ - 687.1, 48.6 ], [ - 694, 32.9 ] ];
const GUNS: Sdk.Point[] = [ [ - 571.7, 85 ], [ - 578.9, 68.4 ] ], BREACH: Sdk.Point = [ - 565, 71 ], RALLY: Sdk.Point = [ - 552, 86 ];
const angleDifference = ( first, second ) => Math.atan2( Math.sin( first - second ), Math.cos( first - second ) );

function inside( position: Sdk.Point ) {

	let result = false;
	for ( let index = 1; index < FENCE.length; index ++ ) { const start = FENCE[ index - 1 ], end = FENCE[ index ];
		if ( ( start[ 1 ] > position[ 1 ] ) !== ( end[ 1 ] > position[ 1 ] ) && position[ 0 ] < ( end[ 0 ] - start[ 0 ] ) * ( position[ 1 ] - start[ 1 ] ) / ( end[ 1 ] - start[ 1 ] ) + start[ 0 ] ) result = ! result; }
	return result;

}

export default ( { defineScenario, defineBehavior, defineOutcome, survive, landmark, place, policeCommands, scenarioCommand }: typeof Sdk ) => {

	const mid: Sdk.Point = [ ( GUNS[ 0 ][ 0 ] + GUNS[ 1 ][ 0 ] ) / 2, ( GUNS[ 0 ][ 1 ] + GUNS[ 1 ][ 1 ] ) / 2 ];
	const run: any = { alertAt: null, fireAt: null, firing: false, breached: false, finishAt: null, inFire: 0, peak: 0, atBreach: 0, groups: [], safe: [], approaches: [], guns: [] };
	const director = defineBehavior( { id: 'embassy-incident', create() {

		let arrivals = 0; const hit = new Set(), evacuated = new Set();
		const reach = ( ctx, gun, angle, range = 220 ) => ctx.spatial.ray( gun.at, angle, range, true );
		const sees = ( ctx, gun, at ) => { const distance = gap( gun.at, at ), angle = Math.atan2( at[ 1 ] - gun.at[ 1 ], at[ 0 ] - gun.at[ 0 ] ); return distance <= 220 && Math.abs( angleDifference( angle, gun.face ) ) <= 80 * Math.PI / 180 && reach( ctx, gun, angle, distance ) >= distance - 0.5; };
		const exposed = ( ctx, at ) => run.guns.some( ( gun ) => sees( ctx, gun, at ) );
		const evacuate = ( ctx, id, speed = 1.25, panic = false ) => {

			const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( ! actor?.center ) return;
			const away = [ actor.center[ 0 ] - mid[ 0 ], actor.center[ 1 ] - mid[ 1 ] ], length = Math.hypot( ...away ) || 1;
			const options = run.safe.map( ( at ) => { const delta = [ at[ 0 ] - actor.center[ 0 ], at[ 1 ] - actor.center[ 1 ] ], distance = Math.hypot( ...delta ) || 1;
				return { at, score: panic ? distance * ( 1.6 - ( delta[ 0 ] * away[ 0 ] + delta[ 1 ] * away[ 1 ] ) / ( distance * length ) ) : distance }; } ).sort( ( first, second ) => first.score - second.score );
			evacuated.add( id ); ctx.actors.configure( id, { speed } );
			void ctx.movement.move( actor.handle, options[ 0 ].at, { radius: 16 } ).settled.then( ( outcome ) => { if ( panic && outcome.status === 'completed' && ! ctx.signal.aborted ) ctx.crowd.setMode( id, 'panic' ); } );

		};
		const alert = ( ctx ) => {

			if ( run.alertAt !== null ) return; run.alertAt = ctx.time; run.fireAt = ctx.time + 15; run.finishAt = ctx.time + 95;
			ctx.presentation.notice( 'ALERT at the embassy: the Marines have uncovered two machine-gun posts. The crowd starts backing away from the fence.', 'bad', mid );
			for ( const id of run.groups ) { const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( actor?.center && gap( actor.center, BREACH ) < 150 ) evacuate( ctx, id, 0.6 ); }
			ctx.timeline.after( 7.5, () => ctx.presentation.notice( 'The fence is giving way', 'bad', BREACH ) );
			ctx.timeline.after( 15, () => {

				run.breached = true; run.firing = true; run.atBreach = run.inFire; ctx.environment.openBarrier( 'embassy-fence', { at: BREACH, radius: 3.2 } );
				ctx.presentation.notice( 'The fence is down. The Marines OPEN FIRE.', 'bad', mid );
				for ( const actor of ctx.observation?.actors ?? [] ) if ( actor.handle.kind === 'crowd' && actor.handle.id !== 'antifa' && actor.center && gap( actor.center, mid ) <= 320 ) evacuate( ctx, actor.handle.id, 1.1 + ctx.random() * 0.2, true );
				ctx.actors.configure( 'antifa', { parting: false } );

			} );
			ctx.timeline.after( 75, () => { run.firing = false; ctx.presentation.notice( `Cease fire. ${ctx.metrics.counters.peopleKilled} dead.`, ctx.metrics.counters.peopleKilled < 100 ? 'warn' : 'bad', mid ); } );

		};
		return {
			start( ctx ) {

				ctx.timeline.after( 2, () => ctx.presentation.notice( 'A peaceful anti-war demonstration in front of the US Embassy. More people are on their way.', 'info', RALLY ) );
				for ( let time = 12; time < 270; time += 18 ) ctx.timeline.after( time, () => {

					if ( run.firing || run.alertAt !== null && ctx.time > run.alertAt + 30 ) return;
					const id = `demonstrators-${++ arrivals}`; run.groups.push( id ); ctx.spawn.crowd( { id, label: 'Anti-war demonstration', at: run.approaches[ Math.floor( ctx.random() * run.approaches.length ) ],
						people: Math.round( 90 + ctx.random() * 80 ), groupSize: 45, spread: 15, goal: RALLY, goalRadius: 30, agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.3 ], morale: 0.7 } );

				} );
				ctx.timeline.after( 120, () => { const operation = ctx.spawn.crowd( { id: 'antifa', label: 'AntiFa', at: ctx.spatial.walkable( [ - 470, 70 ] ) ?? [ - 470, 70 ], people: 24, groupSize: 24, spread: 4,
					goal: [ BREACH[ 0 ] + 2.5, BREACH[ 1 ] + 0.5 ], goalRadius: 3, mode: 'push' as Sdk.CrowdSpawnOptions['mode'], agitation: [ 0.65, 0.85 ], resolve: [ 1.3, 1.5 ], morale: 0.95, speed: [ 1.15, 1.15 ] } );
					void operation.settled.then( ( outcome ) => { if ( outcome.status === 'completed' && ! ctx.signal.aborted ) { run.antifa = outcome.value; ctx.actors.configure( outcome.value, { parting: true } ); } } ); } );
				ctx.timeline.after( 240, () => alert( ctx ) );

			},
			observe( ctx, sample ) {

				run.inFire = 0;
				for ( const gun of run.guns ) gun.candidates = [];
				for ( const person of sample.people ) {

					if ( person.status !== 'active' || hit.has( person.handle ) || ! exposed( ctx, person.position ) ) continue;
					if ( person.faction !== 'bystander' || gap( person.position, mid ) < 120 ) run.inFire ++;
					for ( const gun of run.guns ) if ( gap( person.position, gun.at ) < 220 ) gun.candidates.push( person );

				}
				run.peak = Math.max( run.peak, run.inFire );

			},
			update( ctx, dt ) {

				if ( run.antifa && run.alertAt === null ) { const actor = ctx.actors.get( run.antifa ); if ( actor?.center && gap( actor.center, BREACH ) < 15 ) alert( ctx ); }
				if ( run.firing && ctx.observation ) for ( const gun of run.guns ) {

					if ( ctx.time >= gun.retarget || ! gun.target || !( ctx.actors.get( gun.target )?.alive > 0 ) ) {

						gun.retarget = ctx.time + 1.5; gun.target = ctx.observation.actors.filter( ( actor ) => actor.handle.kind !== 'vehicle' && actor.alive > 0 && actor.center && sees( ctx, gun, actor.center ) ).sort( ( first, second ) => gap( first.center, gun.at ) - gap( second.center, gun.at ) )[ 0 ]?.handle;

					}
					gun.phase += dt * 2.6; const target = gun.target && ctx.actors.get( gun.target );
					const angle = target?.center ? Math.atan2( target.center[ 1 ] - gun.at[ 1 ], target.center[ 0 ] - gun.at[ 0 ] ) + Math.sin( gun.phase ) * Math.min( 0.26, Math.max( 0.07, Math.atan2( Math.sqrt( target.alive ) * 0.5 + 2, Math.max( 4, gap( target.center, gun.at ) ) ) ) ) : gun.face + Math.sin( gun.phase * 0.4 ) * 80 * Math.PI / 180;
					gun.angle = gun.face + Math.max( - 80 * Math.PI / 180, Math.min( 80 * Math.PI / 180, angleDifference( angle, gun.face ) ) ); gun.acc += dt * 6;
					while ( gun.acc >= 1 ) { gun.acc --; const scatter = Math.sqrt( - 2 * Math.log( Math.max( 1e-10, ctx.random() ) ) ) * Math.cos( 2 * Math.PI * ctx.random() ) * 0.9 * Math.PI / 180;
						const shot = gun.angle + scatter, deltaX = Math.cos( shot ), deltaY = Math.sin( shot ), wall = reach( ctx, gun, shot );
						const people = ( gun.candidates ?? [] ).map( ( person ) => { const x = person.position[ 0 ] - gun.at[ 0 ], y = person.position[ 1 ] - gun.at[ 1 ]; return { person, along: x * deltaX + y * deltaY, across: Math.abs( x * deltaY - y * deltaX ) }; } )
							.filter( ( entry ) => entry.along >= 2 && entry.along <= wall && entry.across <= 0.45 ).sort( ( first, second ) => first.along - second.along );
						for ( const entry of people ) { if ( hit.has( entry.person.handle ) ) continue;
							const effect = ctx.effects.apply( entry.person.handle, { status: ctx.random() < 0.5 ? 'dead' : 'injured', source: 'other', expectedSample: ctx.observation.sequence } );
							if ( effect.status === 'queued' ) hit.add( entry.person.handle ); if ( ctx.random() > 0.3 ) break; }
					}

				}
				const markers: Sdk.MapMarker[] = [ { id: 'embassy', at: mid, radius: 50, label: run.firing ? 'FIRING' : run.alertAt !== null ? 'ALERT' : 'US Embassy', kind: run.alertAt !== null ? 'bad' : 'warn' } ];
				for ( const [ index, gun ] of run.guns.entries() ) markers.push( { id: `gun-${index}`, at: gun.at, radius: 4, label: 'Marine post', kind: 'bad' } );
				for ( const [ index, gun ] of run.guns.entries() ) markers.push( { id: `fire-fan-${index}`, at: gun.at, radius: 220, label: 'Field of fire', kind: 'bad', shape: 'polygon', points: gun.fan } );
				markers.push( { id: 'fence', at: mid, radius: 60, label: 'Embassy compound', kind: 'info', shape: 'polygon', points: FENCE } );
				if ( run.alertAt !== null && ! run.breached ) markers.push( { id: 'breach', at: BREACH, radius: 8, label: 'Fence breach', kind: 'bad', countdownTo: run.fireAt } ); ctx.presentation.markers( markers );

			},
			onEvent( ctx, event ) {

				if ( event.type !== 'command.applied' || event.command !== 'evacuate-order' ) return;
				if ( run.alertAt === null ) { ctx.opinion.adjust( - 2, 'ordering a lawful demonstration away' ); for ( const id of run.groups ) { const actor = ctx.actors.get( ctx.actors.resolve( id ) ); if ( actor?.center && gap( actor.center, event.at ) < 70 && ! evacuated.has( id ) && ctx.random() < 0.12 ) evacuate( ctx, id ); } }
				else for ( const actor of ctx.observation?.actors ?? [] ) if ( actor.handle.kind === 'crowd' && actor.handle.id !== 'antifa' && actor.center && gap( actor.center, event.at ) <= 90 ) evacuate( ctx, actor.handle.id );

			},
		};

	} } );
	return defineScenario( { id: 'massacre-rules', menu: false, title: 'The Massacre Rules Preview', subtitle: 'Evacuate the embassy firing ground',
		brief: 'Fictional. A peaceful crowd gathers outside the US Embassy. When the alert sounds the fence will fail in fifteen seconds; move people out of the guns’ line of fire.',
		goals: [ 'Fewer than 100 dead', 'Evacuate people from the firing ground' ],
		terrain: [ { id: 'embassy-fence', polygon: FENCE, halfWidth: 0.4, excludeInterior: true } ],
		locations: { station: landmark( 'PU Ljubljana' ), square: place( 'Trg republike' ), preseren: place( 'Prešernov trg' ), kongresni: place( 'Kongresni trg' ), metelkova: place( 'Metelkova' ), railway: landmark( 'Železniška postaja' ), tivoli: place( 'Park Tivoli' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ) },
		opinion: { initial: 60, weights: { injuriesByPolice: - 0.5, officersInjured: 0.1, arrests: - 0.05, sitterArrests: 0, otherInjuries: - 0.1 } },
		resources: { gas: { capacity: 2 }, water: { capacity: 2 }, reinforce: { capacity: 4, cooldown: 20 }, order: { capacity: 99, cooldown: 6 } },
		commands: [ ...policeCommands( { gas: 'gas', water: 'water', reinforce: 'reinforce', crew: true, firearms: true } ), scenarioCommand( { id: 'evacuate-order', key: 'b', label: 'Order to leave', resource: 'order' } ) ],
		setup( ctx ) {

			Object.assign( run, { alertAt: null, fireAt: null, firing: false, breached: false, finishAt: null, inFire: 0, peak: 0, atBreach: 0, groups: [], safe: [], antifa: null } ); ctx.presentation.focus( [ - 560, 60 ], 0.45 );
			run.guns = GUNS.map( ( at ) => { let best = Infinity, normal = [ 1, 0 ]; for ( let index = 1; index < FENCE.length; index ++ ) { const start = FENCE[ index - 1 ], end = FENCE[ index ], length = gap( start, end );
					const fraction = Math.max( 0, Math.min( 1, ( ( at[ 0 ] - start[ 0 ] ) * ( end[ 0 ] - start[ 0 ] ) + ( at[ 1 ] - start[ 1 ] ) * ( end[ 1 ] - start[ 1 ] ) ) / ( length ** 2 || 1 ) ) ); const distance = gap( at, [ start[ 0 ] + ( end[ 0 ] - start[ 0 ] ) * fraction, start[ 1 ] + ( end[ 1 ] - start[ 1 ] ) * fraction ] );
					if ( distance < best ) { best = distance; normal = [ - ( end[ 1 ] - start[ 1 ] ) / length, ( end[ 0 ] - start[ 0 ] ) / length ]; } }
				if ( inside( [ at[ 0 ] + normal[ 0 ] * ( best + 3 ), at[ 1 ] + normal[ 1 ] * ( best + 3 ) ] ) ) normal = normal.map( ( value ) => - value ); return { at, face: Math.atan2( normal[ 1 ], normal[ 0 ] ), phase: ctx.random() * 6, angle: 0, acc: 0, retarget: 0, candidates: [] }; } );
			for ( const gun of run.guns ) { gun.fan = [ gun.at ]; for ( let offset = - 80 * Math.PI / 180; offset <= 80 * Math.PI / 180 + 1e-6; offset += Math.PI / 360 ) { const angle = gun.face + offset, range = ctx.spatial.ray( gun.at, angle, 220, true ); gun.fan.push( [ gun.at[ 0 ] + Math.cos( angle ) * range, gun.at[ 1 ] + Math.sin( angle ) * range ] ); } }
			for ( const radius of [ 150, 180, 210, 240 ] ) for ( let angle = 0; angle < 360; angle += 7.5 ) { const at = ctx.spatial.walkable( [ mid[ 0 ] + Math.cos( angle * Math.PI / 180 ) * radius, mid[ 1 ] + Math.sin( angle * Math.PI / 180 ) * radius ], 25 );
				if ( ! at || inside( at ) || run.guns.some( ( gun ) => { const distance = gap( at, gun.at ), direction = Math.atan2( at[ 1 ] - gun.at[ 1 ], at[ 0 ] - gun.at[ 0 ] ); return distance <= 220 && Math.abs( angleDifference( direction, gun.face ) ) <= 80 * Math.PI / 180 && ctx.spatial.ray( gun.at, direction, distance, true ) >= distance - 0.5; } ) ) continue;
				if ( run.safe.length < 6 && run.safe.every( ( point ) => Math.abs( angleDifference( Math.atan2( point[ 1 ] - mid[ 1 ], point[ 0 ] - mid[ 0 ] ), Math.atan2( at[ 1 ] - mid[ 1 ], at[ 0 ] - mid[ 0 ] ) ) ) > 0.7 ) ) run.safe.push( at ); }
			if ( ! run.safe.length ) run.safe.push( [ mid[ 0 ], mid[ 1 ] - 300 ] );
			run.approaches = [ [ - 505, 330 ], [ - 400, 150 ], [ - 450, 55 ], [ - 575, - 150 ], [ - 760, 200 ] ].map( ( at ) => ctx.spatial.walkable( [ at[ 0 ], at[ 1 ] ], 60 ) ?? at );
			const points: Sdk.Point[] = []; for ( let attempt = 0; points.length < 2500 && attempt < 150000; attempt ++ ) { const angle = ctx.random() * Math.PI * 2, radius = Math.sqrt( ctx.random() ) * 75, at: Sdk.Point = [ RALLY[ 0 ] + Math.cos( angle ) * radius, RALLY[ 1 ] + Math.sin( angle ) * radius ]; if ( ( ctx.spatial.clearance( at ) ?? 0 ) > 0.7 && ctx.spatial.cost( at ) <= 18 && ! inside( at ) ) points.push( at ); }
			if ( ! points.length ) throw new Error( 'Embassy crowd placement unavailable' ); points.sort( ( first, second ) => Math.atan2( first[ 1 ] - RALLY[ 1 ], first[ 0 ] - RALLY[ 0 ] ) - Math.atan2( second[ 1 ] - RALLY[ 1 ], second[ 0 ] - RALLY[ 0 ] ) );
			for ( let offset = 0; offset < points.length; offset += 50 ) { const id = `demonstration-${offset}`, positions = points.slice( offset, offset + 50 ); run.groups.push( id ); ctx.spawn.crowd( { id, label: 'Anti-war demonstration', at: RALLY, people: positions.length, points: positions, groupSize: 50, goal: RALLY, goalRadius: 30, mode: 'march', agitation: [ 0.05, 0.2 ], resolve: [ 0.9, 1.3 ], morale: 0.7 } ); }
			for ( const [ index, at ] of [ [ - 560, 70 ], [ - 558, 80 ], ctx.locations.get( 'station' ), [ - 540, 150 ], ctx.locations.get( 'square' ), ctx.locations.get( 'square' ), [ - 490, 150 ] ].entries() ) ctx.spawn.squad( { id: `police-${index}`, at: at as Sdk.Point, people: 24 } );
			ctx.spawn.vehicle( { id: 'patrol-1', type: 'police-patrol', at: [ - 600, - 30 ] } ); ctx.spawn.vehicle( { id: 'patrol-2', type: 'police-patrol', at: [ - 520, 175 ] } ); ctx.spawn.vehicle( { id: 'water-cannon', type: 'water-cannon', at: [ - 585, - 45 ] } );
			ctx.spawn.bystanders( { id: 'onlookers', people: 500, destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		}, behaviors: [ director( { id: 'embassy' } ) ], objectives: [ survive( { id: 'incident', seconds: 400 } ) ],
		outcomes: [ defineOutcome( { id: 'incident-result', evaluate: ( { time, metrics } ) => { if ( run.finishAt === null || time < run.finishAt ) return null; const dead = metrics.counters.peopleKilled; return { win: dead < 100,
			reason: dead < 100 ? dead ? `${dead} people were killed in front of the embassy. Without your work it would have been many more.` : 'Nobody was in front of the guns when they fired.' : `${dead} people were killed in front of the embassy. The street was still full when the guns opened up.` }; } } ) ],
		phase: ( { time, metrics } ) => run.firing ? `FIRING · ${timeText( 60 - ( time - run.fireAt ) )} · ${metrics.counters.peopleKilled} dead` : run.breached ? `Cease fire · ${metrics.counters.peopleKilled} dead` : run.alertAt !== null ? `ALERT · fence gives way in ${timeText( run.fireAt - time )} · ${run.inFire} in the line of fire` : 'Peaceful demonstration',
		score: ( { win, metrics } ) => ( { stars: win ? 1 + Number( metrics.counters.peopleKilled < 50 ) + Number( metrics.counters.peopleKilled < 25 && metrics.counters.officersKilled === 0 ) : 0,
			lines: [ [ 'Dead', metrics.counters.peopleKilled ], [ 'Officers killed', metrics.counters.officersKilled ], [ 'Wounded', metrics.counters.otherInjuries + metrics.counters.injuriesByPolice ], [ 'In the line of fire at the breach', run.atBreach ], [ 'Most in the line of fire', run.peak ], [ 'Arrests', metrics.counters.arrests ], [ 'Public opinion', Math.round( metrics.opinion ) ] ] } ),
	} );

};
