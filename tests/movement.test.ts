import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/sim/world.ts';
import { Crowd, FACTION, MODE, MAX_EDITS } from '../src/sim/crowd.ts';
import { ScenarioEngine } from '../src/game/scenarios/engine.ts';
import { MovementHost } from '../src/game/scenarios/movement.ts';
import { Mission } from '../src/game/mission.ts';

function worldFixture() {

	const writes = [], offsets = [], layers = [];
	const world = { uncordon() {}, endSnatch() {}, fieldTo: async () => 7,
		crowd: { setGroup: ( id, value ) => writes.push( { id, ...value } ), setOffsets: ( ...args ) => offsets.push( args ) },
		setLayer: ( group, layer ) => layers.push( layer ), intel: null };
	const group = { id: 0, members: [ 0, 1 ], mode: MODE.HOLD };
	return { world, group, writes, offsets, layers };

}

test( 'existing squad, march and cordon callers retain default behavior and return values', async () => {

	const squad = worldFixture();
	assert.equal( await World.prototype.moveSquads.call( squad.world, [ squad.group ], 10, 20 ), undefined );
	assert.deepEqual( ( squad.group as any ).anchor, [ 10, 20 ] );
	assert.equal( squad.group.mode, MODE.FORMATION );
	assert.deepEqual( squad.layers, [ 7 ] );
	const march = worldFixture();
	assert.equal( await World.prototype.march.call( march.world, [ march.group ], 30, 40 ), undefined );
	assert.deepEqual( ( march.group as any ).goal, [ 30, 40 ] );
	assert.equal( march.group.mode, MODE.MARCH );
	const line = worldFixture();
	assert.equal( await World.prototype.lineSquads.call( line.world, [ line.group ], [ 0, 0 ], [ 0, 10 ], null ), undefined );
	assert.deepEqual( ( line.group as any ).anchor, [ 0, 5 ] );
	assert.equal( line.group.mode, MODE.FORMATION );
	assert.deepEqual( line.layers, [ 7 ] );

} );

test( 'invalidated squad navigation does not install a stale formation', async () => {

	const { world, group, writes, offsets, layers } = worldFixture();
	let resolveField, current = true;
	world.fieldTo = () => new Promise( ( resolve ) => { resolveField = resolve; } );
	const moving = World.prototype.moveSquads.call( world, [ group ], 10, 20, { valid: () => current } );
	current = false; resolveField( 9 );
	assert.equal( await moving, false );
	assert.deepEqual( writes, [] ); assert.deepEqual( offsets, [] ); assert.deepEqual( layers, [] );
	assert.equal( group.mode, MODE.HOLD );

} );

test( 'scenario navigation retains and releases prepared fields without allocating during commit', async () => {

	const { world, group } = worldFixture();
	const references = [], calls = [];
	( world as any ).flow = { retain: ( layer ) => references.push( [ 'retain', layer ] ), release: ( layer ) => references.push( [ 'release', layer ] ) };
	( world as any ).moveSquads = ( groups, ...args ) => { calls.push( args ); return World.prototype.moveSquads.call( world, groups, ...args ); };
	( group as any ).faction = FACTION.POLICE;
	const adapter = new ScenarioEngine( { world } );
	const request = { at: [ 10, 20 ], radius: 8, line: null };
	const prepared = await adapter.prepareMove( [ group ], request, new AbortController().signal );
	world.fieldTo = () => { throw new Error( 'must reuse prepared navigation' ); };
	await adapter.applyMove( [ group ], prepared, request, () => true );
	adapter.releaseMove( prepared );
	assert.deepEqual( references, [ [ 'retain', 7 ], [ 'release', 7 ] ] );
	assert.equal( calls[ 0 ][ 2 ].layer, 7 );

} );

