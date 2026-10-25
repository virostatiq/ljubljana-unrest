import assert from 'node:assert/strict';
import test from 'node:test';
import { World, SNATCH_GIVEUP, SNATCH_REFIELD } from '../src/sim/world.ts';
import { FACTION, MODE } from '../src/sim/crowd.ts';

// two 10-officer squads (agents 0–19) and a protester leader (agent 20)
function snatchFixture() {

	const n = 21, pos = new Float32Array( n * 2 ), st = new Float32Array( n * 4 );
	for ( let i = 0; i < 20; i ++ ) st[ i * 4 ] = FACTION.POLICE;
	st[ 20 * 4 ] = FACTION.PROTESTER;
	const writes = [], fields = [];
	const world = Object.create( World.prototype );
	Object.assign( world, {
		groups: [], intel: { pos, st },
		crowd: { count: n, setGroup: ( id, value ) => writes.push( { id, ...value } ), setOffsets() {} },
		flow: { retain() {}, release() {} },
		fieldTo: ( x, y, r ) => { fields.push( [ x, y, r ] ); return Promise.resolve( fields.length ); },
	} );
	const squad = ( id, at ) => ( { id, label: `Squad ${id}`, members: Array.from( { length: 10 }, ( _, k ) => ( id - 1 ) * 10 + k ), mode: MODE.FORMATION, alive: 10, center: at, anchor: at } );
	const A = squad( 1, [ 0, 0 ] ), B = squad( 2, [ 10, 0 ] );
	const target = { label: 'Students', leaderPos: [ 50, 0 ], leaderState: 'active' };
	world.groups.push( A, B );
	const put = ( i, at ) => { pos[ i * 2 ] = at[ 0 ]; pos[ i * 2 + 1 ] = at[ 1 ]; };
	put( 20, target.leaderPos );
	return { world, A, B, target, writes, fields, put, st };

}

const last = ( writes, id ) => writes.filter( ( w ) => w.id === id ).reduce( ( a, w ) => ( { ...a, ...w } ), {} );
const settle = () => new Promise( ( resolve ) => setImmediate( resolve ) );

test( 'a snatch runs the squad at the leader and remembers its post', async () => {

	const { world, A, target, writes, fields } = snatchFixture();
	world.snatch( [ A ], target, 0 );
	assert.equal( A.mode, MODE.SNATCH );
	assert.equal( ( A as any ).snatch, target );
	const w = last( writes, A.id );
	assert.equal( w.mode, MODE.SNATCH );
	assert.deepEqual( [ w.ax, w.ay ], [ 50, 0 ] );
	assert.deepEqual( ( A as any ).snatchPlan.post.at, [ 0, 0 ] );
	assert.equal( fields.length, 1 );
	await settle();
	assert.equal( ( A as any ).layer, 1 );

} );

test( 'the squad follows a moving leader every readback but takes new flow fields sparingly', async () => {

	const { world, A, target, writes, fields } = snatchFixture();
	world.snatch( [ A ], target, 0 );
	await settle();
	target.leaderPos = [ 58, 0 ]; // within SNATCH_FIELD of the field's goal: aim only
	assert.equal( world.snatchStep( A, 0.5 ), null );
	assert.deepEqual( [ last( writes, A.id ).ax, last( writes, A.id ).ay ], [ 58, 0 ] );
	assert.equal( fields.length, 1 );
	target.leaderPos = [ 80, 0 ]; // far enough, but too soon
	world.snatchStep( A, 1 );
	assert.equal( last( writes, A.id ).ax, 80 );
	assert.equal( fields.length, 1 );
	world.snatchStep( A, SNATCH_REFIELD );
	assert.equal( fields.length, 2 );
	assert.deepEqual( fields[ 1 ].slice( 0, 2 ), [ 80, 0 ] );

} );

test( 'a slow pursuit field does not accumulate requests while the leader moves', async () => {

	const { world, A, target } = snatchFixture();
	const requests = []; let resolveField;
	world.fieldTo = ( ...args ) => { requests.push( args ); return new Promise( ( resolve ) => { resolveField = resolve; } ); };
	world.snatch( [ A ], target, 0 );
	for ( let update = 1; update <= 5; update ++ ) {

		target.leaderPos = [ 50 + update * 30, 0 ]; world.snatchStep( A, SNATCH_REFIELD * update );

	}
	assert.equal( requests.length, 1 );
	resolveField( 1 ); await settle();
	world.snatchStep( A, SNATCH_REFIELD * 6 );
	assert.equal( requests.length, 2 );
	resolveField( 2 ); await settle();
	assert.equal( ( A as any ).layer, 2 );

} );

test( 'pursuit retries a full-pool request after cooldown even when the leader stops moving', async () => {

	const { world, A, target } = snatchFixture(); let requests = 0;
	world.fieldTo = () => { requests ++; if ( requests === 1 ) throw new Error( 'flow field pool exhausted' ); return Promise.resolve( 7 ); };
	world.snatch( [ A ], target, 0 );
	world.snatchStep( A, SNATCH_REFIELD / 2 ); assert.equal( requests, 1 );
	world.snatchStep( A, SNATCH_REFIELD ); await settle();
	assert.equal( requests, 2 ); assert.equal( ( A as any ).layer, 7 );

} );

