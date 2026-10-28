import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.env.RESCUE_PARITY_BASE ?? 'http://127.0.0.1:5197';
const seed = Number( process.env.RESCUE_PARITY_SEED ?? 42 );
const maxSeconds = Number( process.env.RESCUE_PARITY_SECONDS ?? 900 );
const artifact = process.env.RESCUE_PARITY_REPORT ?? `/tmp/rescue-parity-${seed}.json`;
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
	?? ( process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null );
if ( ! executablePath ) throw new Error( 'Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium executable' );
if ( ! Number.isInteger( seed ) || seed < 0 || seed > 0xffffffff ) throw new Error( 'RESCUE_PARITY_SEED must be an unsigned 32-bit integer' );
if ( ! Number.isFinite( maxSeconds ) || maxSeconds <= 0 || maxSeconds > 900 ) throw new Error( 'RESCUE_PARITY_SECONDS must be between 0 and 900' );

const CHECKPOINTS = [ 0, 5, 30, 60, 75, 90, 120, 150, 180, 210, 240, 270, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900 ].filter( ( time ) => time <= maxSeconds );
const ACTIONS = [ { at: 5, id: 'shield-stewards' }, { at: 90, id: 'screen-stewards' }, { at: 120, id: 'assault-at-stand' } ];
const wait = ( milliseconds ) => new Promise( ( resolve ) => setTimeout( resolve, milliseconds ) );

function urlFor( mode ) {

	const url = new URL( base );
	url.search = '';
	url.searchParams.set( 'seed', String( seed ) );
	if ( mode === 'native' ) url.searchParams.set( 'm', 'rescue' );
	else {

		url.searchParams.set( 'plugin', '/__rescue-parity-plugin.js' );
		url.searchParams.set( 'm', 'rescue-rules' );

	}
	return url.href;

}

async function launchPage( browser, mode, errors ) {

	const page = await browser.newPage();
	await page.evaluateOnNewDocument( ( initialSeed ) => {

		let state = initialSeed >>> 0 || 0x6d2b79f5;
		const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
		Math.random = () => next() / 0x100000000;
		try {

			const cryptoObject = globalThis.crypto, native = cryptoObject.getRandomValues.bind( cryptoObject );
			Object.defineProperty( cryptoObject, 'getRandomValues', { configurable: true, value( values ) {

				if ( values instanceof Uint32Array ) { for ( let index = 0; index < values.length; index ++ ) values[ index ] = next(); return values; }
				return native( values );

			} } );

		} catch {}

	}, seed );
	page.on( 'pageerror', ( error ) => errors.push( `${mode}: ${error.message}` ) );
	page.on( 'console', ( message ) => {

		if ( message.type() === 'error' && /pool exhausted|Frame failed|Scenario .*:/i.test( message.text() ) ) errors.push( `${mode}: ${message.text()}` );

	} );
	if ( mode === 'sdk' ) {

		await page.setRequestInterception( true );
		page.on( 'request', ( request ) => {

			if ( new URL( request.url() ).pathname === '/__rescue-parity-plugin.js' ) {

				const source = `import rescue from '/examples/rescue-scenario.ts';\nimport * as sdk from '/src/game/scenarios/index.ts';\nexport const sdkVersion = 1;\nexport default (builders) => { const define = builders.defineScenario; const seed = Number(new URLSearchParams(location.search).get('seed') || ${seed}); return rescue({...builders, defineScenario: (options) => define({...options, seed})}); };`;
				void request.respond( { status: 200, contentType: 'text/javascript; charset=utf-8', body: source } );

			} else void request.continue();

		} );

	}
	await page.setViewport( { width: 1400, height: 900 } );
	await page.goto( urlFor( mode ), { waitUntil: 'domcontentloaded', timeout: 120000 } );
	await page.waitForSelector( '#bStart', { timeout: 120000 } );
	await page.evaluate( ( { mode, seed } ) => {

		const mission = game.mission; window.__rescueParityEvents = [];
		if ( mode === 'native' ) {

			const arrest = mission.world.arrest.bind( mission.world );
			mission.world.arrest = ( groups, x, y, radius, aim, options ) => {

				window.__rescueParityEvents.push( { time: mission.t, type: 'native.arrest', selection: groups.map( ( group ) => group.label ), at: [ x, y ], radius, aim } );
				return arrest( groups, x, y, radius, aim, options );

			};
			const event = mission.event.bind( mission );
			mission.event = ( text, kind, at ) => { window.__rescueParityEvents.push( { time: mission.t, text, kind } ); return event( text, kind, at ); };

		} else {

			const runtime = mission.runtime;
			const event = runtime.event.bind( runtime );
			runtime.event = ( type, payload ) => { window.__rescueParityEvents.push( { time: runtime.time, type, payload } ); return event( type, payload ); };
			const prepare = runtime.adapter.prepareCommand.bind( runtime.adapter );
			runtime.adapter.prepareCommand = ( request, selected, signal ) => {

				if ( request.id === 'arrest' ) window.__rescueParityEvents.push( { time: runtime.time, type: 'sdk.arrest', selection: request.selection.map( ( actor ) => actor.id ), at: request.at, radius: request.radius, aim: request.aim } );
				return prepare( request, selected, signal );

			};

		}
		document.querySelector( '#bStart' ).click();

	}, { mode, seed } );
	await page.waitForFunction( ( mode ) => mode === 'native'
		? Boolean( window.game?.mission?.world?.intel )
		: [ 'running', 'paused' ].includes( window.game?.mission?.runtime?.state )
			&& window.game?.mission?.runtime?.definition?.id === 'rescue-rules'
			&& window.game?.mission?.runtime?.identity?.entities?.has( 'speaker-person' )
			&& Boolean( window.game?.mission?.runtime?.observation ), { timeout: 120000 }, mode );
	return page;

}

