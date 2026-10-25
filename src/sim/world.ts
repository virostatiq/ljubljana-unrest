// World: everything between the GPU crowd and a mission — spawning, groups, squad orders,
// formations, tear gas, and the periodic "intel" readback (group centroids, leaders, CCTV).
import { FACTION, MODE, ROLE } from './crowd.ts';
import { Intel } from './intel.ts';
import { Standoff } from './standoff.ts';

export type Vec2 = [ number, number ];
// a crowd group or police squad; missions attach their own bookkeeping too
export interface Group {
	id: number;
	faction: number;
	kind: string;
	label: string;
	members: number[];
	leader: number;
	layer?: number;
	mode?: number;
	anchor?: Vec2;
	center?: Vec2;
	alive?: number;
	agitation?: number;
	[ key: string ]: any;
}
// flow-field orders may run on a prepared layer and are dropped if valid() turns false while it builds
export interface OrderGuard { layer?: number, valid?: () => boolean }

export const rand = ( a, b, random = Math.random ) => a + random() * ( b - a );
export const pick = ( arr, random = Math.random ) => arr[ Math.floor( random() * arr.length ) ];
export const WATER_JET = 10, WATER_RANGE = 28; // water cannon truck: seconds per spray, reach (m)
// shield push: how far a cordon advances at most (m), its pace (m/s), how far the line's anchor may run ahead of its
// officers before it waits for them (m), and how long it leans on a crowd it cannot move before it stops (s);
// aimed further than SHIELD_TURN (rad) off straight ahead, the line first turns to face the aim, then advances
export const SHIELD_REACH = 40, SHIELD_SPEED = 0.9, SHIELD_LEAD = 3, SHIELD_STALL = 20, SHIELD_TURN = Math.PI / 18;
// snatch: how far the leader may get from the squad's flow-field goal before it takes a new one (m), how often at most
// (s: the pool of fields is small and fills while requests are in flight; between fields the squad re-aims every
// readback and runs straight at the leader from 20 m), how close the squad must be to count as on the leader's heels (m),
// and how long it chases without being so (s)
export const SNATCH_FIELD = 12, SNATCH_REFIELD = 8, SNATCH_REACH = 25, SNATCH_GIVEUP = 45;

export class World {

	declare city: any;
	declare crowd: any;
	declare flow: any;
	declare groups: Group[];
	declare places: any;
	declare marks: any;
	declare gasClouds: any[];
	declare jets: any[];
	declare wind: number[];
	declare convoyVehicles: any[];
	declare patrols: any;
	declare onFx: any;
	declare pushEvents: any[];
	declare intel: Intel;
	declare standoff: Standoff;
	declare started: boolean;
	declare _net: Uint8Array<ArrayBuffer>;
	declare exitLayer: any;

	constructor( city, crowd, flow ) {

		this.city = city;
		this.crowd = crowd;
		this.flow = flow;
		this.groups = []; // { id, faction, kind, label, members, leader, layer, mode }
		this.places = Object.fromEntries( city.pois.filter( ( p ) => p.kind === 'place' ).map( ( p ) => [ p.name, p.pos ] ) );
		this.marks = Object.fromEntries( city.landmarks.map( ( l ) => [ l.name, l.pos ] ) );
		this.gasClouds = []; // { x, y, r, t, ttl }
		this.jets = []; // water cannon: { x, y, angle, range, t, ttl }
		this.wind = [ 0, 0 ]; // m/s, gas clouds drift with it
		this.convoyVehicles = []; // a mission's kinematic vehicles (the VIP convoy): moving walls that provoke protesters
		this.patrols = null; // Patrols (police cars), attached by the game
		this.onFx = null; // ( kind, x, y, from ) for sound: charge, kettle, gas, water — by the player or AI police
		this.pushEvents = []; // shield pushes that ended: { type: 'done' | 'stalled', at, label } (drained by Game.onIntel)
		this.intel = null;
		this.started = false;
		this.standoff = new Standoff( this ); // crowds facing police lines (driven by Game.onIntel)

	}

	// police action at (x, y), by the player or AI police: crowds nearby get angrier (Standoff)
	provoke( kind, x, y ) { this.standoff?.provoke( kind, x, y ); }

	// ---------------------------------------------------------------- walkability (CPU copies of GPU grids)

	sdf( x, y ) {

		const { w, h } = this.city.sdf;
		const ix = Math.floor( x - this.city.bounds[ 0 ] ), iy = Math.floor( y - this.city.bounds[ 1 ] );
		if ( ix < 0 || iy < 0 || ix >= w || iy >= h ) return - 1;
		return this.city.sdfData[ iy * w + ix ] / 10;

	}

	grid( data, meta, x, y ) {

		const ix = Math.floor( ( x - this.city.bounds[ 0 ] ) / meta.res ), iy = Math.floor( ( y - this.city.bounds[ 1 ] ) / meta.res );
		if ( ix < 0 || iy < 0 || ix >= meta.w || iy >= meta.h ) return 255;
		return data[ iy * meta.w + ix ];

	}

	cost( x, y ) { return this.grid( this.city.costData, this.city.cost, x, y ); }

	cctv( x, y ) { return this.city.cctvData ? this.grid( this.city.cctvData, this.city.cctv, x, y ) % 255 : 0; }

	// random walkable point near (cx, cy); streetOnly keeps it out of courtyards
	spot( cx, cy, r, streetOnly = true, random = Math.random ) {

		for ( let t = 0; t < 400; t ++ ) {

			const a = random() * Math.PI * 2, d = Math.sqrt( random() ) * r * ( 1 + t / 100 );
			const x = cx + Math.cos( a ) * d, y = cy + Math.sin( a ) * d;
			if ( this.sdf( x, y ) > 0.7 && this.cost( x, y ) < ( streetOnly ? 21 : 255 ) ) return [ x, y ];

		}

		return [ cx, cy ];

	}

