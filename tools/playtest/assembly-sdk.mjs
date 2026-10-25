import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const base = process.env.ASSEMBLY_SDK_BASE ?? 'http://127.0.0.1:5197';
const limit = Number( process.env.ASSEMBLY_SDK_SECONDS ?? 725 );
const seed = Number( process.env.ASSEMBLY_SDK_SEED ?? 42 );
const tactic = process.env.ASSEMBLY_SDK_TACTIC ?? 'lines';
const artifactDir = process.env.ASSEMBLY_SDK_ARTIFACTS ?? '/tmp/assembly-sdk-acceptance';
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
	?? ( process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null );
assert.ok( executablePath, 'Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium executable' );
assert.ok( Number.isFinite( limit ) && limit > 0 && limit <= 725 );
assert.ok( Number.isInteger( seed ) && seed >= 0 && seed <= 0xffffffff );
assert.ok( [ 'lines', 'arrest', 'snatch' ].includes( tactic ) );
mkdirSync( artifactDir, { recursive: true } );

function acceptanceFactory( sdk ) {

	const source = assemblyFactory( sdk );
	const closeDefense = new URLSearchParams( location.search ).get( 'tactic' ) !== 'lines';
	const useSnatch = new URLSearchParams( location.search ).get( 'tactic' ) === 'snatch';
	const driver = sdk.defineBehavior( { id: 'assembly-acceptance', create() {

		const receipts = [], actions = [], seen = {}, pending = new Set();
		let context, geometry, edges, lastGas = - 99, lastWater = - 99, lastReinforce = - 99, lastCharge = - 99;
		let pressure = { breach: 0, evacuation: 0 };
		const reserves = new Set( [ 'guard-7', 'guard-8', 'guard-9' ] );
		const exitTeam = new Set();
		const snatchTeam = new Set( useSnatch ? [ 'guard-10', 'guard-11' ] : [] ), pursuing = new Set(), targeted = new Set();
		const record = ( name, operation ) => {

			pending.add( operation );
			void operation.settled.then( ( outcome ) => {

				pending.delete( operation ); receipts.push( { name, time: context.time, status: outcome.status,
					code: outcome.code, error: outcome.error?.message } );
				if ( name === 'reinforce' && outcome.status === 'completed' && outcome.value.actor ) {

					if ( closeDefense ) { exitTeam.add( outcome.value.actor.id ); command( 'arrest', geometry.exits[ 0 ], [ outcome.value.actor ] ); }
					else reserves.add( outcome.value.actor.id );

				}

			} );
			return operation.settled;

		};
		const command = ( id, at, selection = [] ) => record( id, context.commands.execute( id, { at, selection } ) );
		return {
			start( ctx ) {

				context = ctx; geometry = ctx.spatial.buildingGeometry( 'assembly', { 1: [ - 404, - 55 ] } );
				const outer = geometry.footprints[ 0 ]; edges = [];
				for ( let index = 0; index < outer.length; index += 2 ) {

					const start = [ outer[ index ], outer[ index + 1 ] ], end = [ outer[ ( index + 2 ) % outer.length ], outer[ ( index + 3 ) % outer.length ] ];
					const length = Math.hypot( end[ 0 ] - start[ 0 ], end[ 1 ] - start[ 1 ] );
					const middle = [ ( start[ 0 ] + end[ 0 ] ) / 2, ( start[ 1 ] + end[ 1 ] ) / 2 ];
					const distance = Math.hypot( middle[ 0 ] - geometry.position[ 0 ], middle[ 1 ] - geometry.position[ 1 ] ) || 1;
					const normal = [ ( middle[ 0 ] - geometry.position[ 0 ] ) / distance, ( middle[ 1 ] - geometry.position[ 1 ] ) / distance ];
					const tangent = [ ( end[ 0 ] - start[ 0 ] ) / length, ( end[ 1 ] - start[ 1 ] ) / length ];
					edges.push( { length, start: start.map( ( value, axis ) => value + normal[ axis ] * 8 - tangent[ axis ] * 6 ),
						end: end.map( ( value, axis ) => value + normal[ axis ] * 8 + tangent[ axis ] * 6 ),
						target: middle.map( ( value, axis ) => value + normal[ axis ] * 5 ) } );

				}
				edges.sort( ( first, second ) => second.length - first.length ); edges = edges.slice( 0, 4 );
				globalThis.__assemblyAcceptance = Object.freeze( {
					geometry: () => ( { ...geometry, edges } ),
					inspect: () => ( { time: ctx.time, seen: { ...seen }, receipts: [ ...receipts ], actions: [ ...actions ], pending: pending.size, pressure,
						building: ctx.spatial.building( 'assembly', { 1: [ - 404, - 55 ] } ),
						vehicles: [ 'patrol-1', 'patrol-2', 'water-cannon' ].map( ( id ) => ctx.vehicles.get( id ) ) } ),
					deploy: async () => {

						const reserved = new Set( actions.flatMap( ( action ) => action.selection ) );
						const guards = Array.from( { length: 12 }, ( _, index ) => `guard-${index + 1}` ).filter( ( id, index ) => ! reserved.has( id ) && ( index < 6 || index > 8 ) );
						const orders = [];
						if ( closeDefense ) {

							if ( exitTeam.size ) orders.push( command( 'arrest', geometry.exits[ 0 ], [ ...exitTeam ].map( ( id ) => ctx.actors.resolve( id ) ) ) );
							for ( const [ index, edge ] of edges.entries() ) {

								const selection = Array.from( { length: 12 }, ( _, guard ) => `guard-${guard + 1}` )
									.filter( ( id, guard ) => ! reserved.has( id ) && ! exitTeam.has( id ) && ! snatchTeam.has( id ) && guard % edges.length === index ).map( ( id ) => ctx.actors.resolve( id ) );
								if ( selection.length ) orders.push( command( 'arrest', edge.target, selection ) );

							}
							return Promise.all( orders );

						}
						for ( const [ index, edge ] of edges.entries() ) {

							const assigned = guards.filter( ( _, guardIndex ) => guardIndex % edges.length === index );
							for ( const [ part, id ] of assigned.entries() ) {

								const from = edge.start.map( ( value, axis ) => value + ( edge.end[ axis ] - value ) * part / assigned.length );
								const to = edge.start.map( ( value, axis ) => value + ( edge.end[ axis ] - value ) * ( part + 1 ) / assigned.length );
								orders.push( record( 'deploy:' + id, ctx.movement.move( ctx.actors.resolve( id ), to, { line: from } ) ) );

							}

						}
						return Promise.all( orders );

					},
					crew: () => command( 'crew', ctx.vehicles.get( 'patrol-1' ).position, [ ctx.actors.resolve( 'patrol-1' ) ] ),
					drive: () => {

						const vehicle = ctx.vehicles.get( 'patrol-1' );
						const at = ctx.spatial.walkable( [ geometry.exits[ 1 ][ 0 ] + 24, geometry.exits[ 1 ][ 1 ] ], 30 );
						const result = ctx.vehicles.drive( vehicle.handle, at, { expectedRevision: vehicle.revision } );
						receipts.push( { name: 'patrol-drive', status: result.status, code: result.code, time: ctx.time } ); return result;

					},
					respond: async () => {

						if ( closeDefense ) for ( const id of snatchTeam ) {

							if ( pursuing.has( id ) ) continue;
							const squad = ctx.actors.resolve( id ), center = ctx.actors.get( squad )?.center;
							if ( ! center ) continue;
							const leader = ( ctx.observation?.people ?? [] ).filter( ( person ) => person.faction === 'protester' && person.status === 'active' && person.leader && person.identified && ! targeted.has( person.handle.id ) )
								.sort( ( first, second ) => Math.hypot( first.position[ 0 ] - center[ 0 ], first.position[ 1 ] - center[ 1 ] ) - Math.hypot( second.position[ 0 ] - center[ 0 ], second.position[ 1 ] - center[ 1 ] ) )[ 0 ];
							if ( ! leader ) continue;
							pursuing.add( id ); targeted.add( leader.handle.id );
							void command( 'snatch', leader.position, [ squad ] ).then( ( outcome ) => { if ( outcome.status !== 'completed' ) pursuing.delete( id ); } );

						}
						const candidates = [ ...edges.map( ( edge ) => edge.target ), ...geometry.exits ];
						const buckets = new Map();
						for ( const person of ctx.observation?.people ?? [] ) {

							if ( person.status !== 'active' || person.faction !== 'protester' || person.agitation < 0.4 ) continue;
							const nearFacade = geometry.footprints.some( ( ring ) => {

								for ( let offset = 0; offset < ring.length; offset += 2 ) {

									const startX = ring[ offset ], startY = ring[ offset + 1 ], endX = ring[ ( offset + 2 ) % ring.length ], endY = ring[ ( offset + 3 ) % ring.length ];
									const deltaX = endX - startX, deltaY = endY - startY;
									const fraction = Math.max( 0, Math.min( 1, ( ( person.position[ 0 ] - startX ) * deltaX + ( person.position[ 1 ] - startY ) * deltaY ) / ( deltaX ** 2 + deltaY ** 2 || 1 ) ) );
									if ( Math.hypot( person.position[ 0 ] - startX - deltaX * fraction, person.position[ 1 ] - startY - deltaY * fraction ) < 3 ) return true;

								}
								return false;

							} );
							if ( nearFacade ) buckets.set( Math.round( person.position[ 0 ] / 8 ) + ':' + Math.round( person.position[ 1 ] / 8 ), person.position );

						}
						if ( buckets.size ) candidates.splice( 0, candidates.length, ...buckets.values() );
						let hottest = candidates.map( ( at ) => ( { at, people: ctx.spatial.count( { at, radius: 15, faction: 'protester', minimumAgitation: 0.4 } ) ?? 0 } ) )
							.sort( ( first, second ) => second.people - first.people )[ 0 ];
						const building = ctx.spatial.building( 'assembly', { 1: [ - 404, - 55 ] } );
						if ( ! building ) return;
						const evacuationDanger = closeDefense && pressure.evacuation > 0.15;
						if ( evacuationDanger ) hottest = { at: geometry.exits[ 0 ], people: building.exits[ 0 ] };
						const gas = ctx.resources.get( 'gas' ).available;
						if ( ( pressure.breach > 0.35 || evacuationDanger ) && ctx.time - lastGas > 20 && gas && ( ! closeDefense || gas > 1 || evacuationDanger ) ) {

							lastGas = ctx.time; command( 'gas', hottest.at );

						}
						const truck = ctx.vehicles.get( 'water-cannon' );
						const distance = Math.hypot( truck.position[ 0 ] - hottest.at[ 0 ], truck.position[ 1 ] - hottest.at[ 1 ] );
						if ( hottest.people > 10 && distance > 24 && ! truck.moving ) {

							const at = ctx.spatial.walkable( hottest.at, 30 );
							if ( at ) ctx.vehicles.drive( truck.handle, at, { expectedRevision: truck.revision } );

						}
						const water = ctx.resources.get( 'water' ).available;
						if ( ( pressure.breach > 0.45 || evacuationDanger ) && distance < 28 && truck.speed < 0.5 && ctx.time - lastWater > 15 && water && ( ! closeDefense || water > 2 || evacuationDanger ) ) {

							lastWater = ctx.time; command( 'water', hottest.at, [ ctx.actors.resolve( 'water-cannon' ) ] );

						}
						if ( building.facade > 20 && ctx.time - lastCharge > 15 ) {

							lastCharge = ctx.time;
							const reserved = new Set( actions.flatMap( ( action ) => action.selection ) );
							const ids = closeDefense ? [ ...Array.from( { length: 12 }, ( _, index ) => `guard-${index + 1}` ).filter( ( id ) => ! reserved.has( id ) && ! exitTeam.has( id ) && ! snatchTeam.has( id ) ), ...[ ...reserves ].filter( ( id ) => id.startsWith( 'reinforcement-' ) ) ] : [ ...reserves ];
							const selection = ids.map( ( id ) => ctx.actors.resolve( id ) ).filter( ( handle ) => ( ctx.actors.get( handle )?.alive ?? 0 ) > 5 );
							if ( selection.length && closeDefense ) {

								const hotspots = [];
								for ( const candidate of candidates.map( ( at ) => ( { at, count: ctx.spatial.count( { at, radius: 6, faction: 'protester', minimumAgitation: 0.4 } ) ?? 0 } ) ).sort( ( first, second ) => second.count - first.count ) ) {

									if ( hotspots.every( ( other ) => Math.hypot( other.at[ 0 ] - candidate.at[ 0 ], other.at[ 1 ] - candidate.at[ 1 ] ) > 12 ) ) hotspots.push( candidate );
									if ( hotspots.length === 4 ) break;

								}
								const available = [ ...selection ];
								for ( const [ index, hotspot ] of hotspots.entries() ) {

									available.sort( ( first, second ) => {

										const a = ctx.actors.get( first )?.center ?? geometry.position, b = ctx.actors.get( second )?.center ?? geometry.position;
										return Math.hypot( a[ 0 ] - hotspot.at[ 0 ], a[ 1 ] - hotspot.at[ 1 ] ) - Math.hypot( b[ 0 ] - hotspot.at[ 0 ], b[ 1 ] - hotspot.at[ 1 ] );

									} );
									const team = available.splice( 0, Math.ceil( available.length / ( hotspots.length - index ) ) );
									if ( team.length ) await command( 'arrest', hotspot.at, team );

								}

							} else if ( selection.length ) command( 'charge', hottest.at, selection );

						}
						if ( ( hottest.people > 120 || ctx.time >= 90 && lastReinforce < 0 ) && ctx.time - lastReinforce > 60 && ctx.resources.get( 'reinforce' ).available ) {

							lastReinforce = ctx.time; command( 'reinforce', hottest.at );

						}

					},
				} );

			},
			observe( ctx, sample ) {

				const counts = {};
				for ( const actor of sample.actors ) for ( const id of [ 'students', 'metelkova', 'cyclists', 'radicals', 'unions', 'late' ] ) {

					if ( actor.handle.id.startsWith( id + '-' ) ) counts[ id ] = ( counts[ id ] ?? 0 ) + ctx.people.members( actor.handle ).length;

				}
				for ( const [ id, count ] of Object.entries( counts ) ) seen[ id ] = Math.max( seen[ id ] ?? 0, count );

			},
			onAction( ctx, action ) { actions.push( { time: ctx.time, type: action.type, selection: action.selection.map( ( actor ) => actor.id ), command: action.command } ); },
			onEvent( ctx, event ) {

				if ( [ 'snatch.completed', 'snatch.abandoned', 'snatch.cancelled' ].includes( event.type ) ) pursuing.delete( event.squad.id );
				if ( event.type === 'building.pressure' ) pressure = event.current;
				if ( [ 'command.applied', 'vehicle.arrived', 'vehicle.crew-changed' ].includes( event.type ) ) receipts.push( {
					name: event.type, command: event.command, status: 'observed', time: ctx.time } );

			},
		};

	} } );
	const { kind, sdkVersion, ...options } = source;
	return sdk.defineScenario( { ...options, seed: Number( new URLSearchParams( location.search ).get( 'seed' ) ?? 42 ), behaviors: [ ...source.behaviors, driver( { id: 'acceptance' } ) ] } );

}