test( 'arrived SDK police formations settle onto the shared pinned field but active commands keep their field', () => {

	const shared = [], idleHandle = { id: 'idle', kind: 'squad', run: 1 }, busyHandle = { id: 'busy', kind: 'squad', run: 1 };
	const idle = { id: 1, members: [ 1, 2 ], faction: FACTION.POLICE, mode: MODE.FORMATION, center: [ 10, 20 ], anchor: [ 10, 20 ], layer: 3 };
	const busy = { id: 2, members: [ 3, 4 ], faction: FACTION.POLICE, mode: MODE.FORMATION, center: [ 10, 20 ], anchor: [ 10, 20 ], layer: 4 };
	const runtime: any = { actors: new Map( [ [ 'idle', { handle: idleHandle, backend: [ idle ] } ], [ 'busy', { handle: busyHandle, backend: [ busy ] } ] ] ),
		commands: { claims: new Map( [ [ busyHandle, {} ] ] ) }, movement: { orders: new Map() } };
	const world = { exitLayer: 9, setLayer: ( group, layer ) => { shared.push( [ group.id, layer ] ); group.layer = layer; } };
	const adapter = new ScenarioEngine( { world, runtime } );
	adapter.settleMove( [ idle, busy, { faction: FACTION.PROTESTER, mode: MODE.HOLD, center: [ 0, 0 ], anchor: [ 0, 0 ] } ] );
	assert.deepEqual( shared, [ [ 1, 9 ] ] );
	assert.equal( idle.layer, 9 ); assert.equal( busy.layer, 4 );

} );

test( 'movement arrival invokes adapter field settlement after removing the completed order', () => {

	const settled = [], events = [], handle = { id: 'squad', kind: 'squad', run: 1 }, backend = [ { id: 1 } ];
	const runtime: any = { state: 'running', time: 4, step: 2, operations: new Set(), nextOperation: 1,
		adapter: { settleMove: ( groups ) => settled.push( groups ) }, event: ( type, event ) => events.push( { type, ...event } ) };
	const host = new MovementHost( runtime ), owner = { id: 'player' };
	host.orders.set( handle.id, { actor: handle, owner, target: [ 10, 20 ], radius: 8, installed: true, installedStep: 1, backend } );
	host.observe( { step: 2, actors: [ { handle, center: [ 10, 20 ] } ] } );
	assert.deepEqual( settled, [ backend ] );
	assert.equal( host.orders.has( handle.id ), false );
	assert.equal( events[ 0 ].type, 'movement.arrived' );

} );

test( 'a sample predating a new actor reports unavailable instead of a partial or invalid position', () => {

	const adapter = new ScenarioEngine( {} );
	const groups = [ { members: [ 0, 1 ] } ];
	assert.equal( adapter.readActor( groups, { faction: ( member ) => member === 0 ? 1 : undefined,
		x: () => 10, y: () => 20 } ), null );
	assert.equal( adapter.readActor( groups, { faction: () => 1, x: () => NaN, y: () => 20 } ), null );
	assert.deepEqual( adapter.readActor( groups, { faction: () => 1, x: () => 10, y: () => 20 } ),
		{ alive: 2, center: [ 10, 20 ] } );

} );

test( 'leader promotion preserves membership and demotes the previous leader', () => {

	const writes = [], roles = [];
	const group = { id: 7, members: [ 11, 12 ], leader: 11 };
	const adapter = new ScenarioEngine( { crowd: {
		regroup: ( ...args ) => roles.push( args ), setGroup: ( ...args ) => writes.push( args ),
	} } );
	adapter.promoteLeader( { group, member: 12 }, [ 5, 8 ] );
	assert.equal( group.leader, 12 ); assert.deepEqual( group.members, [ 11, 12 ] );
	assert.deepEqual( roles, [ [ 11, 7, 0 ], [ 12, 7, 1 ] ] );
	assert.deepEqual( writes, [ [ 7, { leader: 12 } ] ] );
	adapter.promoteLeader( { group, member: 12 }, [ 5, 8 ] );
	assert.equal( writes.length, 1 );
	assert.throws( () => adapter.promoteLeader( { group, member: 99 }, [ 0, 0 ] ), /no longer belongs/ );
	assert.equal( writes.length, 1 );

} );

function transferFixture() {

	const source = { id: 0, faction: FACTION.POLICE, members: [ 0, 1 ], leader: 0 };
	const target = { id: 1, faction: FACTION.POLICE, members: [ 2, 3 ], leader: 2 };
	const edits = [], writes = [], formations = [], released = [];
	const mission = { world: { uncordon: ( groups ) => released.push( groups ) },
		crowd: { pendingEdits: edits, regroup: ( ...args ) => edits.push( args ),
			setGroup: ( ...args ) => writes.push( args ), setOffsets: ( indices, offsets ) => formations.push( { indices, count: offsets.length } ) },
		game: { selected: [ source, target ] } };
	const groups = [ 0, 0, 1, 1 ], factions = [ 1, 1, 1, 1 ];
	const sample = { group: ( member ) => groups[ member ], faction: ( member ) => factions[ member ], x: ( member ) => member, y: () => 0 };
	return { source, target, mission, sample, factions, edits, writes, formations, released, adapter: new ScenarioEngine( mission ) };

}