	// nearest point on the connected street network (roads and squares, ≥ 2 m clear) — where squads
	// start, so they are never boxed into a courtyard or a dead-end pocket
	roadSpot( x, y, maxR = 120 ) {

		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds;
		const net = this.streetNet;
		const q0 = Math.floor( ( x - x0 ) / res ), r0 = Math.floor( ( y - y0 ) / res );
		for ( let d = 0; d * res <= maxR; d ++ ) {

			let best = null, bd = Infinity;
			for ( let r = r0 - d; r <= r0 + d; r ++ ) for ( let q = q0 - d; q <= q0 + d; q ++ ) {

				if ( Math.max( Math.abs( r - r0 ), Math.abs( q - q0 ) ) !== d || q < 0 || r < 0 || q >= w || r >= h || ! net[ r * w + q ] ) continue;
				const cx = x0 + ( q + 0.5 ) * res, cy = y0 + ( r + 0.5 ) * res, dd = ( cx - x ) ** 2 + ( cy - y ) ** 2;
				if ( dd < bd ) { bd = dd; best = [ cx, cy ]; }

			}

			if ( best ) return best;

		}

		return null;

	}

	// a line across the street at (x, y), wall to wall: the direction with the shortest clear span
	across( x, y, max = 30 ) {

		const free = ( dx, dy ) => { let d = 0; while ( d < max && this.sdf( x + dx * d, y + dy * d ) > 0.6 ) d += 0.5; return d; };
		let best = null;
		for ( let k = 0; k < 24; k ++ ) {

			const t = k / 24 * Math.PI, dx = Math.cos( t ), dy = Math.sin( t );
			const l = free( dx, dy ), r = free( - dx, - dy );
			if ( ! best || l + r < best.w ) best = { w: l + r, a: [ x - dx * r, y - dy * r ], b: [ x + dx * l, y + dy * l ] };

		}

		return [ best.a, best.b ];

	}

	// largest connected set of street cells (cost ≤ 12 = roads, pedestrian streets and squares)
	get streetNet() {

		if ( this._net ) return this._net;
		const { w, h, res } = this.city.cost, [ x0, y0 ] = this.city.bounds;
		const ok = new Uint8Array( w * h );
		for ( let r = 0; r < h; r ++ ) for ( let q = 0; q < w; q ++ ) {

			if ( this.city.costData[ r * w + q ] <= 12 && this.sdf( x0 + ( q + 0.5 ) * res, y0 + ( r + 0.5 ) * res ) >= 2 ) ok[ r * w + q ] = 1;

		}

		const comp = new Int32Array( w * h ).fill( - 1 ), size = [], stack = [];
		for ( let s = 0; s < w * h; s ++ ) {

			if ( ! ok[ s ] || comp[ s ] >= 0 ) continue;
			const id = size.length;
			let n = 0;
			comp[ s ] = id;
			stack.push( s );
			while ( stack.length ) {

				const c = stack.pop(), cq = c % w, cr = ( c - cq ) / w;
				n ++;
				for ( const [ dq, dr ] of [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ] ) {

					const q = cq + dq, r = cr + dr, nb = r * w + q;
					if ( q < 0 || r < 0 || q >= w || r >= h || ! ok[ nb ] || comp[ nb ] >= 0 ) continue;
					comp[ nb ] = id;
					stack.push( nb );

				}

			}

			size.push( n );

		}

		const main = size.indexOf( Math.max( ...size ) );
		this._net = ok.map( ( _, k ) => ( comp[ k ] === main ? 1 : 0 ) );
		return this._net;

	}

	// ---------------------------------------------------------------- flow fields

	field( key, x, y, r = 12, pinned = false ) {

		return this.flow.request( key, [ { x, y, r } ], { pinned } );

	}

	fieldTo( x, y, r = 12 ) {

		return this.field( `p:${Math.round( x / 6 )}:${Math.round( y / 6 )}:${Math.round( r )}`, x, y, r );

	}

	// one shared field toward every way out of the area (map-edge streets, station, bus station)
	async exits() {

		if ( this.exitLayer !== undefined ) return this.exitLayer;
		const goals = this.city.entries.map( ( e ) => ( { x: e.pos[ 0 ], y: e.pos[ 1 ], r: 14 } ) );
		const st = this.marks[ 'Železniška postaja' ];
		if ( st ) goals.push( { x: st[ 0 ], y: st[ 1 ], r: 25 } );
		this.exitLayer = await this.flow.request( 'exits', goals, { pinned: true } );
		this.crowd.u.exitLayer.value = this.exitLayer;
		return this.exitLayer;

	}

	setLayer( g, layer ) {

		if ( g.layer === layer ) return;
		if ( g.layer !== undefined ) this.flow.release( g.layer );
		this.flow.retain( layer );
		g.layer = layer;
		this.crowd.setGroup( g.id, { layer } );

	}

	// ---------------------------------------------------------------- spawning

	newGroup( faction, kind, label? ): Group {

		if ( this.groups.length >= this.crowd.G ) throw new Error( 'group capacity exceeded' );
		const g: Group = { id: this.groups.length, faction, kind, label: label ?? kind, members: [], leader: - 1 };
		this.groups.push( g );
		return g;

	}

	_add( agents ) {

		return this.started ? this.crowd.spawn( agents ) : this.crowd.addAgents( agents );

	}

	// A bloc of civilian groups (protesters / counter-protesters / bystanders), each with a leader.
	async bloc( { faction = FACTION.PROTESTER, kind, label, at, n, groupSize = 100, spread = 40, goal, goalR = 25,
		layer, mode = MODE.MARCH, agitation = [ 0.05, 0.25 ] as Vec2, resolve = [ 0.6, 1.0 ] as Vec2, morale = 0.5, speed = [ 0.85, 1.15 ] as Vec2,
		sitters = false, bikes = 0, random = Math.random } ) { // bikes: share of the bloc on bicycles (0..1)

		if ( layer === undefined ) layer = goal ? await this.fieldTo( goal[ 0 ], goal[ 1 ], goalR ) : 0;
		const out = [];
		for ( let k = 0; k * groupSize < n; k ++ ) {

			const g = this.newGroup( faction, kind, label );
			const [ gx, gy ] = this.spot( at[ 0 ], at[ 1 ], spread, true, random );
			const size = Math.min( groupSize, n - k * groupSize );
			const agents = [];
			for ( let m = 0; m < size; m ++ ) {

				const [ x, y ] = this.spot( gx, gy, ( 4 + Math.sqrt( size ) * 0.9 ) * ( bikes ? 1.7 : 1 ), true, random );
				const role = ( sitters ? ROLE.SITTER : m === 0 && faction !== FACTION.BYSTANDER ? ROLE.LEADER : ROLE.MEMBER ) + ( random() < bikes ? ROLE.BIKE : 0 );
				agents.push( { x, y, faction, group: g.id, role, agitation: rand( ...agitation, random ), resolve: rand( ...resolve, random ) } );

			}

			this._add( agents );
			g.members = agents.filter( ( a ) => a.index !== undefined ).map( ( a ) => a.index );
			g.leader = g.members[ 0 ];
			g.mode = mode;
			this.crowd.setGroup( g.id, { leader: g.leader, speed: rand( ...speed, random ), mode, scale: 1, morale } );
			this.setLayer( g, layer );
			out.push( g );

		}

		return out;

	}

