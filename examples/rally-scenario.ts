import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export const sdkVersion = 1;

const POSTS = [ 'preseren', 'tivoli', 'station', 'kongresni' ];
const STARTING_GROUPS: Sdk.CrowdSpawnOptions[] = [
	{ id: 'preseren-bloc', label: 'Prešernov trg', at: 'preseren', people: 900, groupSize: 100, spread: 40, goal: 'preseren', goalRadius: 30,
		mode: 'hold', morale: 0.6, resolve: [ 0.7, 1 ], bikes: 0 },
	{ id: 'metelkova-bloc', label: 'Metelkova', at: 'metelkova', people: 700, groupSize: 100, spread: 40, goal: 'metelkova', goalRadius: 30,
		mode: 'hold', morale: 0.6, resolve: [ 0.7, 1 ], bikes: 0 },
	{ id: 'tivoli-bloc', label: 'Park Tivoli', at: 'tivoli', people: 600, groupSize: 100, spread: 40, goal: 'tivoli', goalRadius: 30,
		mode: 'hold', morale: 0.6, resolve: [ 0.7, 1 ], bikes: 0 },
	{ id: 'cyclists', label: 'Kolesarji', at: 'kongresni', people: 300, groupSize: 60, spread: 25, goal: 'kongresni', goalRadius: 25,
		mode: 'hold', morale: 0.7, resolve: [ 0.8, 1.1 ], bikes: 1 },
];

function formatTime( seconds ) {

	const value = Math.floor( Math.max( 0, seconds ) );
	return `${Math.floor( value / 60 )}:${String( value % 60 ).padStart( 2, '0' )}`;

}

function approaches( ctx: Pick<Sdk.ScenarioContext, 'locations' | 'spatial'> ): { id: string; center: Sdk.Point; left: Sdk.Point; right: Sdk.Point }[] {

	const square = ctx.locations.get( 'square' );
	return POSTS.map( ( id ) => {

		const origin = ctx.locations.get( id ), dx = origin[ 0 ] - square[ 0 ], dy = origin[ 1 ] - square[ 1 ];
		const length = Math.hypot( dx, dy ) || 1, ux = dx / length, uy = dy / length;
		const raw: Sdk.Point = [ square[ 0 ] + ux * 85, square[ 1 ] + uy * 85 ];
		const center = ctx.spatial.walkable( raw, 30 ) ?? raw;
		const tx = - uy * 22, ty = ux * 22;
		const left: Sdk.Point = [ center[ 0 ] - tx, center[ 1 ] - ty ], right: Sdk.Point = [ center[ 0 ] + tx, center[ 1 ] + ty ];
		return { id, center, left, right, units: 2, outer: false };

	} );

}