test( 'person transfer atomically repairs both leaders, memberships and police formations', () => {

	const { source, target, adapter, sample, edits, writes, formations } = transferFixture();
	const result = adapter.transferPerson( { group: source, member: 0 }, [ target ], { promote: true, sample } );
	assert.equal( result.status, 'completed' ); assert.equal( result.backend.group, target );
	assert.deepEqual( source.members, [ 1 ] ); assert.deepEqual( target.members, [ 2, 3, 0 ] );
	assert.equal( source.leader, 1 ); assert.equal( target.leader, 0 );
	assert.deepEqual( edits, [ [ 0, 1, 1 ], [ 1, 0, 1 ], [ 2, 1, 0 ] ] );
	assert.deepEqual( writes, [ [ 0, { leader: 1 } ], [ 1, { leader: 0 } ] ] );
	assert.deepEqual( formations.map( ( entry ) => entry.count ), [ 2, 6 ] );
	assert.equal( new Set( [ ...source.members, ...target.members ] ).size, 4 );

} );

test( 'invalid membership, faction and queue capacity reject before any mutation', () => {

	for ( const failure of [ 'stale', 'faction', 'capacity', 'duplicate' ] ) {

		const { source, target, adapter, sample, edits, writes, released } = transferFixture();
		if ( failure === 'stale' ) source.members = [ 1 ];
		if ( failure === 'faction' ) target.faction = FACTION.PROTESTER;
		if ( failure === 'capacity' ) edits.push( ...new Array( MAX_EDITS ).fill( [] ) );
		if ( failure === 'duplicate' ) source.members = [ 0, 0, 1 ];
		const before = { source: [ ...source.members ], target: [ ...target.members ], queued: edits.length };
		const result = adapter.transferPerson( { group: source, member: 0 }, [ target ], { promote: true, sample } );
		assert.equal( result.status, 'rejected' );
		assert.deepEqual( source.members, before.source ); assert.deepEqual( target.members, before.target );
		assert.equal( edits.length, before.queued ); assert.equal( writes.length, 0 ); assert.equal( released.length, 0 );

	}

} );

test( 'moving the final source member clears leadership and selection without duplicating people', () => {

	const { source, target, adapter, sample, mission } = transferFixture();
	source.members = [ 0 ];
	const result = adapter.transferPerson( { group: source, member: 0 }, [ target ], { promote: false, sample } );
	assert.equal( result.status, 'completed' );
	assert.deepEqual( source.members, [] ); assert.equal( source.leader, - 1 ); assert.equal( ( source as any ).leaderState, 'gone' );
	assert.equal( target.leader, 2 ); assert.deepEqual( target.members, [ 2, 3, 0 ] );
	assert.deepEqual( mission.game.selected, [ target ] );

} );

test( 'moving a member does not revive an injured source leader', () => {

	const { source, target, adapter, sample, factions } = transferFixture();
	source.leader = 1; ( source as any ).leaderState = 'injured'; factions[ 1 ] = 11;
	assert.equal( adapter.transferPerson( { group: source, member: 0 }, [ target ], { promote: true, sample } ).status, 'completed' );
	assert.equal( source.leader, 1 ); assert.equal( ( source as any ).leaderState, 'injured' );
	assert.equal( ( source as any ).alive, 0 );

} );