	// Civilian groups at given points, in order (a sit-in grid, a ring of supporters): consecutive runs of groupSize
	// points make one group each, the first agent leads it (unless everyone sits).
	async placeBloc( { faction = FACTION.PROTESTER, kind, label, points, groupSize = 80, layer = 0, mode = MODE.HOLD,
		agitation = [ 0.05, 0.25 ] as Vec2, resolve = [ 0.6, 1.0 ] as Vec2, morale = 0.5, sitters = false } ) {

		const out = [];
		for ( let k = 0; k < points.length; k += groupSize ) {

			const g = this.newGroup( faction, kind, label );
			const agents = points.slice( k, k + groupSize ).map( ( [ x, y ], m ) => ( { x, y, faction, group: g.id,
				role: sitters ? ROLE.SITTER : m === 0 ? ROLE.LEADER : ROLE.MEMBER, agitation: rand( ...agitation ), resolve: rand( ...resolve ) } ) );
			this._add( agents );
			g.members = agents.filter( ( a ) => a.index !== undefined ).map( ( a ) => a.index );
			g.leader = g.members[ 0 ];
			g.mode = mode;
			this.crowd.setGroup( g.id, { leader: g.leader, speed: rand( 0.85, 1.15 ), mode, scale: 1, morale } );
			this.setLayer( g, layer );
			out.push( g );

		}

		return out;

	}

	// Police squad in formation around (ax, ay): offsets relative to the anchor.
	async squad( { kind = 'squad', label, at, n = 24, offsets, aggression = 0.4, mode = MODE.FORMATION, random = Math.random } ) {

		const [ ax, ay ] = this.roadSpot( ...( at as [ number, number ] ) ) ?? at;
		offsets = offsets ?? World.block( n );
		const g = this.newGroup( FACTION.POLICE, kind, label );
		const agents = [];
		for ( let m = 0; m < offsets.length / 2; m ++ ) {

			const [ x, y ] = this.spot( ax + offsets[ m * 2 ], ay + offsets[ m * 2 + 1 ], 3, true, random );
			agents.push( { x, y, faction: FACTION.POLICE, group: g.id, role: m === 0 ? ROLE.LEADER : ROLE.MEMBER, ox: offsets[ m * 2 ], oy: offsets[ m * 2 + 1 ] } );

		}

		this._add( agents );
		g.members = agents.map( ( a ) => a.index );
		g.leader = g.members[ 0 ];
		g.mode = mode;
		g.anchor = [ ax, ay ];
		this.crowd.setGroup( g.id, { leader: g.leader, speed: 1, mode, ax, ay, scale: 1, aggression } );
		if ( this.started ) this.crowd.setOffsets( g.members, offsets );
		this.setLayer( g, await this.fieldTo( ax, ay, 15 ) );
		return g;

	}

	// ---------------------------------------------------------------- formations (offset lists)

	static block( n, spacing = 0.9 ) {

		const cols = Math.ceil( Math.sqrt( n * 2 ) ), out = [];
		const rows = Math.ceil( n / cols );
		for ( let k = 0; k < n; k ++ ) out.push( ( k % cols - ( cols - 1 ) / 2 ) * spacing, ( Math.floor( k / cols ) - ( rows - 1 ) / 2 ) * spacing );
		return out;

	}

	static ring( n, radius, rows = 2, spacing = 0.8 ) {

		const out = [];
		const per = Math.ceil( n / rows );
		for ( let k = 0; k < n; k ++ ) {

			const row = Math.floor( k / per ), a = ( k % per ) / per * Math.PI * 2 + row * 0.03;
			const r = radius + row * spacing;
			out.push( Math.cos( a ) * r, Math.sin( a ) * r );

		}

		return out;

	}

	// ---------------------------------------------------------------- orders

	setMode( groups, mode, extra = {} ) {

		for ( const g of groups ) {

			g.mode = mode;
			this.crowd.setGroup( g.id, { mode, ...extra } );

		}

	}

	async march( groups, x, y, r = 20, { layer, valid = () => true }: OrderGuard = {} ) {

		if ( ! valid() ) return false;
		const L = layer ?? await this.fieldTo( x, y, r );
		if ( ! valid() ) return false;
		for ( const g of groups ) {

			this.setLayer( g, L );
			if ( g.mode === MODE.SIT ) continue;
			// a shield wall marches as one; pushing / storming groups keep their fire on the new heading
			g.mode = [ MODE.SHIELD, MODE.PUSH, MODE.STORM ].includes( g.mode ) ? g.mode : MODE.MARCH;
			g.goal = [ x, y ];
			this.crowd.setGroup( g.id, { mode: g.mode } );

		}

	}

	// civilians: split a group in two across its longest spread; the half without the leader follows a new one
	split( g ) {

		const I = this.intel;
		if ( ! I || g.faction === FACTION.POLICE ) return null;
		const live = g.members.filter( ( i ) => I.st[ i * 4 ] >= 0 && I.st[ i * 4 ] < 9.5 );
		if ( live.length < 8 ) return null;
		const ext = ( k ) => { let lo = Infinity, hi = - Infinity; for ( const i of live ) { lo = Math.min( lo, I.pos[ i * 2 + k ] ); hi = Math.max( hi, I.pos[ i * 2 + k ] ); } return hi - lo; };
		const k = ext( 0 ) >= ext( 1 ) ? 0 : 1;
		live.sort( ( a, b ) => I.pos[ a * 2 + k ] - I.pos[ b * 2 + k ] );
		const mid = Math.floor( live.length / 2 );
		const half = live.slice( 0, mid ).includes( g.leader ) ? live.slice( mid ) : live.slice( 0, mid );
		const out = new Set( half );
		const h = this.newGroup( g.faction, g.kind, g.label );
		h.members = half;
		h.leader = half[ 0 ];
		h.mode = g.mode;
		g.members = g.members.filter( ( i ) => ! out.has( i ) );
		for ( const i of half ) this.crowd.regroup( i, h.id, i === h.leader ? ROLE.LEADER : ROLE.MEMBER );
		const G = this.crowd.getGroup( g.id );
		this.crowd.setGroup( h.id, { leader: h.leader, speed: G.speed, mode: g.mode, scale: 1, morale: G.aggression } );
		this.setLayer( h, g.layer );
		let sx = 0, sy = 0;
		for ( const i of half ) { sx += I.pos[ i * 2 ]; sy += I.pos[ i * 2 + 1 ]; }
		h.center = [ sx / half.length, sy / half.length ];
		h.alive = half.length;
		h.agitation = g.agitation;
		g.alive = ( g.alive ?? live.length ) - half.length;
		return h;

	}