test( 'cancelling and restarting pursuit cannot build up pending fields or install a stale route', async () => {

	const { world, A, target } = snatchFixture();
	let resolveField, requests = 0;
	world.fieldTo = () => { requests ++; return new Promise( ( resolve ) => { resolveField = resolve; } ); };
	world.snatch( [ A ], target, 0 );
	for ( let restart = 1; restart <= 5; restart ++ ) {

		world.endSnatch( [ A ] ); target.leaderPos = [ 50 + restart * 30, 0 ]; world.snatch( [ A ], target, restart );

	}
	assert.equal( requests, 1 );
	resolveField( 3 ); await settle(); assert.equal( ( A as any ).layer, undefined );
	world.snatchStep( A, 6 ); assert.equal( requests, 2 );
	resolveField( 4 ); await settle(); assert.equal( ( A as any ).layer, 4 );

} );

test( 'asynchronous pursuit allocation failures are handled and retried without stale goal caching', async () => {

	const { world, A, target } = snatchFixture(); let requests = 0;
	world.fieldTo = () => ++ requests === 1 ? Promise.reject( new Error( 'worker failed' ) ) : Promise.resolve( 9 );
	world.snatch( [ A ], target, 0 ); await settle();
	assert.equal( ( A as any ).snatchFieldPending, false ); assert.equal( ( A as any ).layer, undefined );
	world.snatchStep( A, SNATCH_REFIELD ); await settle();
	assert.equal( requests, 2 ); assert.equal( ( A as any ).layer, 9 );

} );

test( 'an arrested leader ends the snatch and the squad goes back to its post', async () => {

	const { world, A, target } = snatchFixture();
	world.snatch( [ A ], target, 0 );
	A.center = [ 48, 0 ];
	target.leaderState = 'arrested';
	assert.equal( world.snatchStep( A, 5 ), 'arrested' );
	assert.equal( ( A as any ).snatch, null );
	assert.equal( ( A as any ).snatchPlan, null );
	await settle();
	assert.equal( A.mode, MODE.FORMATION );
	assert.deepEqual( A.anchor, [ 0, 0 ] );

} );

test( 'a leader who goes down injured is detained once the squad reaches them', () => {

	const { world, A, target, put } = snatchFixture();
	world.snatch( [ A ], target, 0 );
	target.leaderState = 'injured';
	assert.equal( world.snatchStep( A, 1 ), null, 'still on the way' );
	put( 3, [ 51, 1 ] );
	assert.equal( world.snatchStep( A, 2 ), 'detained' );
	assert.equal( ( target as any ).leaderDetained, true );

} );

test( 'the squad gives up on a leader it cannot get near', () => {

	const { world, A, target } = snatchFixture();
	world.snatch( [ A ], target, 0 );
	A.center = [ 0, 0 ];
	assert.equal( world.snatchStep( A, SNATCH_GIVEUP - 1 ), null );
	assert.equal( world.snatchStep( A, SNATCH_GIVEUP + 1 ), 'abandoned' );
	assert.equal( ( A as any ).snatch, null );
	const { world: w2, A: A2, target: t2 } = snatchFixture();
	w2.snatch( [ A2 ], t2, 0 );
	t2.leaderState = 'gone';
	assert.equal( w2.snatchStep( A2, 1 ), 'abandoned' );

} );

test( 'any other order calls a player snatch off, but not a mission AI snatch', async () => {

	const { world, A, B, target } = snatchFixture();
	world.snatch( [ A ], target, 0 );
	await world.charge( [ A ], 5, 5 );
	assert.equal( ( A as any ).snatchPlan, null );
	assert.equal( ( A as any ).snatch, null );
	assert.equal( A.mode, MODE.CHARGE );
	( B as any ).snatch = target; // as The Court's AI does, then arrest
	await world.arrest( [ B ], ...target.leaderPos );
	assert.equal( ( B as any ).snatch, target );

} );

test( 'a squad snatching out of a cordon leaves the line its strength and re-joins it afterwards', async () => {

	const { world, A, B, target, put } = snatchFixture();
	for ( let i = 0; i < 20; i ++ ) put( i, [ - 10 + i, 0 ] );
	await world.lineSquads( [ A, B ], [ - 10, 0 ], [ 10, 0 ], world.intel.pos );
	const L = ( A as any ).cordon;
	assert.equal( L.n0, 20 );
	world.snatch( [ A ], target, 0 );
	assert.deepEqual( L.squads, [ B ] );
	assert.equal( L.n0, 10, 'the rest of the line does not count the snatch squad as losses' );
	assert.deepEqual( world.cordonCheck( 1 ), [] );
	target.leaderState = 'arrested';
	assert.equal( world.snatchStep( A, 5 ), 'arrested' );
	await settle();
	assert.equal( ( A as any ).cordon, L );
	assert.deepEqual( L.squads, [ B, A ] );
	assert.equal( L.n0, 20 );

} );