async function snapshot( page, mode ) {

	return await page.evaluate( ( mode ) => {

		const mission = game.mission, flow = game.world.flow;
		const navigation = { pending: flow.pending.size, queued: flow.queue.length, allocated: flow.slots.filter( Boolean ).length };
		if ( mode === 'native' ) {

			const speaker = mission.sp, result = mission.result, intel = mission.world.intel;
			const policeGroups = mission.world.groupsOf( 1 ).map( ( group ) => ( { id: group.id, label: group.label, kind: group.kind, center: group.center,
				chasing: Boolean( group.chasing ), alive: group.alive } ) );
			const policeNear = mission.world.groupsOf( 1 ).map( ( group ) => ( { id: group.id,
				count: group.members.filter( ( member ) => intel.st[ member * 4 ] === 1
					&& Math.hypot( intel.pos[ member * 2 ] - speaker.pos[ 0 ], intel.pos[ member * 2 + 1 ] - speaker.pos[ 1 ] ) < 15 ).length } ) ).filter( ( group ) => group.count );
			return { time: mission.t, state: result ? 'finished' : 'running', phase: mission.phase(),
				speaker: { state: speaker.taken ? 'captured' : speaker.aboard ? 'aboard' : speaker.down ? 'down' : speaker.carried ? 'carried' : 'active', position: speaker.pos, progress: speaker.s },
				policeNear, policeGroups,
				car: { position: [ mission.car.x, mission.car.y ], moving: Boolean( mission.car.path ), speed: mission.car.speed },
				metrics: { opinion: mission.opinion, counters: { injuriesByPolice: mission.counters.injByPolice, otherInjuries: mission.counters.injOther,
					officersInjured: mission.counters.injPolice, arrests: mission.counters.arrested, treatedByMedics: mission.counters.treated ?? 0, gasUsed: mission.ai.gasUsed } },
				objectives: mission.objectives().map( ( row ) => ( { label: row.label, value: row.value, text: row.text, state: row.state, invert: row.invert ?? false } ) ),
				result, navigation, events: window.__rescueParityEvents.splice( 0 ) };

		}
		const runtime = mission.runtime, identity = runtime.identity.entities.get( 'speaker-person' );
		if ( ! identity ) throw new Error( `Rescue parity snapshot has no speaker identity (state=${runtime.state}, error=${runtime.error?.message ?? 'none'}, identities=${[ ...runtime.identity.entities.keys() ].join( ',' )})` );
		const speaker = runtime.context.protected.get( identity.handle );
		const car = runtime.context.vehicles.get( 'rescue-car' );
		const policeGroups = [ ...runtime.actors.values() ].filter( ( actor ) => actor.handle.kind === 'squad' )
			.map( ( actor ) => ( { id: actor.handle.id, center: runtime.context.actors.get( actor.handle )?.center,
				alive: runtime.context.actors.get( actor.handle )?.alive } ) );
		const policeNear = [ ...runtime.actors.values() ].filter( ( actor ) => actor.handle.kind === 'squad' )
			.map( ( actor ) => ( { id: actor.handle.id, count: runtime.identity.members( actor.handle ).filter( ( person ) => person.status === 'active' && person.faction === 'police'
				&& Math.hypot( person.position[ 0 ] - speaker.position[ 0 ], person.position[ 1 ] - speaker.position[ 1 ] ) < 15 ).length } ) ).filter( ( actor ) => actor.count );
		return { time: runtime.time, state: runtime.state, phase: runtime.phase(),
			speaker: { state: speaker.state, position: speaker.position, progress: null },
			policeNear, policeGroups, navigation,
			car: { position: car.position, moving: car.moving, speed: car.speed }, metrics: runtime.metrics(),
			objectives: runtime.objectives(), result: runtime.result, events: window.__rescueParityEvents.splice( 0 ) };

	}, mode );

}