test( 'boarding emits conditional faction edits and repairs leader state without duplicating members', () => {

	const { source, adapter, sample, mission, edits, writes } = transferFixture();
	( mission.crowd as any ).compareFaction = ( ...args ) => edits.push( args );
	const plan = adapter.prepareBoarding( [ { member: 0, group: source } ], sample );
	assert.equal( plan.status, 'completed' );
	adapter.commitBoarding( plan );
	assert.deepEqual( edits[ 0 ], [ 0, 1, - 1, 0 ] );
	assert.equal( source.leader, 1 ); assert.deepEqual( source.members, [ 0, 1 ] );
	assert.equal( adapter.boardingConfirmed( plan, sample ), false );
	const boarded = { ...sample, faction: ( member ) => member === 0 ? - 1 : 1 };
	assert.equal( adapter.boardingConfirmed( plan, boarded ), true );
	adapter.rollbackBoarding( plan );
	assert.equal( source.leader, 0 );
	assert.ok( edits.some( ( edit ) => JSON.stringify( edit ) === JSON.stringify( [ 0, - 1, 1, 0 ] ) ) );
	assert.equal( writes.at( - 1 )[ 1 ].leader, 0 );
	const crowd = { pendingEdits: [] };
	Crowd.prototype.compareFaction.call( crowd, 4, 1, - 1, 7 );
	assert.deepEqual( crowd.pendingEdits, [ [ 4, 6, 0, 0, - 1, 1, 0, 0, 7, 0, 0, 0 ] ] );

} );

test( 'boarding rejects people with pending critical edits before touching groups or roles', () => {

	const { source, adapter, sample, edits, writes } = transferFixture();
	edits.push( [ 0, 2, 0, 0, 31 ] );
	assert.equal( adapter.prepareBoarding( [ { member: 0, group: source } ], sample ).code, 'PERSON_PENDING' );
	assert.equal( source.leader, 0 ); assert.equal( writes.length, 0 ); assert.equal( edits.length, 1 );

} );

test( 'discarding a passenger actor cancels its queued boarding and cannot queue revival', () => {

	const { source, adapter, sample, mission } = transferFixture();
	( mission.crowd as any ).compareFaction = ( ...args ) => Crowd.prototype.compareFaction.call( mission.crowd, ...args );
	const plan = adapter.prepareBoarding( [ { member: 0, group: source } ], sample );
	adapter.commitBoarding( plan );
	const unrelated = [ 99, 2, 0, 0, 31 ];
	mission.crowd.pendingEdits.push( unrelated );
	adapter.rollbackBoarding( plan, [ { member: 0, group: source } ] );
	assert.deepEqual( mission.crowd.pendingEdits, [ unrelated ] );
	assert.equal( plan.edits.length, 0 );

} );

test( 'disposal cancels owned restoration edits but preserves unrelated queued effects', () => {

	const { source, adapter, sample, mission } = transferFixture();
	( mission.crowd as any ).compareFaction = ( ...args ) => Crowd.prototype.compareFaction.call( mission.crowd, ...args );
	const plan = adapter.prepareBoarding( [ { member: 0, group: source } ], sample );
	adapter.commitBoarding( plan );
	adapter.rollbackBoarding( plan );
	assert.ok( mission.crowd.pendingEdits.some( ( edit ) => edit[ 0 ] === 0 && edit[ 1 ] === 6 && edit[ 4 ] === 1 ) );
	const unrelated = [ 99, 2, 0, 0, 31 ];
	mission.crowd.pendingEdits.push( unrelated );
	adapter.abandonBoarding( plan );
	assert.deepEqual( mission.crowd.pendingEdits, [ unrelated ] );

} );

test( 'standard charge/arrest/kettle methods preserve defaults and accept prepared guarded application', async () => {

	for ( const id of [ 'charge', 'arrest', 'kettle' ] ) {

		const { world, group, layers } = worldFixture();
		group.members = [ 0, 1 ];
		const result = id === 'charge' ? World.prototype.charge.call( world, [ group ], 10, 20 )
			: id === 'arrest' ? World.prototype.arrest.call( world, [ group ], 10, 20 )
				: World.prototype.kettle.call( world, [ group ], 10, 20, 14, [ 0, 0, 1, 1 ] );
		assert.equal( await result, undefined ); assert.deepEqual( layers, [ 7 ] );
		assert.equal( group.mode, id === 'charge' ? MODE.CHARGE : id === 'arrest' ? MODE.ARREST : MODE.FORMATION );
		const guarded = worldFixture();
		guarded.world.fieldTo = () => { throw new Error( 'must not allocate navigation during commit' ); };
		if ( id === 'charge' ) await World.prototype.charge.call( guarded.world, [ guarded.group ], 10, 20, { layer: 8, valid: () => true } );
		if ( id === 'arrest' ) await World.prototype.arrest.call( guarded.world, [ guarded.group ], 10, 20, 5, null, { layer: 8, valid: () => true } );
		if ( id === 'kettle' ) await World.prototype.kettle.call( guarded.world, [ guarded.group ], 10, 20, 14, [ 0, 0, 1, 1 ], { layer: 8, valid: () => true } );
		assert.deepEqual( guarded.layers, [ 8 ] );

	}

} );