	// civilians: fold the other groups into the largest one (their leaders become members)
	merge( groups ) {

		const civ = groups.filter( ( g ) => g.faction !== FACTION.POLICE && g.members.length );
		if ( civ.length < 2 ) return null;
		const into = civ.reduce( ( a, b ) => ( ( b.alive ?? 0 ) > ( a.alive ?? 0 ) ? b : a ) );
		for ( const g of civ ) {

			if ( g === into ) continue;
			for ( const i of g.members ) this.crowd.regroup( i, into.id, ROLE.MEMBER );
			into.members.push( ...g.members );
			into.alive = ( into.alive ?? 0 ) + ( g.alive ?? 0 );
			g.members = [];
			g.alive = 0;
			if ( g.layer !== undefined ) { this.flow.release( g.layer ); g.layer = undefined; }

		}

		return into;

	}

	// police: compact blocks at a point (multiple squads side by side)
	async moveSquads( squads, x, y, { layer, valid = () => true }: OrderGuard = {} ) {

		if ( ! valid() ) return false;
		this.endSnatch( squads );
		this.uncordon( squads );
		const L = layer ?? await this.fieldTo( x, y, 12 );
		if ( ! valid() ) return false;
		const cols = Math.ceil( Math.sqrt( squads.length ) );
		squads.forEach( ( g, k ) => {

			const ax = x + ( k % cols - ( cols - 1 ) / 2 ) * 9, ay = y - ( Math.floor( k / cols ) ) * 9;
			this.crowd.setOffsets( g.members, World.block( g.members.length ) );
			this.setLayer( g, L );
			g.mode = MODE.FORMATION;
			g.anchor = [ ax, ay ];
			this.crowd.setGroup( g.id, { mode: MODE.FORMATION, ax, ay, scale: 1, aggression: 0.35 } );

		} );

	}

