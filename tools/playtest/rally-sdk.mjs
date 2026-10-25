// Drive the Rally SDK preview only through visible labels, HUD text, keyboard, and pointer input.
// Requires the game's dev server and a Chromium remote-debugging endpoint on port 9333.
import puppeteer from 'puppeteer-core';

const base = process.env.RALLY_SDK_BASE ?? 'http://localhost:5197';
const maxWallMs = Number( process.env.RALLY_SDK_WALL_MS ?? 900000 );
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
	?? ( process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null );
if ( ! executablePath ) throw new Error( 'Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium executable.' );
const url = new URL( '/', base );
url.searchParams.set( 'plugin', '/examples/rally-scenario.ts' );
url.searchParams.set( 'm', 'rally-rules' );

const browser = await puppeteer.launch( { executablePath, headless: true,
	args: [ '--enable-unsafe-webgpu', ...( process.platform === 'darwin' ? [ '--use-angle=metal' ] : [] ) ] } );
const page = await browser.newPage();
const errors = [];
const actions = [];
const pause = ( milliseconds ) => new Promise( ( resolve ) => setTimeout( resolve, milliseconds ) );
page.on( 'pageerror', ( error ) => errors.push( error.message ) );
page.on( 'console', ( message ) => {
	if ( message.type() === 'error' && /flow field pool exhausted|Frame failed|Scenario rally-rules/i.test( message.text() ) ) errors.push( message.text() );
} );

function seconds( clock ) {

	const match = /^(\d+):(\d{2})$/.exec( clock.trim() );
	return match ? Number( match[ 1 ] ) * 60 + Number( match[ 2 ] ) : NaN;

}

async function visiblePlace( name ) {

	return await page.$$eval( '#labels .lbl.place', ( elements, wanted ) => {
		const element = elements.find( ( entry ) => entry.textContent.trim().toLocaleLowerCase() === wanted.toLocaleLowerCase()
			&& getComputedStyle( entry ).display !== 'none' );
		if ( ! element ) return null;
		const rect = element.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	}, name );

}

async function boxSelectVisibleProtesters() {

	const canvas = await page.$( 'canvas#view' ), bounds = await canvas?.boundingBox();
	if ( ! bounds ) throw new Error( 'The visible map canvas is unavailable' );
	await page.keyboard.down( 'Shift' );
	await page.mouse.move( bounds.x + 2, bounds.y + 2 );
	await page.mouse.down( { button: 'left' } );
	await page.mouse.move( bounds.x + bounds.width - 2, bounds.y + bounds.height - 2, { steps: 8 } );
	await page.mouse.up( { button: 'left' } );
	await page.keyboard.up( 'Shift' );
	await pause( 120 );
	actions.push( 'box-select-visible-protesters' );
	return await page.$eval( '#selInfo', ( element ) => element.textContent.trim() );

}

async function boxSelectPlace( name, radius = 120 ) {

	const center = await visiblePlace( name );
	if ( ! center ) throw new Error( `Place label is not visible: ${name}` );
	await page.keyboard.down( 'Shift' );
	await page.mouse.move( center.x - radius, center.y - radius );
	await page.mouse.down( { button: 'left' } );
	await page.mouse.move( center.x + radius, center.y + radius, { steps: 5 } );
	await page.mouse.up( { button: 'left' } );
	await page.keyboard.up( 'Shift' );
	await pause( 120 );
	actions.push( `box-select:${name}` );
	return await page.$eval( '#selInfo', ( element ) => element.textContent.trim() );

}

async function hudSnapshot() {

	return await page.evaluate( () => ( {
		clock: document.querySelector( '#clock' )?.textContent.trim() ?? '',
		phase: document.querySelector( '#phase' )?.textContent.trim() ?? '',
		objectives: [ ...( document.querySelectorAll( '#objList li' ) ) ].map( ( row ) => row.textContent.trim().replace( /\s+/g, ' ' ) ),
		selection: document.querySelector( '#selInfo' )?.textContent.trim() ?? '',
		result: document.querySelector( '.card h1' )?.textContent.trim() ?? '',
		resultRows: [ ...( document.querySelectorAll( '.card table tr' ) ) ].map( ( row ) => row.textContent.trim().replace( /\s+/g, ' ' ) ),
		feed: document.querySelector( '#feed' )?.textContent.trim() ?? '',
	} ) );

}

