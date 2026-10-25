import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN } from '../src/game/missions/index.ts';
import { MISSIONS, registerMission } from '../src/game/registry.ts';
import { loadPlugin, loadPlugins } from '../src/game/plugins.ts';
import { Mission } from '../src/game/mission.ts';
import * as scenarioPlugin from '../examples/hello-scenario.ts';

const base = 'https://game.example/play/';

test( 'all built-ins remain unchanged when a Scenario SDK v1 plugin loads', async () => {

	MISSIONS.length = 0;
	BUILTIN.forEach( registerMission );
	const before = [ ...MISSIONS ];
	assert.deepEqual( before.map( ( mission ) => mission.id ), [ 'tutorial', 'convoy', 'defend-assembly', 'defend-vlada',
		'rally', 'clash', 'sitin', 'massacre', 'resnica', 'blackbloc', 'court', 'pride', 'rescue' ] );
	assert.deepEqual( await loadPlugin( './scenario.js', { base, importer: async () => scenarioPlugin } ), [ 'hello-scenario' ] );
	assert.deepEqual( MISSIONS.slice( 0, before.length ), before );
	assert.equal( MISSIONS.length, 14 );
	assert.equal( MISSIONS.at( - 1 ).menu, false );
	assert.equal( MISSIONS.some( ( mission ) => mission.id === 'hello-scenario' ), true );
	const current = [ ...MISSIONS ];
	await assert.rejects( loadPlugin( './duplicate.js', { base, importer: async () => scenarioPlugin } ), /already registered/ );
	assert.deepEqual( MISSIONS, current );

} );

test( 'invalid scenario packages register nothing and do not prevent valid loading', async () => {

	MISSIONS.length = 0;
	const invalid = { sdkVersion: 1, default: async ( sdk ) => [ await scenarioPlugin.default( sdk ), { kind: 'scenario', sdkVersion: 1, id: 'bad' } ] };
	const originalWarn = console.warn;
	console.warn = () => {};
	try {

		const result = await loadPlugins( [ './bad.js', './scenario.js' ], { base,
			importer: async ( url ) => url.endsWith( 'bad.js' ) ? invalid : scenarioPlugin } );
		assert.deepEqual( result.loaded, [ 'hello-scenario' ] );
		assert.equal( result.failed.length, 1 );
		assert.deepEqual( MISSIONS.map( ( mission ) => mission.id ), [ 'hello-scenario' ] );

	} finally { console.warn = originalWarn; }

} );

test( 'remote scenario plugins retain the existing trust gate before importing code', async () => {

	let imports = 0;
	await assert.rejects( loadPlugin( 'https://untrusted.example/scenario.js', { base,
		importer: async () => { imports ++; return scenarioPlugin; } } ), /remote plugins are switched off/ );
	assert.equal( imports, 0 );
	await assert.rejects( loadPlugin( 'https://untrusted.example/scenario.js', { base, allowRemote: true,
		confirm: () => false, importer: async () => { imports ++; return scenarioPlugin; } } ), /not confirmed/ );
	assert.equal( imports, 0 );

} );

test( 'SDK versions and factory presence are checked before invoking factories', async () => {

	let calls = 0;
	for ( const module of [
		{ sdkVersion: 1, default: {} },
		{ default: () => calls ++ },
		{ sdkVersion: 2, default: () => calls ++ },
	] ) await assert.rejects( loadPlugin( './invalid.js', { base, importer: async () => module } ), /factory|SDK/ );
	assert.equal( calls, 0 );

} );

test( 'plugin factories receive only definition builders, never the internal mission SDK', async () => {

	MISSIONS.length = 0;
	await loadPlugin( './public.js', { base, importer: async () => ( {
		sdkVersion: 1,
		default: ( sdk ) => {

			assert.deepEqual( Object.keys( sdk ).sort(), [ 'SDK_VERSION', 'defineBehavior', 'defineOutcome', 'defineScenario', 'escortConvoy', 'extract', 'followRoute', 'holdBuilding', 'holdCrowd', 'landmark', 'place', 'policeCommands', 'preventClash', 'protect', 'protestCommands', 'scenarioCommand', 'survive', 'target' ] );
			assert.equal( sdk.Mission, undefined );
			assert.equal( sdk.FACTION, undefined );
			return scenarioPlugin.default( sdk );

		},
	} ) } );

} );

test( 'class-based plugins are rejected without registering or removing built-ins', async () => {

	MISSIONS.length = 0;
	BUILTIN.forEach( registerMission );
	const before = [ ...MISSIONS ];
	const OldMission = class extends Mission {};
	await assert.rejects( loadPlugin( './old-factory.js', { base,
		importer: async () => ( { sdkVersion: 1, default: () => OldMission } ) } ), /scenario definition/ );
	await assert.rejects( loadPlugin( './old-class.js', { base,
		importer: async () => ( { sdkVersion: 1, default: OldMission } ) } ) );
	assert.deepEqual( MISSIONS, before );

} );