test( 'reinforcement cancellation after allocation removes provisional actors and does not retain late navigation', async () => {

	const actors = new Map<any, any>(), removed = [], retained = [];
	let resolveField;
	const mission = { crowd: { count: 0, N: 1000, G: 100 }, city: { landmarks: [ { kind: 'police', name: 'Station', pos: [ 0, 0 ] } ] },
		world: { groups: [], flow: { retain: ( layer ) => retained.push( layer ) }, fieldTo: () => new Promise( ( resolve ) => { resolveField = resolve; } ) },
		runtime: { actors, spawn( kind, options ) {

			const handle = { id: options.id }, backend = [ {} ]; actors.set( handle.id, { handle, backend } );
			return { settled: Promise.resolve( { status: 'completed', value: handle } ), cancel() {} };

		}, removeActor: ( handle ) => { removed.push( handle.id ); actors.delete( handle.id ); } } };
	const adapter = new ScenarioEngine( mission ), controller = new AbortController();
	const preparing = adapter.prepareCommand( { id: 'reinforce', at: [ 20, 0 ] }, [], controller.signal );
	await Promise.resolve(); controller.abort( 'cancelled' ); resolveField( 9 );
	await assert.rejects( preparing );
	assert.deepEqual( removed, [ 'reinforcement-1' ] ); assert.deepEqual( retained, [] ); assert.equal( actors.size, 0 );

} );

test( 'release of an unapplied reinforcement plan removes it while applied actor plans remain', () => {

	const released = [], removed = [];
	const adapter = new ScenarioEngine( { world: { flow: { release: ( layer ) => released.push( layer ) } }, runtime: { removeActor: ( actor ) => removed.push( actor.id ) } } );
	adapter.releaseCommand( { layer: 7, actor: { id: 'pending' }, applied: false } );
	adapter.releaseCommand( { layer: 8, actor: { id: 'active' }, applied: true } );
	assert.deepEqual( released, [ 7, 8 ] ); assert.deepEqual( removed, [ 'pending' ] );

} );

test( 'score adapter exposes only immutable semantic opinion and counters', () => {

	const mission = { opinion: 47.5, counters: { injByPolice: 3, injOther: 2, injPolice: 1, arrested: 4,
		arrestedSitters: 0, gone: 5, gas: 2, shot: 0 } };
	const metrics = new ScenarioEngine( mission ).readMetrics();
	assert.deepEqual( metrics, { opinion: 47.5, escalation: 0, clashContacts: 0, counters: { injuriesByPolice: 3, otherInjuries: 2, officersInjured: 1,
		arrests: 4, sitterArrests: 0, peopleGone: 5, gasUsed: 2, shotsFired: 0, treatedByMedics: 0, peopleKilled: 0, officersKilled: 0 } } );
	assert.equal( Object.isFrozen( metrics ), true ); assert.equal( Object.isFrozen( metrics.counters ), true );

} );

test( 'crowd control maps semantic modes and agitation deltas without exposing member indices', () => {

	const groups = [ { id: 4, faction: FACTION.PROTESTER, members: [ 10, 11, 12 ] } ], modes = [], nudges = [];
	const world = { setMode: ( selected, mode ) => modes.push( { selected, mode } ), intel: { faction: ( member ) => member === 12 ? - 2 : 0 } };
	const crowd = { nudge: ( member, agitation, resolve ) => nudges.push( { member, agitation, resolve } ) };
	const adapter = new ScenarioEngine( { world, crowd } );
	assert.equal( adapter.setCrowdMode( groups, 'riot' ).status, 'completed' );
	assert.equal( modes[ 0 ].mode, MODE.RIOT ); assert.deepEqual( modes[ 0 ].selected, groups );
	assert.deepEqual( adapter.nudgeCrowd( groups, { agitation: 0.2, resolve: - 0.1 } ), { status: 'completed', people: 2 } );
	assert.deepEqual( nudges, [ { member: 10, agitation: 0.2, resolve: - 0.1 }, { member: 11, agitation: 0.2, resolve: - 0.1 } ] );
	assert.equal( adapter.setCrowdMode( [ { id: 5, faction: FACTION.POLICE, members: [] } ], 'riot' ).code, 'FACTION' );

} );