async function advance( page, mode, seconds ) {

	return await page.evaluate( async ( { mode, seconds } ) => mode === 'native'
		? game.advance( seconds ) : window.scenarioPlaytest.advance( seconds ), { mode, seconds } );

}

async function action( page, mode, id ) {

	return await page.evaluate( async ( { mode, id } ) => {

		const mission = game.mission;
		const nearest = ( center, candidates ) => candidates.filter( ( entry ) => entry.center )
			.map( ( entry ) => ( { ...entry, distance: Math.hypot( entry.center[ 0 ] - center[ 0 ], entry.center[ 1 ] - center[ 1 ] ) } ) )
			.sort( ( first, second ) => first.distance - second.distance || first.id.localeCompare( second.id ) )[ 0] ?? null;
		if ( mode === 'native' ) {

			const world = mission.world;
			if ( id === 'shield-stewards' ) {

				const groups = world.groups.filter( ( group ) => group.kind === 'stewards' && group.alive > 0 );
				if ( ! groups.length ) return { status: 'no-target' };
				mission.shieldWall( groups ); return { status: 'applied', people: groups.reduce( ( count, group ) => count + group.alive, 0 ) };

			}
			if ( id === 'screen-stewards' ) {

				const groups = world.groups.filter( ( group ) => group.kind === 'stewards' && group.alive > 0 );
				if ( ! groups.length ) return { status: 'no-target' };
				await world.march( groups, ...mission.sp.pos, 8 ); return { status: 'applied', people: groups.reduce( ( count, group ) => count + group.alive, 0 ) };

			}
			if ( id === 'assault-at-stand' ) {

				const point = [ - 438, - 44 ];
				const attackers = mission.antifa.filter( ( group ) => group.alive > 5 ).slice( 0, 2 );
				if ( ! attackers.length ) return { status: 'no-target' };
				game.selected = attackers; mission.assault( ...point ); game.selected = [];
				const target = attackers[ 0 ].assault;
				return target?.center ? { status: 'applied', targetAt: target.center, selection: attackers.length } : { status: 'no-target' };

			}

		}
		const runtime = mission.runtime, context = runtime.context;
		if ( id === 'shield-stewards' ) {

			const handle = context.actors.resolve( 'stewards' );
			const result = await runtime.commands.execute( null, 'shield', { at: [ - 205, - 178 ], selection: [ handle ] }, 'player' ).settled;
			return { status: result.status, code: result.code ?? null, people: context.actors.get( handle )?.alive ?? 0 };

		}
		const speaker = context.protected.get( context.protected.resolve( 'speaker-person' ) );
		if ( id === 'screen-stewards' ) {

			const handle = context.actors.resolve( 'stewards' );
			const result = await runtime.playerMove( handle, speaker.position, { radius: 8 } ).settled;
			return { status: result.status, code: result.code ?? null, people: context.actors.get( handle )?.alive ?? 0 };

		}
		if ( id === 'assault-at-stand' ) {

			const point = [ - 438, - 44 ];
			let target = null, nearestSquared = 30 ** 2;
			for ( const record of runtime.actors.values() ) {

				if ( record.handle.kind !== 'squad' ) continue;
				for ( const person of runtime.identity.members( record.handle ) ) {

					if ( person.faction !== 'police' || person.status !== 'active' ) continue;
					const squared = ( person.position[ 0 ] - point[ 0 ] ) ** 2 + ( person.position[ 1 ] - point[ 1 ] ) ** 2;
					if ( squared < nearestSquared ) { nearestSquared = squared; target = record; }

				}

			}
			const targetCenter = target && runtime.actor( target.handle )?.center;
			const attackers = [ 'antifa-1', 'antifa-2' ].map( ( id ) => context.actors.resolve( id ) ).filter( ( actor ) => context.actors.get( actor )?.alive > 5 );
			if ( ! targetCenter || ! attackers.length ) return { status: 'no-target' };
			const result = await runtime.commands.execute( null, 'antifa-assault', { at: point, selection: attackers }, 'player' ).settled;
			return { status: result.status, code: result.code ?? null, targetAt: targetCenter, selection: attackers.length };

		}
		return { status: 'unknown-action' };

	}, { mode, id } );

}