try {

	await page.setViewport( { width: 1400, height: 900 } );
	await page.goto( url.href, { waitUntil: 'domcontentloaded', timeout: 120000 } );
	await page.waitForSelector( '#bStart', { timeout: 120000 } );
	await page.click( '#bStart' );
	await page.waitForSelector( '#clock' );
	for ( const name of [ 'Prešernov trg', 'Metelkova', 'Park Tivoli', 'Kongresni trg', 'Trg republike' ] ) {
		await page.waitForFunction( ( label ) => [ ...document.querySelectorAll( '#labels .lbl.place' ) ].some( ( element ) =>
			element.textContent.trim().toLocaleLowerCase() === label.toLocaleLowerCase() ), { timeout: 120000 }, name );
	}

	// Zoom out and box-select the four source clusters using only the rendered map labels.
	await page.mouse.move( 700, 450 );
	for ( let index = 0; index < 4; index ++ ) await page.mouse.wheel( { deltaY: 120 } );
	await pause( 400 );
	let selected = await boxSelectVisibleProtesters();
	let selectedPeople = Number( selected.match( /([\d,]+) people/ )?.[ 1 ]?.replaceAll( ',', '' ) ?? 0 );
	console.log( `[selection] full canvas: ${selected}` );
	if ( selectedPeople < 2400 ) {

		for ( const name of [ 'Prešernov trg', 'Metelkova', 'Park Tivoli', 'Kongresni trg' ] ) {
			selected = await boxSelectPlace( name );
			selectedPeople = Number( selected.match( /([\d,]+) people/ )?.[ 1 ]?.replaceAll( ',', '' ) ?? 0 );
			console.log( `[selection] ${name}: ${selected}` );
			if ( selectedPeople >= 2400 ) break;
		}

	}
	if ( selectedPeople < 1500 ) throw new Error( `Expected to select at least 1,500 protesters; selected ${selected}` );

	const square = await visiblePlace( 'Trg republike' );
	if ( ! square ) throw new Error( 'Trg republike label is not visible' );
	await page.mouse.click( square.x, square.y, { button: 'right' } );
	actions.push( 'move-selected-groups:Trg republike' );
	for ( let attempt = 0; attempt < 4; attempt ++ ) {

		if ( ( await page.$eval( '#speedBtn', ( element ) => element.textContent.trim() ) ) === '3×' ) break;
		await page.keyboard.press( '=' );
		await pause( 100 );

	}
	const speed = await page.$eval( '#speedBtn', ( element ) => element.textContent.trim() );
	if ( speed !== '3×' ) throw new Error( `Could not set simulation speed to 3x (button shows ${speed})` );

	let lastRallyAt = - 30, lastProgressAt = - 60, bestSquareCount = 0, lastSnapshot = await hudSnapshot();
	const startedAt = Date.now();
	while ( Date.now() - startedAt < maxWallMs ) {

		const snapshot = await hudSnapshot();
		const elapsed = seconds( snapshot.clock );
		if ( Number.isFinite( elapsed ) ) {

			const squareRow = snapshot.objectives.find( ( row ) => row.startsWith( 'People in the square' ) );
			const count = Number( squareRow?.match( /([\d,]+)\s*\/\s*5,000/ )?.[ 1 ]?.replaceAll( ',', '' ) ?? 0 );
			bestSquareCount = Math.max( bestSquareCount, count );
			if ( elapsed - lastProgressAt >= 60 ) {

				lastProgressAt = elapsed;
				console.log( `[progress] ${snapshot.clock} square=${count}/5000 best=${bestSquareCount} phase=${snapshot.phase}` );

			}
			if ( elapsed - lastRallyAt >= 30 && elapsed < 1200 ) {

				const target = await visiblePlace( 'Trg republike' );
				if ( target ) {
					await page.mouse.move( target.x, target.y );
					await page.keyboard.press( 'r' );
					lastRallyAt = elapsed;
					actions.push( `rally-call@${elapsed}` );
				}

			}
			if ( snapshot.result === 'Mission complete' || snapshot.result === 'Mission failed' ) { lastSnapshot = snapshot; break; }

		}
		lastSnapshot = snapshot;
		await pause( 500 );

	}

	const passed = lastSnapshot.result === 'Mission complete';
	console.log( JSON.stringify( { passed, result: lastSnapshot.result, clock: lastSnapshot.clock, phase: lastSnapshot.phase,
		bestSquareCount, objectives: lastSnapshot.objectives, resultRows: lastSnapshot.resultRows, selected, selectedPeople,
		rallyCalls: actions.filter( ( action ) => action.startsWith( 'rally-call@' ) ), errors }, null, 2 ) );
	if ( ! passed ) process.exitCode = 1;

} finally {

	await page.close();
	await browser.close();

}