test( 'bystander allocation uses shared wander fields and releases partial groups on cancellation', async () => {

	const groups = [], fieldRequests = [], releasedLayers = [], removedPeople = [];
	let controller, spawnCount = 0;
	const crowd = { count: 0, N: 100, G: 100, setFaction: ( member, faction ) => removedPeople.push( [ member, faction ] ) };
	const world = { groups, flow: { release: ( layer ) => releasedLayers.push( layer ) },
		async field( key, x, y, radius ) { fieldRequests.push( { key, x, y, radius } ); return fieldRequests.length; },
		async bloc( options ) {

			const group = { id: groups.length, faction: options.faction, kind: options.kind, members: Array.from( { length: options.n }, ( _, index ) => `person-${spawnCount}-${index}` ),
				alive: options.n, layer: options.layer };
			groups.push( group ); crowd.count += options.n; spawnCount ++;
			if ( controller && spawnCount === 1 ) controller.abort( 'cancel fixture' );
			return [ group ];

		} };
	const adapter = new ScenarioEngine( { world, crowd, city: { bounds: [ - 1000, - 1000, 1000, 1000 ] }, runtime: { run: 7, random: () => 0.5 }, game: { selected: [] } } );
	const options = { id: 'bystanders', people: 13, groupSize: 12, spread: 60, destinations: [ [ 1, 2 ], [ 3, 4 ] ] };
	const allocated = await adapter.allocateBystanders( options, new AbortController().signal );
	assert.equal( allocated.length, 2 ); assert.deepEqual( allocated.map( ( group ) => group.members.length ), [ 12, 1 ] );
	assert.deepEqual( fieldRequests.map( ( request ) => [ request.x, request.y, request.radius ] ), [ [ 1, 2, 25 ], [ 3, 4, 25 ] ] );
	assert.equal( allocated.every( ( group ) => group.faction === FACTION.BYSTANDER ), true );
	for ( const group of allocated ) adapter.release( [ group ] );
	groups.length = 0; crowd.count = 0; fieldRequests.length = 0; releasedLayers.length = 0; removedPeople.length = 0; spawnCount = 0;
	controller = new AbortController();
	await assert.rejects( adapter.allocateBystanders( options, controller.signal ), /cancel fixture/ );
	assert.equal( groups[ 0 ].members.length, 0 ); assert.equal( removedPeople.length, 12 );
	assert.equal( releasedLayers.length, 1 ); assert.ok( [ 1, 2 ].includes( releasedLayers[ 0 ] ) );

} );

test( 'snatch pursuit results correlate to their applied operation and other control cancels the task', () => {

	const squad = Object.freeze( { id: 'guard', kind: 'squad', run: 1 } ), target = {}, person = Object.freeze( { id: 'leader', kind: 'person', run: 1 } );
	const events = [], returned = [];
	const group = {};
	const adapter = new ScenarioEngine( { world: { endSnatch: ( groups ) => returned.push( groups ) },
		runtime: { event: ( type, value ) => events.push( { type, ...value } ) } } );
	adapter.snatchTasks.set( group, { operation: '1:8', squad, target: person, targetGroup: target } );
	assert.deepEqual( adapter.snatchOutcome( group, target, 'detained' ), { operation: '1:8', squad, target: person, type: 'snatch.completed', result: 'detained' } );
	assert.equal( adapter.snatchTasks.size, 0 );
	adapter.snatchTasks.set( group, { operation: '1:9', squad, target: person, targetGroup: target } );
	adapter.cancelSnatches( [ group ], 'player movement' );
	assert.equal( adapter.snatchTasks.size, 0 ); assert.deepEqual( returned, [ [ group ] ] );
	assert.deepEqual( events, [ { type: 'snatch.cancelled', operation: '1:9', squad, target: person, reason: 'player movement' } ] );

} );