async function runMode( browser, mode ) {

	const errors = [], actions = [], checkpoints = [], page = await launchPage( browser, mode, errors );
	try {

		let current = await snapshot( page, mode ), actionIndex = 0;
		const events = [ ...( current.events ?? [] ) ];
		checkpoints.push( { at: 0, ...current } );
		for ( const target of CHECKPOINTS.slice( 1 ).filter( ( time ) => time <= maxSeconds ) ) {

			while ( current.time < target - 0.01 && ! current.result ) {

				const nextAction = ACTIONS[ actionIndex ]?.at ?? Infinity;
				const step = Math.min( 10, target - current.time, nextAction > current.time ? nextAction - current.time : 10 );
				if ( step <= 0 ) break;
				await advance( page, mode, step );
				await wait( 2000 );
				current = await snapshot( page, mode );
				events.push( ...( current.events ?? [] ) );

			}
			while ( ACTIONS[ actionIndex ] && ACTIONS[ actionIndex ].at <= current.time + 0.01 && ! current.result ) {

				const planned = ACTIONS[ actionIndex ++ ];
				actions.push( { plannedAt: planned.at, actualAt: current.time, id: planned.id, result: await action( page, mode, planned.id ) } );
				current = await snapshot( page, mode );
				events.push( ...( current.events ?? [] ) );

			}
			checkpoints.push( { at: target, ...current } );
			if ( current.result || current.state === 'finished' ) break;

		}
		return { mode, url: urlFor( mode ), seed, actions, checkpoints, events, final: current, errors };

	} finally { await page.close(); }

}