export default ( { defineScenario, defineBehavior, holdCrowd, landmark, place, policeCommands, protestCommands, scenarioCommand }: typeof Sdk ) => {

	const director = defineBehavior( {
		id: 'rally-crowd-and-police',
		create() {

			let nextCallAt = 0, calls = 0, nextDirectorAt = 5, clearing = false, gassing = false;
			let cordons = [], outerRoads = [], cordonGasRemaining = 6, squareGasRemaining = 40, lastVolleyAt = - 99, lastCordonGasAt = - 99;
			let lastReinforcementAt = 0, lastAdvanceAt = - 99, lastKettleAt = - 99, reinforcementSquads = 0;
			const reserveIds = Array.from( { length: 6 }, ( _, index ) => `reserve-${String( index + 1 ).padStart( 2, '0' )}` );
			const busyReserves = new Set();
			const snatchReserves = new Map();
			let lastChargeAt = - 99;
			const freeReserves = ( ctx, limit ) => {

				const actors = new Map<string, Sdk.ActorObservation>( ( ctx.observation?.actors ?? [] ).map( ( actor ) => [ actor.handle.id, actor ] ) );
				return reserveIds.filter( ( id ) => ! busyReserves.has( id ) ).map( ( id ) => ( { id, handle: ctx.actors.resolve( id ), actor: actors.get( id ) } ) )
					.filter( ( reserve ) => reserve.actor?.center && reserve.actor.alive > 10 ).slice( 0, limit );

			};
			const reinforce = ( ctx, fraction ) => {

				const count = Math.min( 2, 30 - reinforcementSquads );
				const newSquads = [];
				for ( let index = 0; index < count; index ++ ) {

					const sequence = ++ reinforcementSquads, at = ctx.random() < 0.5 ? 'station' : 'police-center';
					const id = `reinforcement-${String( sequence ).padStart( 2, '0' )}`;
					newSquads.push( { id, at, sequence, operation: ctx.spawn.squad( { id, at, people: 26 } ) } );

				}
				if ( ! count ) return;
				const openRoads = outerRoads.filter( ( road ) => ! road.used );
				if ( fraction < 2 / 3 && openRoads.length ) {

					const score = ( road ) => ( ctx.spatial.count( { at: road.at, radius: 70, faction: 'protester' } ) ?? 0 )
						- 2 * ( ctx.spatial.count( { at: road.at, radius: 12, faction: 'protester' } ) ?? 0 ) + ctx.random() * 5;
					const road = openRoads.reduce( ( best, current ) => score( current ) > score( best ) ? current : best );
					road.used = true;
					const id = `outer-${newSquads[ 0 ].sequence}`;
					void Promise.all( newSquads.map( ( squad ) => squad.operation.settled ) ).then( ( outcomes ) => {

						if ( ctx.signal.aborted || outcomes.some( ( outcome ) => outcome.status !== 'completed' ) ) return;
						const handles = outcomes.map( ( outcome ) => outcome.value );
						const movement = handles.map( ( handle, index ) => ctx.movement.move( handle, index === 0 ? road.b : road.a,
							{ line: index === 0 ? road.a : road.b } ) );
						void Promise.all( movement.map( ( operation ) => operation.settled ) ).then( ( results ) => {

							if ( ctx.signal.aborted || results.some( ( result ) => result.status !== 'completed' ) ) return;
							cordons.push( { id, center: road.at, left: road.a, right: road.b, units: 2, outer: true } );
							ctx.presentation.notice( 'Police reinforcements cordon off another street', 'warn', road.at );

						} ).catch( () => {} );

					} ).catch( () => {} );
					return;

				}
				if ( clearing && reinforcementSquads % 4 === 0 ) {

					const inner = cordons.filter( ( post ) => ! post.outer ).sort( ( first, second ) => first.units - second.units )[ 0 ];
					if ( inner ) {

						void Promise.all( newSquads.map( ( squad ) => squad.operation.settled ) ).then( ( outcomes ) => {

							if ( ctx.signal.aborted || outcomes.some( ( outcome ) => outcome.status !== 'completed' ) ) return;
							const moves = outcomes.map( ( outcome, index ) => ctx.movement.move( outcome.value, index === 0 ? inner.right : inner.left,
								{ line: index === 0 ? inner.left : inner.right } ) );
							void Promise.all( moves.map( ( operation ) => operation.settled ) ).then( ( results ) => {

								if ( ctx.signal.aborted || results.some( ( result ) => result.status !== 'completed' ) ) return;
								inner.units += 2;
								ctx.presentation.notice( 'Police reinforcements join a line on the square', 'warn', inner.center );

							} ).catch( () => {} );

						} ).catch( () => {} );
						return;

					}

				}
				for ( const squad of newSquads ) reserveIds.push( squad.id );
				ctx.presentation.notice( 'Police reinforcements arrive', 'warn', newSquads[ 0 ].at );

			};
			const advanceLines = ( ctx ) => {

				const square = ctx.locations.get( 'square' );
				for ( const post of cordons ) {

					if ( post.outer || post.advancing ) continue;
					const dx = square[ 0 ] - post.center[ 0 ], dy = square[ 1 ] - post.center[ 1 ], distance = Math.hypot( dx, dy ) || 1;
					if ( distance < 38 ) continue;
					const offset: Sdk.Point = [ dx / distance * 8, dy / distance * 8 ];
					const center: Sdk.Point = [ post.center[ 0 ] + offset[ 0 ], post.center[ 1 ] + offset[ 1 ] ];
					const left: Sdk.Point = [ post.left[ 0 ] + offset[ 0 ], post.left[ 1 ] + offset[ 1 ] ];
					const right: Sdk.Point = [ post.right[ 0 ] + offset[ 0 ], post.right[ 1 ] + offset[ 1 ] ];
					post.advancing = true;
					const operations = [ ctx.movement.move( `cordon-${post.id}-1`, center, { line: left } ),
						ctx.movement.move( `cordon-${post.id}-2`, right, { line: center } ) ];
					void Promise.all( operations.map( ( operation ) => operation.settled ) ).then( ( outcomes ) => {

						if ( ! ctx.signal.aborted && outcomes.every( ( outcome ) => outcome.status === 'completed' ) ) {
							post.center = center; post.left = left; post.right = right;
						}
						post.advancing = false;

					} ).catch( () => { post.advancing = false; } );

				}

			};
			return {
				start( ctx ) {

					cordons = approaches( ctx );
					outerRoads = [];
					const square = ctx.locations.get( 'square' );
					for ( const radius of [ 140, 190 ] ) for ( let index = 0; index < 48; index ++ ) {

						const angle = index / 48 * Math.PI * 2;
						const raw: Sdk.Point = [ square[ 0 ] + Math.cos( angle ) * radius, square[ 1 ] + Math.sin( angle ) * radius ];
						const at = ctx.spatial.walkable( raw, 30 );
						if ( ! at ) continue;
						const distance = Math.hypot( at[ 0 ] - square[ 0 ], at[ 1 ] - square[ 1 ] );
						if ( distance > 220 || distance < 120 ) continue;
						if ( [ ...cordons, ...outerRoads ].some( ( post ) => post.center && Math.hypot( post.center[ 0 ] - at[ 0 ], post.center[ 1 ] - at[ 1 ] ) < 45 ) ) continue;
						const span = ctx.spatial.roadSpan?.( at, 16 );
						if ( span && span.width >= 6 && span.width <= 28 ) outerRoads.push( { at, center: at, a: span.a, b: span.b, used: false } );

					}
					for ( const post of cordons ) {

						ctx.movement.move( `cordon-${post.id}-1`, post.center, { line: post.left } );
						ctx.movement.move( `cordon-${post.id}-2`, post.right, { line: post.center } );

					}

				},
				onAction( ctx, action ) {

					if ( action.type !== 'key' || action.key?.toLowerCase() !== 'r' ) return;
					if ( ctx.time < nextCallAt ) { ctx.presentation.notice( `Rally call ready in ${Math.ceil( nextCallAt - ctx.time )} s`, 'warn' ); return; }
					if ( calls >= 99 ) { ctx.presentation.notice( 'No rally calls remain', 'bad' ); return; }
					const entries = ctx.spatial.entries();
					if ( ! entries.length ) { ctx.presentation.notice( 'No street entries are available for arrivals', 'bad' ); return; }
					const square = ctx.locations.get( 'square' ), destination = action.at ?? square;
					const headcount = ctx.spatial.count( { at: square, radius: 60, faction: 'protester' } ) ?? 0;
					const momentum = Math.min( 1, headcount / 5000 ) * 0.5 + ctx.metrics.opinion / 200;
					const people = Math.round( 200 + 900 * momentum ), call = ++ calls;
					nextCallAt = ctx.time + 30;
					ctx.presentation.notice( `Rally call: ${people.toLocaleString()} people are setting off`, 'good', destination );
					void ( async () => {

						let remaining = people, index = 0;
						while ( remaining > 0 && ! ctx.signal.aborted ) {

							const size = Math.min( remaining, Math.round( 20 + ctx.random() * 25 ) );
							let origin: Sdk.Point | null = null;
							for ( let attempt = 0; attempt < 40 && ! origin; attempt ++ ) {

								const angle = ctx.random() * Math.PI * 2, distance = 300 + 1700 * ctx.random() ** 1.5;
								const candidate: Sdk.Point = [ destination[ 0 ] + Math.cos( angle ) * distance, destination[ 1 ] + Math.sin( angle ) * distance ];
								origin = ctx.spatial.walkable( candidate, 60 );

							}
							origin ??= entries[ Math.floor( ctx.random() * entries.length ) ].position;
							const operation = ctx.spawn.crowd( { id: `rally-${call}-${String( ++ index ).padStart( 2, '0' )}`, label: 'Arrivals',
								at: origin, people: size, groupSize: size, spread: 4, goal: destination, goalRadius: 20, morale: 0.6, resolve: [ 0.7, 1 ] } );
							const outcome = await operation.settled;
							if ( outcome.status !== 'completed' ) break;
							remaining -= size;

						}

					} )().catch( () => {} );

				},
				update( ctx ) {

					if ( ctx.time < nextDirectorAt ) return;
					nextDirectorAt += 5;
					const headcount = ctx.spatial.count( { at: 'square', radius: 60, faction: 'protester' } );
					if ( headcount === null ) return;
					if ( cordonGasRemaining > 0 && ctx.time - lastCordonGasAt > 45 && ctx.resources.get( 'gas' ).available > 0 ) {

						for ( const post of cordons ) {

							const pressure = ctx.spatial.count( { at: post.center, radius: 30, faction: 'protester' } );
							if ( pressure === null || pressure <= 250 ) continue;
							lastCordonGasAt = ctx.time;
							const at: Sdk.Point = [ post.center[ 0 ] + ( ctx.random() * 16 - 8 ), post.center[ 1 ] + ( ctx.random() * 16 - 8 ) ];
							const operation = ctx.commands.execute( 'gas', { at, opinion: { delta: 0, reason: 'AI cordon gas' } } );
							void operation.settled.then( ( outcome ) => {

								if ( outcome.status !== 'completed' ) return;
								cordonGasRemaining --;
								if ( ! ctx.signal.aborted ) ctx.presentation.notice( 'Police fire tear gas at a pressed cordon', 'bad', post.center );

							} ).catch( () => {} );
							break;

						}

					}
					const fraction = headcount / 5000;
					if ( ! clearing && fraction >= 2 / 3 ) {

						clearing = true;
						ctx.presentation.notice( 'Police are beginning to clear the square', 'bad', 'square' );
						for ( const id of [ 'reserve-01', 'reserve-02' ] ) ctx.movement.move( id, 'square', { radius: 20 } );
						reinforce( ctx, fraction ); reinforce( ctx, fraction );

					} else if ( clearing && fraction < 0.5 ) {

						clearing = false;
						ctx.presentation.notice( 'Police stop advancing and hold their lines', 'info', 'square' );

					}
					if ( clearing && ctx.time - lastAdvanceAt >= 15 ) { lastAdvanceAt = ctx.time; advanceLines( ctx ); }
					if ( ! gassing && fraction >= 1 ) { gassing = true; ctx.presentation.notice( 'Police prepare to clear the packed square', 'bad', 'square' ); }
					else if ( gassing && fraction < 0.85 ) gassing = false;
					const square = ctx.locations.get( 'square' ), peopleInSquare = ( ctx.observation?.people ?? [] ).filter( ( person ) => person.faction === 'protester'
						&& person.status === 'active' && Math.hypot( person.position[ 0 ] - square[ 0 ], person.position[ 1 ] - square[ 1 ] ) < 60 );
					if ( gassing && squareGasRemaining > 0 && peopleInSquare.length && ctx.time - lastVolleyAt >= 20 ) {

						lastVolleyAt = ctx.time;
						const shots = [ 0, 1 ].map( () => peopleInSquare[ Math.floor( ctx.random() * peopleInSquare.length ) ].position );
						ctx.presentation.notice( 'Police: tear gas in 5 s', 'warn', shots[ 0 ] );
						ctx.timeline.after( 5, ( volleyCtx ) => {

							const operations = shots.map( ( at ) => volleyCtx.commands.execute( 'gas', { at,
								opinion: { delta: 0.5, reason: 'tear gas on a packed square' } } ) );
							void Promise.all( operations.map( ( operation ) => operation.settled ) ).then( ( outcomes ) => {

								squareGasRemaining -= outcomes.filter( ( outcome ) => outcome.status === 'completed' ).length;

							} ).catch( () => {} );

						} );

					}
					if ( clearing && peopleInSquare.length > 50 && ctx.time - lastChargeAt >= 25 ) {

						const team = reserveIds.filter( ( id ) => ! busyReserves.has( id ) ).map( ( id ) => {

							const handle = ctx.actors.resolve( id );
							return { id, handle, actor: ctx.actors.get( handle ) };

						} ).filter( ( reserve ) => reserve.actor?.center && reserve.actor.alive > 10 ).slice( 0, 2 );
						if ( team.length === 2 ) {

							const origin = team[ 0 ].actor.center;
						let edge = peopleInSquare[ 0 ].position, closest = Infinity;
						for ( const person of peopleInSquare ) {

							const distance = ( person.position[ 0 ] - origin[ 0 ] ) ** 2 + ( person.position[ 1 ] - origin[ 1 ] ) ** 2;
							if ( distance < closest ) { closest = distance; edge = person.position; }

						}
						const dx = square[ 0 ] - edge[ 0 ], dy = square[ 1 ] - edge[ 1 ], distance = Math.hypot( dx, dy ) || 1;
							const step = Math.min( 15, distance ), goal: Sdk.Point = [ edge[ 0 ] + dx / distance * step, edge[ 1 ] + dy / distance * step ];
							lastChargeAt = ctx.time;
							for ( const reserve of team ) busyReserves.add( reserve.id );
							ctx.presentation.notice( 'Police: baton charge in 5 s', 'warn', goal );
							ctx.timeline.after( 5, ( chargeCtx ) => {

								const operation = chargeCtx.commands.execute( 'charge', { at: goal, selection: team.map( ( reserve ) => reserve.handle ) } );
								void operation.settled.then( ( outcome ) => {

									if ( outcome.status !== 'completed' ) { for ( const reserve of team ) busyReserves.delete( reserve.id ); return; }
									chargeCtx.timeline.after( 14, ( returnCtx ) => {

										const returns = team.map( ( reserve ) => returnCtx.movement.move( reserve.handle, edge, { radius: 20 } ) );
										void Promise.all( returns.map( ( movement ) => movement.settled ) ).then( () => {

											for ( const reserve of team ) busyReserves.delete( reserve.id );

										} ).catch( () => {} );

									} );

								} ).catch( () => { for ( const reserve of team ) busyReserves.delete( reserve.id ); } );

							} );

						}

					}
					if ( ctx.time - lastKettleAt > 60 ) {

						const isolated = ( ctx.observation?.actors ?? [] ).filter( ( actor ) => actor.handle.kind === 'crowd' && actor.center
							&& actor.alive > 20 && Math.hypot( actor.center[ 0 ] - square[ 0 ], actor.center[ 1 ] - square[ 1 ] ) > 150
							&& ( ctx.spatial.count( { at: actor.center, radius: 40, faction: 'protester' } ) ?? Infinity ) < 160 );
						const team = isolated.length ? freeReserves( ctx, 2 ) : [];
						if ( team.length === 2 ) {

							const group = isolated[ Math.floor( ctx.random() * isolated.length ) ];
						lastKettleAt = ctx.time;
						for ( const reserve of team ) busyReserves.add( reserve.id );
						ctx.presentation.notice( `Police are kettling ${group.handle.id}`, 'bad', group.center );
						const operation = ctx.commands.execute( 'kettle', { at: group.center, selection: team.map( ( reserve ) => reserve.handle ) } );
						void operation.settled.then( ( outcome ) => {

							if ( outcome.status !== 'completed' ) { for ( const reserve of team ) busyReserves.delete( reserve.id ); return; }
							ctx.timeline.after( 90, ( returnCtx ) => {

								const moves = team.map( ( reserve ) => returnCtx.movement.move( reserve.handle, 'square', { radius: 20 } ) );
								void Promise.all( moves.map( ( move ) => move.settled ) ).then( () => {

									for ( const reserve of team ) busyReserves.delete( reserve.id );

								} ).catch( () => {} );

							} );

						} ).catch( () => { for ( const reserve of team ) busyReserves.delete( reserve.id ); } );

						}

					}
					const leaders = ( ctx.observation?.people ?? [] ).filter( ( person ) => person.faction === 'protester' && person.leader
						&& person.identified && person.status === 'active' && Math.hypot( person.position[ 0 ] - square[ 0 ], person.position[ 1 ] - square[ 1 ] ) < 160 );
					const snatchTeam = leaders.length && ctx.random() < 0.3 ? freeReserves( ctx, 1 ) : [];
					if ( snatchTeam.length ) {

						const reserve = snatchTeam[ 0 ], leader = leaders[ 0 ];
						busyReserves.add( reserve.id );
						ctx.presentation.notice( `Snatch squad going for the leader of ${leader.actor.id}`, 'warn', leader.position );
						const operation = ctx.commands.execute( 'snatch', { at: leader.position, selection: [ reserve.handle ] } );
						snatchReserves.set( operation.id, reserve.id );
						void operation.settled.then( ( outcome ) => {

							if ( outcome.status !== 'completed' ) { snatchReserves.delete( operation.id ); busyReserves.delete( reserve.id ); }

						} ).catch( () => { snatchReserves.delete( operation.id ); busyReserves.delete( reserve.id ); } );

					}
					const reinforcementInterval = fraction >= 2 / 3 ? 40 : fraction >= 1 / 3 ? 60 : 90;
					if ( ctx.time - lastReinforcementAt >= reinforcementInterval && reinforcementSquads < 30 ) {

						lastReinforcementAt = ctx.time;
						reinforce( ctx, fraction );

					}

				},
				onEvent( ctx, event ) {

					if ( event.type === 'command.applied' && event.command === 'rally-call' ) { this.onAction( ctx, { type: 'key', key: 'r', at: event.at } ); return; }
					if ( event.type !== 'snatch.completed' && event.type !== 'snatch.abandoned' && event.type !== 'snatch.cancelled' ) return;
					const reserve = snatchReserves.get( event.operation );
					if ( reserve ) { snatchReserves.delete( event.operation ); busyReserves.delete( reserve ); }

				},
			};

		},
	} );

	return defineScenario( {
		id: 'rally-rules', menu: false, side: 'protest', title: 'Rally Preview', subtitle: 'Hold the square',
		brief: 'Coordinate the protest. Bring 5,000 people onto Trg republike and hold the square for three minutes. Rally calls bring more people in from across town.',
		goals: [ 'Get 5,000 protesters onto Trg republike', 'Hold the square for 3:00 in total', 'Keep the protest alive' ],
		tips: [ 'Select a group and right-click to move it', 'Rally call (R) brings 200 to 1,100 people toward the square; calls recharge after 30 seconds' ],
		resources: { gas: { capacity: 46 }, rally: { capacity: 99, cooldown: 30 } }, commands: [ ...policeCommands( { gas: 'gas' } ), ...protestCommands(), scenarioCommand( { id: 'rally-call', key: 'r', label: 'Rally call', resource: 'rally', side: 'protest' } ) ],
		locations: { square: place( 'Trg republike' ), preseren: place( 'Prešernov trg' ), kongresni: place( 'Kongresni trg' ),
			metelkova: place( 'Metelkova' ), tivoli: place( 'Park Tivoli' ), railway: landmark( 'Železniška postaja' ),
			station: landmark( 'PU Ljubljana' ), 'police-center': landmark( 'PP Ljubljana Center' ), mestni: place( 'Mestni trg' ), dragon: place( 'Zmajski most' ) },
		setup( ctx ) {

			ctx.presentation.focus( 'square', 0.95 );
			for ( const group of STARTING_GROUPS ) ctx.spawn.crowd( group );
			const square = ctx.locations.get( 'square' );
			for ( const post of approaches( ctx ) ) {

				for ( const side of [ 1, 2 ] ) {

					ctx.spawn.squad( { id: `cordon-${post.id}-${side}`, at: post.center, people: 24 } );

				}
				const dx = post.center[ 0 ] - square[ 0 ], dy = post.center[ 1 ] - square[ 1 ];
				const distance = Math.hypot( dx, dy ) || 1, at: Sdk.Point = [ post.center[ 0 ] - dx / distance * 12, post.center[ 1 ] - dy / distance * 12 ];
				ctx.spawn.vehicle( { id: `police-car-${post.id}`, label: 'Police car', type: 'police-patrol', crew: 0, selectable: false, at } );

			}
			const offset: Sdk.Point = [ square[ 0 ] + 10, square[ 1 ] ];
			const reserves: ( string | Sdk.Point )[] = [ 'station', 'station', 'police-center', 'police-center', 'square', offset ];
			for ( const [ index, at ] of reserves.entries() ) {

				ctx.spawn.squad( { id: `reserve-${String( index + 1 ).padStart( 2, '0' )}`, at, people: 26 } );

			}
			ctx.spawn.bystanders( { id: 'onlookers', people: 2000,
				destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

		},
		behaviors: [ director( { id: 'rally-director' } ) ],
		objectives: [ holdCrowd( { id: 'hold-square', at: 'square', radius: 60, minimumPeople: 5000, holdSeconds: 180, timeoutSeconds: 1200,
			minimumAlive: 500, minimumAliveAfter: 60, label: 'Square held', reason: 'Trg republike belongs to the people tonight.',
			populationFailureReason: 'The protest fizzled out.', timeoutReason: 'The night is over — the square was never held long enough.' } ) ],
		opinion: { initial: 50, weights: { injuriesByPolice: 0.4, officersInjured: - 0.6, arrests: 0.05, sitterArrests: 0.1, otherInjuries: - 0.1 } },
		score: ( { win, time, metrics } ) => {

			const stars = Number( win ) + Number( win && time <= 720 ) + Number( win && metrics.counters.officersInjured <= 10 );
			return { stars, lines: [ [ 'Time', formatTime( time ) ], [ 'Public sympathy', Math.round( metrics.opinion ) ],
				[ 'Protesters injured', metrics.counters.injuriesByPolice ], [ 'Officers injured', metrics.counters.officersInjured ],
				[ 'Arrested', metrics.counters.arrests ], [ 'Went home', metrics.counters.peopleGone ] ] };

		},
	} );

};