test( 'base firearms effect accepts a captured squad list and keeps default squad selection', () => {

	const st = new Float32Array( 12 ), pos = new Float32Array( 6 );
	st[ 0 ] = FACTION.PROTESTER; st[ 4 ] = FACTION.BYSTANDER; st[ 8 ] = FACTION.PROTESTER;
	pos.set( [ 4, 0, 1000, 0, 1000, 0 ] );
	const hit = [], events = [], selected = { center: [ 0, 0 ] }, unselected = { center: [ 1000, 0 ] };
	const mission: any = { game: { squads: [ selected, unselected ], sound: { firearms() {} } }, world: { intel: { st, pos } }, crowd: {
		count: 3, nudge() {}, setFaction( index, faction ) { hit.push( [ index, faction ] ); },
	}, counters: { injByPolice: 0, injOther: 0, injPolice: 0, arrested: 0, arrestedSitters: 0, gone: 0, gas: 0 },
		escalate( value ) { mission.escalation = value; }, nudgeOpinion( value ) { mission.opinionDelta = value; }, event( text ) { events.push( text ); } };
	Mission.prototype.openFire.call( mission, [ selected ] );
	assert.deepEqual( hit.map( ( entry ) => entry[ 0 ] ), [ 0 ] );
	assert.equal( mission.counters.shot, 1 ); assert.equal( mission.escalation, 4 );
	assert.equal( mission.opinionDelta, - 26 ); assert.match( events[ 0 ], /1 people down/ );
	hit.length = 0; mission.counters.shot = 0;
	Mission.prototype.openFire.call( mission );
	assert.ok( hit.some( ( entry ) => entry[ 0 ] === 0 ) );
	assert.ok( hit.some( ( entry ) => entry[ 0 ] > 0 ) );
	assert.equal( mission.counters.shot, hit.length );

} );

test( 'stationary SDK crowds share exit navigation instead of allocating a field for every onlooker group', async () => {

	let allocated = 0; const layers = [];
	const engine = new ScenarioEngine( { runtime: { random: () => 0 }, crowd: { count: 0, N: 10000, G: 1000 },
		world: { groups: [], exits: async () => 3, fieldTo: () => { allocated ++; throw new Error( 'unnecessary private field' ); },
			bloc: async ( options ) => { layers.push( options.layer ); return []; } } } );
	for ( let index = 0; index < 100; index ++ ) await engine.allocate( 'crowd', { id: `onlooker-${index}`, people: 20, groupSize: 20, at: [ index, 0 ], goal: null, speed: [ 0, 0 ], mode: 'hold', faction: 'bystander' }, new AbortController().signal );
	assert.equal( allocated, 0 ); assert.equal( layers.length, 100 ); assert.ok( layers.every( ( layer ) => layer === 3 ) );

} );

test( 'SDK snatch applies native leader pursuit and reports its later factual outcome', () => {

	const squad = { id: 1, members: [ 1 ], center: [ 0, 0 ] }, targetGroup = { id: 2, leaderPos: [ 40, 5 ], leaderState: 'active' };
	const squadHandle = Object.freeze( { id: 'guard', kind: 'squad', run: 1 } ), person = Object.freeze( { id: 'leader', kind: 'person', run: 1 } );
	const actorRecord = { handle: squadHandle, backend: [ squad ] }, calls = [];
	const targetRecord = { actor: { id: 'march' }, backend: { group: targetGroup }, sample: { status: 'active', leader: true, identified: true } };
	const runtime = { run: 1, actors: new Map( [ [ squadHandle.id, actorRecord ] ] ),
		identity: { personRecord: () => targetRecord }, event: ( type, value ) => calls.push( { type, ...value } ) };
	const world = { intel: { faction: () => FACTION.POLICE }, snatch( groups, target, time ) { calls.push( { type: 'native-snatch', groups, target, time } ); groups[ 0 ].snatch = target; },
		endSnatch() {}, setMode() {} };
	const adapter = new ScenarioEngine( { world, runtime, t: 12 } ), request = { id: 'snatch', operation: '1:4', source: 'player', at: [ 40, 5 ], target: { person, actor: targetRecord.actor } };
	const result = adapter.applyCommand( request, [ [ squad ] ], { groups: [ squad ], target: request.target, applied: false }, () => true );
	assert.equal( calls[ 0 ].type, 'native-snatch' ); assert.equal( calls[ 0 ].time, 12 );
	assert.equal( result.status, 'completed' ); assert.deepEqual( result.value.affected, [ squadHandle ] );
	assert.deepEqual( adapter.snatchOutcome( squad, targetGroup, 'detained' ), { operation: '1:4', squad: squadHandle,
		target: person, type: 'snatch.completed', result: 'detained' } );

} );