function compare( native, sdk ) {

	const differences = [];
	const distance = ( first, second ) => ! first && ! second ? 0 : first && second ? Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ] ) : Infinity;
	const actionsMatch = native.actions.length === sdk.actions.length && native.actions.every( ( left, index ) => {

		const right = sdk.actions[ index ];
		const nativeResult = left.result ?? {}, sdkResult = right?.result ?? {};
		const normalized = ( status ) => [ 'applied', 'completed' ].includes( status ) ? 'applied' : status;
		const same = left.id === right?.id && normalized( nativeResult.status ) === normalized( sdkResult.status )
			&& ( nativeResult.code ?? null ) === ( sdkResult.code ?? null )
			&& ( nativeResult.people === undefined || sdkResult.people === undefined || nativeResult.people === sdkResult.people )
			&& ( nativeResult.selection === undefined || sdkResult.selection === undefined || nativeResult.selection === sdkResult.selection )
			&& ( nativeResult.targetAt === undefined && sdkResult.targetAt === undefined
				|| nativeResult.targetAt && sdkResult.targetAt && distance( nativeResult.targetAt, sdkResult.targetAt ) <= 30 );
		if ( ! same ) differences.push( { at: left.actualAt, field: `action.${left.id}`, native: nativeResult, sdk: sdkResult } );
		return same;

	} );
	for ( const left of native.checkpoints ) {

		const right = sdk.checkpoints.find( ( checkpoint ) => checkpoint.at === left.at );
		if ( ! right ) { differences.push( { at: left.at, field: 'checkpoint', native: true, sdk: false } ); continue; }
		if ( Math.abs( left.time - right.time ) > 0.1 ) differences.push( { at: left.at, field: 'time', native: left.time, sdk: right.time } );
		if ( left.speaker.state !== right.speaker.state ) differences.push( { at: left.at, field: 'speaker.state', native: left.speaker.state, sdk: right.speaker.state } );
		const speakerDistance = distance( left.speaker.position, right.speaker.position );
		if ( speakerDistance > 15 ) differences.push( { at: left.at, field: 'speaker.position', distance: speakerDistance, native: left.speaker.position, sdk: right.speaker.position } );
		const carDistance = distance( left.car.position, right.car.position );
		if ( carDistance > 15 ) differences.push( { at: left.at, field: 'car.position', distance: carDistance, native: left.car.position, sdk: right.car.position } );
		if ( Math.abs( left.metrics.opinion - right.metrics.opinion ) > 1 ) differences.push( { at: left.at, field: 'opinion', native: left.metrics.opinion, sdk: right.metrics.opinion } );
		for ( const key of [ 'injuriesByPolice', 'officersInjured', 'arrests', 'treatedByMedics', 'gasUsed' ] ) {

			const nativeCount = left.metrics.counters[ key ] ?? 0, sdkCount = right.metrics.counters[ key ] ?? 0;
			if ( Math.abs( nativeCount - sdkCount ) > 2 ) differences.push( { at: left.at, field: `counters.${key}`, native: nativeCount, sdk: sdkCount } );

		}
		if ( left.objectives.length !== right.objectives.length ) differences.push( { at: left.at, field: 'objectives.length', native: left.objectives.length, sdk: right.objectives.length } );
		for ( const [ index, nativeRow ] of left.objectives.entries() ) {

			const sdkRow = right.objectives[ index ]; if ( ! sdkRow ) continue;
			if ( nativeRow.label !== sdkRow.label || nativeRow.state !== sdkRow.state || nativeRow.invert !== sdkRow.invert ) differences.push( { at: left.at,
				field: `objectives.${index}`, native: nativeRow, sdk: sdkRow } );
			if ( Math.abs( nativeRow.value - sdkRow.value ) > 0.03 ) differences.push( { at: left.at, field: `objectives.${index}.value`, native: nativeRow.value, sdk: sdkRow.value } );

		}
		if ( Boolean( left.result ) !== Boolean( right.result ) ) differences.push( { at: left.at, field: 'terminal', native: Boolean( left.result ), sdk: Boolean( right.result ) } );

	}
	const nativeResult = native.final.result, sdkResult = sdk.final.result;
	const outcomeMatches = Boolean( nativeResult && sdkResult && nativeResult.win === sdkResult.win
		&& nativeResult.reason === sdkResult.reason && nativeResult.stars === sdkResult.stars );
	if ( ! outcomeMatches ) differences.push( { at: 'final', field: 'result', native: nativeResult, sdk: sdkResult } );
	return { actionsMatch, outcomeMatches, differences, accepted: actionsMatch && outcomeMatches && differences.length === 0 && ! native.errors.length && ! sdk.errors.length };

}

const browser = await puppeteer.launch( { executablePath, headless: true, protocolTimeout: 0,
	args: [ '--enable-unsafe-webgpu', ...( process.platform === 'darwin' ? [ '--use-angle=metal' ] : [] ) ] } );
const report = { seed, strategy: ACTIONS, startedAt: new Date().toISOString(), native: null, sdk: null, comparison: null };
try {

	report.native = await runMode( browser, 'native' );
	report.sdk = await runMode( browser, 'sdk' );
	report.comparison = compare( report.native, report.sdk );
	mkdirSync( dirname( artifact ), { recursive: true } );
	writeFileSync( artifact, JSON.stringify( report, null, 2 ) );
	console.log( JSON.stringify( { accepted: report.comparison.accepted, artifact, comparison: report.comparison,
		native: report.native.final, sdk: report.sdk.final }, null, 2 ) );
	if ( ! report.comparison.accepted ) process.exitCode = 1;

} finally { await browser.close(); }