const browser = await puppeteer.launch( { executablePath, headless: true, protocolTimeout: 90000,
	args: [ '--enable-unsafe-webgpu', ...( process.platform === 'darwin' ? [ '--use-angle=metal' ] : [] ) ] } );
const page = await browser.newPage();
const report = { mode: limit < 720 ? 'smoke' : 'acceptance', seed, tactic, passed: false, errors: [], progress: [], startedAt: new Date().toISOString() };
page.on( 'pageerror', ( error ) => report.errors.push( error.message ) );
page.on( 'console', ( message ) => { if ( message.type() === 'error' && /pool exhausted|Frame failed|Scenario .*:/i.test( message.text() ) ) report.errors.push( message.text() ); } );
try {

	await page.setViewport( { width: 1400, height: 900 } );
	await page.setRequestInterception( true );
	page.on( 'request', ( request ) => {

		if ( new URL( request.url() ).pathname === '/__playtest/assembly-sdk.js' ) void request.respond( { status: 200, contentType: 'text/javascript; charset=utf-8',
			body: 'import assemblyFactory from "/examples/defense-scenario.ts"; export const sdkVersion = 1; export default ' + acceptanceFactory.toString() } );
		else void request.continue();

	} );
	const url = new URL( '/', base ); url.searchParams.set( 'm', 'assembly-rules' ); url.searchParams.set( 'plugin', '/__playtest/assembly-sdk.js' );
	url.searchParams.set( 'seed', String( seed ) );
	url.searchParams.set( 'tactic', tactic );
	await page.goto( url.href, { waitUntil: 'domcontentloaded', timeout: 90000 } );
	await page.waitForFunction( () => document.querySelector( '#bStart' ) || document.querySelector( '.plugin-warn' )
		|| document.querySelector( '#boot.err' ) || document.body.textContent.includes( 'Plugin not loaded:' ), { timeout: 90000, polling: 100 } );
	const bootError = await page.evaluate( () => document.querySelector( '#boot.err' )?.textContent
		?? document.body.textContent.match( /Plugin not loaded:[^\n]+/ )?.[ 0 ] );
	assert.ok( ! bootError, bootError );
	await page.waitForSelector( '#bStart', { timeout: 90000 } ); await page.click( '#bStart' );
	await page.waitForFunction( () => window.scenarioPlaytest && window.__assemblyAcceptance, { timeout: 60000, polling: 100 } );
	await page.evaluate( () => scenarioPlaytest.pause() );
	let state = await page.evaluate( () => scenarioPlaytest.advance( 2 ) );
	const geometry = await page.evaluate( () => __assemblyAcceptance.geometry() );
	await page.evaluate( ( at ) => scenarioPlaytest.frame( at, 0.8 ), geometry.position );
	for ( let attempt = 0; attempt < 15; attempt ++ ) {

		await page.keyboard.press( 'Tab' );
		const selected = await page.evaluate( () => __assemblyAcceptance.inspect().actions.at( - 1 )?.selection ?? [] );
		if ( selected.some( ( id ) => id.startsWith( 'guard-' ) ) ) break;

	}
	const selected = await page.evaluate( () => __assemblyAcceptance.inspect().actions.at( - 1 )?.selection ?? [] );
	assert.ok( selected.some( ( id ) => id.startsWith( 'guard-' ) ), 'Real Tab input did not select a guard' );
	const line = geometry.edges[ 0 ];
	const screen = await page.evaluate( ( edge ) => ( { start: scenarioPlaytest.project( edge.start ), end: scenarioPlaytest.project( edge.end ) } ), line );
	await page.mouse.move( ...screen.start ); await page.mouse.down( { button: 'right' } ); await page.mouse.move( ...screen.end, { steps: 8 } ); await page.mouse.up( { button: 'right' } );
	await page.waitForFunction( () => __assemblyAcceptance.inspect().actions.some( ( action ) => action.type === 'line' ), { timeout: 10000, polling: 100 } );
	await page.evaluate( () => __assemblyAcceptance.deploy() );
	await page.evaluate( () => __assemblyAcceptance.crew() );
	await page.evaluate( () => __assemblyAcceptance.drive() );
	const started = Date.now();
	while ( state.time < limit && ! state.result ) {

		assert.ok( Date.now() - started < 15 * 60 * 1000, 'Acceptance wall-clock limit reached' );
		await page.evaluate( () => __assemblyAcceptance.respond() );
		const nextWave = [ 8, 120, 190, 250, 400, 560 ].find( ( time ) => time > state.time + 0.001 );
		const chunk = Math.min( state.objectives[ 1 ].value > 0.1 ? 2 : 10, nextWave ? nextWave - state.time + 1 / 30 : 10 );
		state = await page.evaluate( ( seconds ) => scenarioPlaytest.advance( seconds ), chunk );
		const strategy = await page.evaluate( () => __assemblyAcceptance.inspect() );
		report.progress.push( { ...state, strategy } );
		console.log( JSON.stringify( { time: Math.round( state.time ), state: state.state, pressure: strategy.building,
			fields: state.navigation.referenced, pending: state.pendingOperations, seen: strategy.seen, result: state.result } ) );
		assert.notEqual( state.state, 'failed', state.error ); assert.equal( report.errors.length, 0, report.errors.join( '\n' ) );
		assert.ok( state.navigation.pending <= state.navigation.capacity );
		assert.ok( state.sampleAge !== null && state.sampleAge <= 2.1, 'Population observations became stale' );
	}
	report.final = state; report.strategy = await page.evaluate( () => __assemblyAcceptance.inspect() );
	if ( limit < 720 ) report.passed = ! state.error && report.errors.length === 0;
	else {

		assert.ok( state.result, 'No terminal mission result' ); assert.equal( state.result.win, true, state.result.reason );
		assert.deepEqual( report.strategy.seen, { students: 2200, metelkova: 1800, cyclists: 450, radicals: 1100, unions: 2600, late: 1500 } );
		for ( const name of [ 'crew', 'patrol-drive', 'water', 'reinforce' ] ) assert.ok( report.strategy.receipts.some( ( receipt ) => receipt.name === name && receipt.status === 'completed' ), 'Missing workflow: ' + name );
		assert.ok( state.result.lines.length >= 5 ); report.passed = true;

	}

} catch ( error ) {

	report.diagnostics = await page.evaluate( () => window.scenarioPlaytest?.snapshot() ).catch( () => null );
	report.failure = error.stack; console.error( error.stack ); process.exitCode = 1;

} finally {

	report.final ??= report.progress.at( - 1 );
	report.endedAt = new Date().toISOString();
	if ( report.final?.result ) {

		await page.waitForFunction( () => [ ...document.querySelectorAll( '.card h1' ) ].some( ( heading ) => /Mission complete|Mission failed/.test( heading.textContent ) ),
			{ timeout: 10000, polling: 100 } ).catch( ( error ) => { report.artifactError = error.message; } );
		report.resultRows = await page.$$eval( '.card table tr', ( rows ) => rows.map( ( row ) => row.textContent.trim() ) ).catch( () => [] );

	}
	await page.screenshot( { path: artifactDir + '/final.png' } ).catch( () => {} );
	writeFileSync( artifactDir + '/report.json', JSON.stringify( report, null, 2 ) + '\n' );
	console.log( 'ASSEMBLY_ACCEPTANCE', JSON.stringify( { mode: report.mode, passed: report.passed, failure: report.failure, artifacts: artifactDir } ) );
	await browser.close();

}