	// police: a cordon line from a to b shared by the squads, 2–3 deep, rows staggered; officers keep their order along it.
	// Only officers on their feet get a slot, so a line re-formed after losses has no holes. The line is
	// remembered (g.cordon, shared by its squads) for cordonCheck. keepField: a short step (officers within 30 m of
	// their slots walk straight to them), so the squads keep their flow field instead of taking a new layer.
	async lineSquads( squads, a, b, pos, cordon?, { keepField = false, layer, valid = () => true }: OrderGuard & { keepField?: boolean } = {} ) {

		if ( ! valid() ) return false;
		this.endSnatch( squads );
		this.uncordon( squads.filter( ( g ) => ! cordon || g.cordon !== cordon ) );
		const mx = ( a[ 0 ] + b[ 0 ] ) / 2, my = ( a[ 1 ] + b[ 1 ] ) / 2;
		let dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ];
		const len = Math.max( 4, Math.hypot( dx, dy ) );
		dx /= len; dy /= len;
		const nx = - dy, ny = dx; // facing
		const st = this.intel?.st;
		const officers = squads.flatMap( ( g ) => g.members ).filter( ( i ) => ! st || st[ i * 4 ] === FACTION.POLICE );
		if ( cordon ) for ( const g of squads ) if ( ! cordon.squads.includes( g ) ) cordon.n0 += this.standing( g ); // joining it
		cordon = cordon ?? { n0: officers.length, len0: len, closed: 0, retreatAt: - 1e9 }; // strength and length when formed
		Object.assign( cordon, { a, b, squads: [ ...squads ], braced: false } ); // shields go up again once it stands (cordonCheck)
		for ( const g of squads ) g.cordon = cordon;
		const rows = Math.max( 1, Math.min( 4, Math.ceil( officers.length * 0.75 / len ) ) );
		const per = Math.ceil( officers.length / rows );
		const order = officers.map( ( i ) => [ i, pos ? ( pos[ i * 2 ] - mx ) * dx + ( pos[ i * 2 + 1 ] - my ) * dy : 0 ] ).sort( ( p, q ) => p[ 1 ] - q[ 1 ] );
		const offs = [];
		order.forEach( ( _, k ) => {

			// odd rows stand half a gap along, covering the gaps of the row in front
			const col = Math.floor( k / rows ), row = k % rows;
			const t = ( per > 1 ? ( col + ( row % 2 ) * 0.5 ) / ( per - 1 ) - 0.5 : 0 ) * len;
			offs.push( dx * t - nx * row * 0.8, dy * t - ny * row * 0.8 );

		} );
		this.crowd.setOffsets( order.map( ( o ) => o[ 0 ] ), offs );
		const L = keepField ? null : layer ?? await this.fieldTo( mx, my, Math.min( len / 2, 25 ) );
		if ( ! valid() ) return false;
		const mode = cordon.push ? MODE.SHOVE : MODE.FORMATION; // closing ranks mid-push: the line keeps pushing
		for ( const g of squads ) {

			if ( L !== null ) this.setLayer( g, L );
			g.mode = mode;
			g.anchor = [ mx, my ];
			this.crowd.setGroup( g.id, { mode, ax: mx, ay: my, scale: 1, aggression: 0.35 } );

		}

	}

	// police: encircle (x, y); ring slots assigned by bearing so lines do not cross while forming
	async kettle( squads, x, y, radius, pos, { tighten = 0.5, layer, valid = () => true }: OrderGuard & { tighten?: number } = {} ) {

		if ( ! valid() ) return false;
		this.endSnatch( squads );
		this.uncordon( squads );
		this.onFx?.( 'kettle', x, y );
		this.provoke?.( 'kettle', x, y );
		const officers = squads.flatMap( ( g ) => g.members );
		const rows = Math.max( 1, Math.ceil( officers.length * 0.8 / ( 2 * Math.PI * radius ) ) );
		const idx = officers.map( ( i ) => [ i, Math.atan2( pos[ i * 2 + 1 ] - y, pos[ i * 2 ] - x ) ] )
			.sort( ( a, b ) => a[ 1 ] - b[ 1 ] ).map( ( b ) => b[ 0 ] );
		const cols = Math.ceil( officers.length / rows );
		const offs = [];
		for ( let k = 0; k < officers.length; k ++ ) {

			const row = k % rows, col = Math.floor( k / rows );
			const a = col / cols * Math.PI * 2 - Math.PI;
			offs.push( Math.cos( a ) * ( radius + row * 0.8 ), Math.sin( a ) * ( radius + row * 0.8 ) );

		}

		this.crowd.setOffsets( idx, offs );
		const L = layer ?? await this.fieldTo( x, y, radius + 10 );
		if ( ! valid() ) return false;
		for ( const g of squads ) {

			this.setLayer( g, L );
			g.mode = MODE.FORMATION;
			g.anchor = [ x, y ];
			g.tighten = { t: 0, to: tighten };
			this.crowd.setGroup( g.id, { mode: MODE.FORMATION, ax: x, ay: y, scale: 1, aggression: 0.6 } );

		}

	}

	async charge( squads, x, y, { layer, valid = () => true }: OrderGuard = {} ) {

		if ( ! valid() ) return false;
		this.endSnatch( squads );
		this.uncordon( squads );
		this.onFx?.( 'charge', x, y );
		this.provoke?.( 'charge', x, y );
		const L = layer ?? await this.fieldTo( x, y, 6 );
		if ( ! valid() ) return false;
		for ( const g of squads ) {

			this.setLayer( g, L );
			g.mode = MODE.CHARGE;
			g.tighten = null;
			this.crowd.setGroup( g.id, { mode: MODE.CHARGE, ax: x, ay: y, aggression: 1.0 } );

		}

	}

	// arrest squads wade in toward (x, y) and restrain whoever they hold; low force, slow. aim: the exact target when
	// (x, y, r) is a coarse field shared by several chasers (they follow it into r, then make for aim)
	async arrest( squads, x, y, r = 5, aim = null, { layer, valid = () => true }: OrderGuard = {} ) {

		if ( ! valid() ) return false;
		this.endSnatch( squads );
		this.uncordon( squads );
		const L = layer ?? await this.fieldTo( x, y, r );
		if ( ! valid() ) return false;
		const [ ax, ay ] = aim ?? [ x, y ];
		this.provoke?.( 'arrest', ax, ay );
		for ( const g of squads ) {

			this.setLayer( g, L );
			g.mode = MODE.ARREST;
			g.tighten = null;
			g.arrestAt = [ ax, ay ];
			this.crowd.setGroup( g.id, { mode: MODE.ARREST, ax, ay, aggression: 0.3 } );

		}

	}

	// a squad leaving a line takes its officers off the line's strength, so the rest do not read it as losses
	uncordon( squads ) {

		for ( const g of squads ) {

			if ( ! g.cordon ) continue;
			g.cordon.squads = g.cordon.squads.filter( ( q ) => q !== g );
			g.cordon.n0 = Math.max( 0, g.cordon.n0 - this.standing( g ) );
			g.cordon = null;

		}

	}

	// officers of a squad on their feet (per the last intel readback)
	standing( g ) {

		const st = this.intel?.st;
		return st ? g.members.filter( ( i ) => st[ i * 4 ] === FACTION.POLICE ).length : g.members.length;

	}

	// the player's snatch squad: the squads run at target's leader (MODE.SNATCH) and remember their post (where they stood,
	// or their cordon line) to go back to. snatchStep follows the leader on every intel readback; any other order calls
	// the snatch off (endSnatch).
	snatch( squads, target, now ) {

		this.endSnatch( squads );
		for ( const g of squads ) {

			const post = g.cordon ? { cordon: g.cordon } : { at: [ ...( g.anchor ?? g.center ?? target.leaderPos ) ] };
			g.snatchPlan = { post, since: now, close: now, fieldAt: - Infinity, field: null };
			g.snatch = target;

		}

		this.uncordon( squads );
		for ( const g of squads ) g.tighten = null;
		this.setMode( squads, MODE.SNATCH, { aggression: 0.3 } );
		if ( target.leaderPos ) this.provoke?.( 'snatch', ...( target.leaderPos as [ number, number ] ) );
		this._chase( squads, now );

	}

	// aim the squads at their leader where they are now (cheap) and take a new flow field only when the leader has got
	// SNATCH_FIELD from the last one, at most every SNATCH_REFIELD s (the pool of fields is small)
	_chase( squads, now ) {

		for ( const g of squads ) {

			const S = g.snatchPlan, p = g.snatch.leaderPos;
			g.arrestAt = p;
			this.crowd.setGroup( g.id, { ax: p[ 0 ], ay: p[ 1 ] } );
			if ( g.snatchFieldPending ) continue;
			if ( S.field && Math.hypot( p[ 0 ] - S.field[ 0 ], p[ 1 ] - S.field[ 1 ] ) <= SNATCH_FIELD ) continue;
			if ( now - S.fieldAt < SNATCH_REFIELD ) continue;
			S.fieldAt = now;
			const at = [ ...p ];
			let field;
			try { field = this.fieldTo( p[ 0 ], p[ 1 ], SNATCH_FIELD ); } catch { continue; } // pool full: run straight at them for now
			g.snatchFieldPending = true;
			field.then( ( layer ) => {

				if ( g.snatchPlan !== S ) return;
				this.setLayer( g, layer ); S.field = at;

			}, () => {} ).finally( () => { g.snatchFieldPending = false; } );

		}

	}

	// a snatch squad, once per intel readback -> 'arrested' | 'detained' (the leader went down injured and the squad
	// reached them) | 'abandoned' (leader gone, squad wiped out, or SNATCH_GIVEUP s without getting within SNATCH_REACH)
	// when it ends, and the squad heads back to its post; null while it goes on
	snatchStep( g, now ) {

		const S = g.snatchPlan, t = g.snatch;
		if ( ! S ) return null;
		const p = t.leaderPos;
		if ( g.center && Math.hypot( g.center[ 0 ] - p[ 0 ], g.center[ 1 ] - p[ 1 ] ) < SNATCH_REACH ) S.close = now;
		let end = null;
		if ( t.leaderState === 'arrested' ) end = 'arrested';
		else if ( t.leaderState === 'injured' ) {

			if ( this.countNear( p[ 0 ], p[ 1 ], 2.5, FACTION.POLICE ) > 0 ) { t.leaderDetained = true; end = 'detained'; }

		} else if ( t.leaderState !== 'active' || ! g.alive ) end = 'abandoned';
		if ( ! end && now - S.close > SNATCH_GIVEUP ) end = 'abandoned';
		if ( end ) { this.endSnatch( [ g ], { back: true } ); return end; }
		this._chase( [ g ], now );
		return null;

	}

	// call off the snatch of any of the squads (the player's; others' are left alone); back: they return to their post,
	// re-joining their cordon line where it is now
	endSnatch( squads, { back = false } = {} ) {

		for ( const g of squads ) {

			const S = g.snatchPlan;
			if ( ! S ) continue;
			g.snatchPlan = null;
			g.snatch = null;
			if ( ! back ) continue;
			const L = S.post.cordon;
			if ( L ) this.lineSquads( [ ...L.squads, g ], L.a, L.b, this.intel?.pos, L );
			else this.moveSquads( [ g ], ...( S.post.at as [ number, number ] ) );

		}

	}

	// shield push: where the cordon of the selected squads would end up for a cursor at (x, y), at most SHIELD_REACH.
	// Within SHIELD_TURN of straight ahead (either side) it goes straight along its normal; otherwise toward the
	// cursor, after turning about its centre to face it (turn: the line it re-forms on first). null if none of them
	// stands in a line.
	pushAim( squads, x, y ) {

		const L = squads.find( ( g ) => g.cordon )?.cordon;
		if ( ! L ) return null;
		const [ a, b ] = [ L.a, L.b ];
		const mx = ( a[ 0 ] + b[ 0 ] ) / 2, my = ( a[ 1 ] + b[ 1 ] ) / 2;
		const len = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) || 1;
		let nx = - ( b[ 1 ] - a[ 1 ] ) / len, ny = ( b[ 0 ] - a[ 0 ] ) / len;
		let d = ( x - mx ) * nx + ( y - my ) * ny;
		if ( d < 0 ) { nx = - nx; ny = - ny; d = - d; }
		const r = Math.hypot( x - mx, y - my );
		let turn = null;
		if ( d < r * Math.cos( SHIELD_TURN ) ) {

			// a → b runs so that the line faces n (lineSquads: facing is ( - dy, dx )), front rank toward the aim
			const angle = Math.acos( d / r ), h = len / 2;
			nx = ( x - mx ) / r; ny = ( y - my ) / r; d = r;
			turn = { angle, a: [ mx - ny * h, my + nx * h ], b: [ mx + ny * h, my - nx * h ] };

		}

		d = Math.min( SHIELD_REACH, d );
		const [ a0, b0 ] = turn ? [ turn.a, turn.b ] : [ a, b ];
		return { L, mid: [ mx, my ], n: [ nx, ny ], d, turn, a: [ a0[ 0 ] + nx * d, a0[ 1 ] + ny * d ], b: [ b0[ 0 ] + nx * d, b0[ 1 ] + ny * d ] };

	}

	// the cordon advances shields up, a bulldozer: its anchor moves straight ahead at SHIELD_SPEED and waits whenever
	// the officers fall SHIELD_LEAD behind it (a crowd too dense to move). Aimed off its normal, it first re-forms
	// turned about its centre and advances once lineFormed (or after the time the ends need to swing round).
	// The whole line goes, whichever of its squads were selected. Any other order to a squad takes it off the
	// line and out of the push (uncordon).
	shieldPush( squads, x, y ) {

		const P = this.pushAim( squads, x, y );
		if ( ! P || P.d < 2 ) return null;
		const { L } = P;
		const turn = P.turn ? { t: 0, max: Math.min( 30, 6 + Math.hypot( L.b[ 0 ] - L.a[ 0 ], L.b[ 1 ] - L.a[ 1 ] ) / 2 * P.turn.angle / 0.8 ) } : null;
		L.push = { n: P.n, d: P.d, done: 0, c0: this.lineCentre( L ), stall: 0, turn };
		L.braced = false;
		this.setMode( L.squads, MODE.SHOVE );
		// same centre, so the squads keep their flow field; with L.push set the line re-forms shields up
		if ( turn ) this.lineSquads( L.squads, P.turn.a, P.turn.b, this.intel?.pos, L, { keepField: true } );
		this.onFx?.( 'shield', P.mid[ 0 ] + P.n[ 0 ] * P.d, P.mid[ 1 ] + P.n[ 1 ] * P.d );
		this.provoke?.( 'shield', P.mid[ 0 ] + P.n[ 0 ] * Math.min( P.d, 10 ), P.mid[ 1 ] + P.n[ 1 ] * Math.min( P.d, 10 ) );
		return L;

	}

	// where the officers of a line actually are (intel group centres, weighted by those on their feet)
	lineCentre( L ) {

		let sx = 0, sy = 0, n = 0;
		for ( const g of L.squads ) if ( g.center && g.alive ) { sx += g.center[ 0 ] * g.alive; sy += g.center[ 1 ] * g.alive; n += g.alive; }
		return n ? [ sx / n, sy / n ] : null;

	}

	// whether most officers of a line on their feet stand on it (within its depth), per the last intel readback
	lineFormed( L ) {

		const I = this.intel;
		if ( ! I ) return true;
		const { pos, st } = I, [ a, b ] = [ L.a, L.b ];
		const len = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) || 1;
		const dx = ( b[ 0 ] - a[ 0 ] ) / len, dy = ( b[ 1 ] - a[ 1 ] ) / len;
		let up = 0, on = 0;
		for ( const g of L.squads ) for ( const i of g.members ) {

			if ( st[ i * 4 ] !== FACTION.POLICE ) continue;
			up ++;
			const px = pos[ i * 2 ] - a[ 0 ], py = pos[ i * 2 + 1 ] - a[ 1 ];
			const t = Math.max( 0, Math.min( len, px * dx + py * dy ) );
			if ( Math.hypot( px - dx * t, py - dy * t ) < 3.5 ) on ++;

		}

		return on >= up * 0.8;

	}

	_pushStep( L, dt ) {

		const P = L.push, label = () => L.squads.map( ( g ) => g.label ).join( ' + ' );
		const stop = ( type ) => {

			L.push = null;
			for ( const g of L.squads ) if ( g.mode === MODE.SHOVE ) { g.mode = MODE.FORMATION; this.crowd.setGroup( g.id, { mode: MODE.FORMATION } ); }
			this.pushEvents.push( { type, at: [ ( L.a[ 0 ] + L.b[ 0 ] ) / 2, ( L.a[ 1 ] + L.b[ 1 ] ) / 2 ], label: label() } );

		};
		if ( ! L.squads.length ) { L.push = null; return; }
		if ( P.turn ) {

			// turning to face the aim: no advance (and no stall) until the line stands
			P.turn.t += dt;
			if ( P.turn.t < P.turn.max && ! this.lineFormed( L ) ) return;
			P.turn = null;
			P.c0 = this.lineCentre( L ) ?? P.c0;

		}

		const c = this.lineCentre( L );
		P.c0 = P.c0 ?? c;
		const moved = c && P.c0 ? ( c[ 0 ] - P.c0[ 0 ] ) * P.n[ 0 ] + ( c[ 1 ] - P.c0[ 1 ] ) * P.n[ 1 ] : P.done;
		P.stalled = P.done - moved > SHIELD_LEAD;
		if ( P.stalled ) {

			P.stall += dt;
			if ( P.stall > SHIELD_STALL ) stop( 'stalled' );
			return;

		}

		P.stall = Math.max( 0, P.stall - dt );
		const step = Math.min( SHIELD_SPEED * dt, P.d - P.done );
		P.done += step;
		const [ ox, oy ] = [ P.n[ 0 ] * step, P.n[ 1 ] * step ];
		L.a = [ L.a[ 0 ] + ox, L.a[ 1 ] + oy ];
		L.b = [ L.b[ 0 ] + ox, L.b[ 1 ] + oy ];
		const mx = ( L.a[ 0 ] + L.b[ 0 ] ) / 2, my = ( L.a[ 1 ] + L.b[ 1 ] ) / 2;
		for ( const g of L.squads ) { g.anchor = [ mx, my ]; this.crowd.setGroup( g.id, { ax: mx, ay: my } ); }
		// done when the anchor is there and the officers have (nearly) caught up
		if ( P.done >= P.d - 1e-3 ) { P.wait = ( P.wait ?? 0 ) + dt; if ( P.done - moved < 1.5 || P.wait > 8 ) stop( 'done' ); }

	}

	// Cordon lines under pressure, once per intel readback. Officers down (injured) as a share of the line:
	// ≥ 15 % → close ranks (re-form shorter and deeper over the survivors, again every further 8 %);
	// ≥ 30 % → the whole line falls back ~25 m away from the crowd (further if they are still close)
	// and re-forms there, counting from its new strength. brace: a line standing (not pushing) with most officers in
	// place raises shields (MODE.BRACE) until it re-forms or moves. Returns [ { type: 'close' | 'retreat' | 'brace', at, label } ].
	cordonCheck( now, { brace = false } = {} ) {

		const I = this.intel;
		if ( ! I ) return [];
		const { pos, st } = I, out = [];
		const lines = new Set( this.groups.filter( ( g ) => g.cordon ).map( ( g ) => g.cordon ) );
		for ( const L of lines ) {

			let up = 0;
			for ( const g of L.squads ) for ( const i of g.members ) if ( st[ i * 4 ] === FACTION.POLICE ) up ++;

			if ( up < 4 ) continue;
			const lost = 1 - up / Math.max( L.n0, up );
			const [ a, b ] = [ L.a, L.b ];
			const mx = ( a[ 0 ] + b[ 0 ] ) / 2, my = ( a[ 1 ] + b[ 1 ] ) / 2;
			const len = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) || 1;
			const dx = ( b[ 0 ] - a[ 0 ] ) / len, dy = ( b[ 1 ] - a[ 1 ] ) / len;
			const label = L.squads.map( ( g ) => g.label ).join( ' + ' );
			// shorter with the survivors, a little deeper than when formed
			const len2 = Math.max( 6, L.len0 * up / L.n0 * 0.9 );
			if ( lost >= 0.3 && now - L.retreatAt > 20 ) {

				// away from the crowd: which side of the line has more civilians within 30 m
				let side = 0;
				for ( let i = 0; i < this.crowd.count; i ++ ) {

					const f = st[ i * 4 ];
					if ( f !== FACTION.PROTESTER && f !== FACTION.COUNTER ) continue;
					const px = pos[ i * 2 ] - mx, py = pos[ i * 2 + 1 ] - my;
					if ( px * px + py * py > 900 ) continue;
					side += Math.sign( - px * dy + py * dx );

				}

				const nx = - dy * ( side > 0 ? - 1 : 1 ), ny = dx * ( side > 0 ? - 1 : 1 );
				let d = 25, c = [ mx + nx * d, my + ny * d ];
				const hostile = ( p ) => this.countNear( p[ 0 ], p[ 1 ], 12, FACTION.PROTESTER ) + this.countNear( p[ 0 ], p[ 1 ], 12, FACTION.COUNTER );
				while ( d < 50 && hostile( c ) > 5 ) { d += 5; c = [ mx + nx * d, my + ny * d ]; }
				c = this.roadSpot( ...( c as [ number, number ] ), 30 ) ?? c;
				const h = len2 / 2;
				L.retreatAt = now;
				L.n0 = up;
				L.len0 = len2;
				L.closed = 0;
				L.push = null; // a line that breaks stops pushing
				this.lineSquads( L.squads, [ c[ 0 ] - dx * h, c[ 1 ] - dy * h ], [ c[ 0 ] + dx * h, c[ 1 ] + dy * h ], pos, L );
				out.push( { type: 'retreat', at: c, label } );

			} else if ( lost >= 0.15 && lost >= L.closed + 0.08 ) {

				const h = len2 / 2;
				L.closed = lost;
				this.lineSquads( L.squads, [ mx - dx * h, my - dy * h ], [ mx + dx * h, my + dy * h ], pos, L );
				out.push( { type: 'close', at: [ mx, my ], label } );

			} else if ( brace && ! L.push && ! L.braced && this.lineFormed( L ) ) {

				L.braced = true;
				this.setMode( L.squads, MODE.BRACE );
				out.push( { type: 'brace', at: [ mx, my ], label } );

			}

		}

		return out;

	}

	gas( x, y ) {

		this.gasClouds.push( { x, y, r: 6, t: 0, ttl: 28 } );
		this.onFx?.( 'gas', x, y );
		this.provoke?.( 'gas', x, y );

	}

	// a water cannon truck (patrols, `water`) sprays along angle for WATER_JET s; the jet moves with the truck
	spray( truck, angle ) {

		truck.aim = angle;
		const j: any = { x: truck.x, y: truck.y, angle, range: WATER_RANGE, t: 0, ttl: WATER_JET, truck };
		this.jets.push( j );
		this._jetAt( j );
		j.from = [ j.x, j.y ]; // the sound's handle for this jet (it stays while the jet lasts, wherever the truck goes)
		this.onFx?.( 'water', j.x + Math.cos( angle ) * 20, j.y + Math.sin( angle ) * 20, j.from );
		this.provoke?.( 'water', j.x + Math.cos( angle ) * 20, j.y + Math.sin( angle ) * 20 );

	}

	// the jet leaves the turret just clear of the truck's body (the cone only hits what is in front of its origin)
	_jetAt( j ) {

		j.x = j.truck.x + Math.cos( j.angle ) * 3;
		j.y = j.truck.y + Math.sin( j.angle ) * 3;

	}

	// ---------------------------------------------------------------- per-frame

	update( dt, stats ) {

		this.patrols?.update( dt, stats, this.convoyVehicles.length );
		this.crowd.setVehicles( [ ...this.convoyVehicles, ...( this.patrols?.vehicles() ?? [] ) ], this.convoyVehicles.length );
		for ( const g of this.groups ) {

			if ( g.tighten && g.tighten.t < 1 ) {

				g.tighten.t = Math.min( 1, g.tighten.t + dt / 50 );
				this.crowd.setGroup( g.id, { scale: 1 + ( g.tighten.to - 1 ) * g.tighten.t } );

			}

		}

		const pushing = new Set<any>();
		for ( const g of this.groups ) if ( g.cordon?.push ) pushing.add( g.cordon );
		for ( const L of pushing ) this._pushStep( L, dt );

		for ( const c of this.gasClouds ) {

			c.t += dt;
			c.x += this.wind[ 0 ] * dt;
			c.y += this.wind[ 1 ] * dt;
			c.r = Math.min( 24, 6 + c.t * 3 );

		}

		this.gasClouds = this.gasClouds.filter( ( c ) => c.t < c.ttl );
		this.standoff?.step( dt );
		for ( const j of this.jets ) { j.t += dt; if ( j.truck ) this._jetAt( j ); }
		this.jets = this.jets.filter( ( j ) => j.t < j.ttl );
		this.crowd.setJets( this.jets );
		this.crowd.setGas( this.gasClouds.map( ( c ) => ( { x: c.x, y: c.y, r: c.r, strength: c.t < c.ttl - 6 ? 1 : ( c.ttl - c.t ) / 6 } ) ) );

	}

	// readback of positions + states → group centroids, live counts, leader status, CCTV identification
	async refreshIntel() {

		const [ pos, st ] = await Promise.all( [ this.crowd.readPositions(), this.crowd.readState() ] );
		for ( const g of this.groups ) {

			if ( ! g.members.length ) { g.alive = 0; continue; } // merged into another group
			let sx = 0, sy = 0, n = 0, ag = 0;
			for ( const i of g.members ) {

				const f = st[ i * 4 ];
				if ( f < 0 || f > 9.5 ) continue;
				sx += pos[ i * 2 ]; sy += pos[ i * 2 + 1 ]; ag += st[ i * 4 + 2 ]; n ++;

			}

			g.alive = n;
			g.center = n ? [ sx / n, sy / n ] : g.center;
			// civilians: the anchor holds the group's centre, so the leader can wait for the rest (kernel)
			if ( n && g.faction !== FACTION.POLICE ) this.crowd.setGroup( g.id, { ax: g.center[ 0 ], ay: g.center[ 1 ] } );
			g.agitation = n ? ag / n : 0;
			const L = g.leader;
			const lf = st[ L * 4 ];
			g.leaderState = lf === FACTION.ARRESTED ? 'arrested' : lf > 9.5 ? 'injured' : lf < 0 ? 'gone' : 'active';
			g.leaderPos = [ pos[ L * 2 ], pos[ L * 2 + 1 ] ];
			const seen = ( g.faction === FACTION.PROTESTER || g.faction === FACTION.COUNTER ) && g.leaderState === 'active' && this.cctv( ...( g.leaderPos as [ number, number ] ) ) > 0;
			g.justIdentified = seen && ! g.identified;
			if ( seen ) g.identified = true;

		}

		this.intel = new Intel( pos, st );
		return this.intel;

	}

	// nearest agent of the given factions to (x, y) → its group
	groupAt( x, y, factions, radius ) {

		if ( ! this.intel ) return null;
		const { pos, st } = this.intel;
		let best = - 1, bd = radius * radius;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( ! factions.includes( st[ i * 4 ] ) ) continue;
			const d = ( pos[ i * 2 ] - x ) ** 2 + ( pos[ i * 2 + 1 ] - y ) ** 2;
			if ( d < bd ) { bd = d; best = i; }

		}

		return best >= 0 ? this.groups[ st[ best * 4 + 1 ] ] : null;

	}

	groupsOf( faction, kind ) {

		return this.groups.filter( ( g ) => g.faction === faction && ( ! kind || g.kind === kind ) && ( g.alive ?? 1 ) > 0 );

	}

	// count live agents of a faction within r of (x, y) from the last intel snapshot
	countNear( x, y, r, faction ) {

		if ( ! this.intel ) return 0;
		const { pos, st } = this.intel;
		let n = 0;
		for ( let i = 0; i < this.crowd.count; i ++ ) {

			if ( st[ i * 4 ] !== faction ) continue;
			if ( ( pos[ i * 2 ] - x ) ** 2 + ( pos[ i * 2 + 1 ] - y ) ** 2 < r * r ) n ++;

		}

		return n;

	}

}
