import { FACTION, MODE, ROLE, STAT, MAX_EDITS } from '../../sim/crowd.ts';
import { rand, WATER_JET, World } from '../../sim/world.ts';
import { Mission } from '../mission.ts';
import { Convoy } from '../convoy.ts';
import { check } from './definition.ts';
import { inPoly } from '../sdk/geometry.ts';

export class ScenarioEngine {

	declare mission: any;
	declare queue: Promise<void>;
	declare nextReinforcement: number;
	declare snatchTasks: Map<any, any>;
	declare sitters: Set<number>;
	declare sittingActors: Set<string>;
	declare wanderGroups: Map<any, readonly number[]>;
	declare scenarioShelters: Map<number, number>;

	constructor( mission ) {

		this.mission = mission;
		this.queue = Promise.resolve();
		this.nextReinforcement = 1;
		this.snatchTasks = new Map<any, any>();
		this.sitters = new Set();
		this.sittingActors = new Set();
		this.wanderGroups = new Map();
		this.scenarioShelters = new Map();

	}

	place( name ) { return this.mission.world.places[ name ]; }
	landmark( name ) { return this.mission.world.marks[ name ]; }
	sampleWalkable( at, radius, streetOnly, random ) { return this.mission.world.spot( ...at, radius, streetOnly, random ); }
	walkable( at, radius ) { return this.mission.world.roadSpot( ...at, radius ); }
	roadSpan( at, maxDistance ) { return this.mission.world.across( ...at, maxDistance ); }
	roadRoute( from, to ) {

		const patrols = this.mission.world.patrols, goal = patrols.snap( ...to ) ?? to;
		return patrols.route( from, goal );

	}
	clearance( at ) { return this.mission.world.sdf( ...at ); }
	footprint( at ) { return this.mission.city.buildings.find( ( building ) => inPoly( building.p[ 0 ], at[ 0 ], at[ 1 ] ) )?.p[ 0 ] ?? null; }
	mapRoute() { return this.mission.city.route ?? []; }
	carriageways() { return ( this.mission.city.ring ?? [] ).map( ( flat ) => Array.from( { length: flat.length / 2 }, ( _, index ) => [ flat[ index * 2 ], flat[ index * 2 + 1 ] ] ) ); }
	streetCost( at ) { return this.mission.world.cost( at[ 0 ], at[ 1 ] ); }
	cctvCoverage( at ) { return this.mission.world.cctv( at[ 0 ], at[ 1 ] ); }
	visible( from, to ) {

		const distance = Math.hypot( to[ 0 ] - from[ 0 ], to[ 1 ] - from[ 1 ] );
		for ( let along = 1; along < distance; along += 1 ) if ( this.mission.world.sdf( from[ 0 ] + ( to[ 0 ] - from[ 0 ] ) * along / distance, from[ 1 ] + ( to[ 1 ] - from[ 1 ] ) * along / distance ) <= 0 ) return false;
		return true;

	}
	ray( from, angle, range, ignoreBarriers ) {

		const { city, world } = this.mission, raw = ignoreBarriers ? city.scenarioRawSdf : null;
		for ( let distance = 2; distance < range; distance += 0.5 ) {

			const x = from[ 0 ] + Math.cos( angle ) * distance, y = from[ 1 ] + Math.sin( angle ) * distance;
			const column = Math.floor( x - city.bounds[ 0 ] ), row = Math.floor( y - city.bounds[ 1 ] );
			const clearance = raw ? column < 0 || row < 0 || column >= city.sdf.w || row >= city.sdf.h ? - 1 : raw[ row * city.sdf.w + column ] / 10 : world.sdf( x, y );
			if ( clearance < 0 ) return distance;

		}
		return range;

	}
	openBarrier( at, radius ) {

		const { city, crowd } = this.mission; if ( ! city.scenarioRawSdf ) return;
		for ( let row = Math.max( 0, Math.floor( at[ 1 ] - radius - city.bounds[ 1 ] ) ); row <= Math.min( city.sdf.h - 1, Math.ceil( at[ 1 ] + radius - city.bounds[ 1 ] ) ); row ++ ) for ( let column = Math.max( 0, Math.floor( at[ 0 ] - radius - city.bounds[ 0 ] ) ); column <= Math.min( city.sdf.w - 1, Math.ceil( at[ 0 ] + radius - city.bounds[ 0 ] ) ); column ++ ) {

			if ( Math.hypot( city.bounds[ 0 ] + column + 0.5 - at[ 0 ], city.bounds[ 1 ] + row + 0.5 - at[ 1 ] ) < radius ) city.sdfData[ row * city.sdf.w + column ] = city.scenarioRawSdf[ row * city.sdf.w + column ];

		}
		crowd.sdfTex.needsUpdate = true;

	}
	entries() { return ( this.mission.city.entries ?? [] ).map( ( entry ) => ( { name: entry.name, position: entry.pos } ) ); }
	notice( text, kind, at ) { this.mission.event( text, kind, at ); }
	coach( card ) { this.mission.game.hud.coach( card ); }
	adjustOpinion( delta, reason ) { this.mission.nudgeOpinion( delta, reason ); }
	async configureEnvironment( options ) {

		const { world, crowd, city } = this.mission;
		if ( options.wind ) world.wind = [ ...options.wind ];
		if ( options.leadersVisible !== undefined ) crowd.u.revealLeaders.value = Number( options.leadersVisible );
		for ( const key of [ 'resolveDecay', 'holdRestraint' ] ) if ( options[ key ] !== undefined ) crowd.u[ key ].value = options[ key ];
		if ( options.southExits ) { world.exitLayer = await world.flow.request( 'scenario-exits-south', city.entries.filter( ( entry ) => entry.pos[ 1 ] < 0 ).map( ( entry ) => ( { x: entry.pos[ 0 ], y: entry.pos[ 1 ], r: 14 } ) ), { pinned: true } ); crowd.u.exitLayer.value = world.exitLayer; }

	}
	configureActor( groups, options ) {

		for ( const group of groups ) {

			if ( options.speed !== undefined ) this.mission.crowd.setGroup( group.id, { speed: options.speed } );
			for ( const key of [ 'masked', 'identified', 'closed' ] ) if ( options[ key ] !== undefined ) group[ key ] = options[ key ];
			if ( options.leaderSuccession !== undefined ) group.succession = options.leaderSuccession ? null : Infinity;
			if ( options.parting === true ) this.mission.crowd.u.parting.value = group.id;
			if ( options.parting === false && this.mission.crowd.u.parting.value === group.id ) this.mission.crowd.u.parting.value = - 1;
			if ( options.home === true && ! group.home ) Mission.prototype.sendHome.call( this.mission, group );
			if ( options.home === false ) { group.home = false; for ( const member of group.members ) this.mission.crowd.recall( member, 0.3 ); }

		}
		return Object.freeze( { status: 'completed' } );

	}
	recruitActor( groups ) {

		const { crowd, world, runtime } = this.mission;
		if ( ! world.intel || groups.some( ( group ) => group.faction !== FACTION.BYSTANDER ) ) return { status: 'rejected', code: 'FACTION' };
		const members = groups.flatMap( ( group ) => group.members.filter( ( member ) => world.intel.faction( member ) === FACTION.BYSTANDER ) );
		if ( crowd.pendingEdits.length + members.length * 3 + groups.length > MAX_EDITS ) return { status: 'rejected', code: 'EDIT_CAPACITY' };
		for ( const group of groups ) {

			const live = group.members.filter( ( member ) => world.intel.faction( member ) === FACTION.BYSTANDER ); if ( ! live.length ) continue;
			Object.assign( group, { faction: FACTION.PROTESTER, kind: 'crowd', mode: MODE.MARCH, leader: live[ 0 ], leaderState: 'active' } ); this.wanderGroups.delete( group );
			for ( const [ index, member ] of live.entries() ) { crowd.regroup( member, group.id, index ? ROLE.MEMBER : ROLE.LEADER ); crowd.compareFaction( member, FACTION.BYSTANDER, FACTION.PROTESTER, group.id ); crowd.nudge( member, 0.25, 1 ); }
			crowd.setGroup( group.id, { leader: group.leader, speed: rand( 0.9, 1.15, () => runtime.random() ), mode: MODE.MARCH, morale: 0.9 } );

		}
		return { status: 'completed', people: members.length };

	}

	createConvoy( options ) {

		const route = this.mission.city.route;
		check( Array.isArray( route ) && route.length >= 2, 'convoy.route', 'the selected city has no convoy route' );
		const convoy = new Convoy( route, options );
		this.mission.game.scene.add( convoy.group );
		return convoy;

	}

	readConvoy( convoy ) {

		return { distance: convoy.s, progress: convoy.progress, speed: convoy.speed, integrity: convoy.integrity,
			blockedFor: convoy.blockedFor, blockers: convoy.blockers, attackers: convoy.attackers,
			moving: convoy.moving, arrived: convoy.arrived };

	}

	convoyPoint( convoy, distance ) { return convoy.at( distance ); }

	departConvoy( convoy ) { convoy.moving = true; }

	updateConvoy( convoy, dt ) { convoy.update( dt, this.mission.stats ); }

	updateConvoyWalls( convoys ) { this.mission.world.convoyVehicles = convoys.flatMap( ( convoy ) => convoy.vehicles() ); }

	releaseConvoy( convoy ) {

		this.mission.game.scene.remove( convoy.group );
		const resources = new Set<any>();
		convoy.group.traverse( ( object ) => {

			if ( object.geometry ) resources.add( object.geometry );
			for ( const material of Array.isArray( object.material ) ? object.material : object.material ? [ object.material ] : [] ) resources.add( material );

		} );
		for ( const resource of resources ) resource.dispose();

	}

	target( name ) {

		const target = this.mission.city.targets?.[ name ];
		return target ? { name, position: target.pos, radius: target.radius, footprints: target.poly.map( ( polygon ) => polygon[ 0 ] ), exits: target.exits } : null;

	}

	snapRoad( at ) { return this.mission.world.patrols.snap( ...at ); }

	focus( at, zoom ) {

		this.mission.focus = [ ...at ];
		this.mission.zoom = zoom;

	}

	readMetrics() {

		const { opinion, counters } = this.mission;
		return Object.freeze( { opinion, escalation: this.mission.escalation ?? 0, clashContacts: this.mission.stats?.[ STAT.CLASH ] ?? 0,
			counters: Object.freeze( { injuriesByPolice: counters.injByPolice,
			otherInjuries: counters.injOther, officersInjured: counters.injPolice, arrests: counters.arrested,
			sitterArrests: counters.arrestedSitters, peopleGone: counters.gone, gasUsed: counters.gas,
			shotsFired: counters.shot ?? 0, treatedByMedics: counters.treated ?? 0,
			peopleKilled: this.mission.stats?.[ STAT.KILLED ] ?? 0, officersKilled: this.mission.stats?.[ STAT.KILLED_POLICE ] ?? 0 } ) } );

	}

	commandApplied( request ) {

		const delta = request.opinion?.delta, reason = request.opinion?.reason;
		if ( request.id === 'gas' ) {

			this.mission.counters.gas ++;
			this.mission.nudgeOpinion( delta ?? this.mission.gasOpinion ?? - 2, reason ?? 'tear gas' );

		} else if ( request.id === 'water' ) this.mission.nudgeOpinion( delta ?? this.mission.waterOpinion ?? - 2, reason ?? 'water cannon' );

	}

	nudgePerson( backend, agitation, resolve ) {

		const { crowd, world } = this.mission;
		if ( ! world.intel || ! backend.group.members.includes( backend.member ) || world.intel.group( backend.member ) !== backend.group.id || world.intel.faction( backend.member ) < 0 || world.intel.faction( backend.member ) > 3.5 ) return { status: 'rejected', code: 'PERSON_UNAVAILABLE' };
		if ( crowd.pendingEdits.length >= MAX_EDITS ) return { status: 'rejected', code: 'EDIT_CAPACITY' };
		crowd.nudge( backend.member, agitation, resolve ); return { status: 'queued' };

	}

	applyPersonEffect( backend, status, source ) {

		const { member, group } = backend, { crowd, world } = this.mission;
		const faction = world.intel?.faction( member );
		if ( ! world.intel || ! group.members.includes( member ) || world.intel.group( member ) !== group.id || ! Number.isFinite( faction ) || faction < 0 || faction >= 30 ) return { status: 'rejected', code: 'PERSON_UNAVAILABLE' };
		if ( crowd.pendingEdits.length >= MAX_EDITS ) return { status: 'rejected', code: 'EDIT_CAPACITY' };
		const base = faction % 10;
		const next = status === 'removed' ? - 1 : status === 'detained' ? this.sitters.has( member ) ? FACTION.ARRESTED_SITTER : FACTION.ARRESTED : status === 'dead' ? 30 + base : ( source === 'police' ? 10 : 20 ) + base;
		crowd.compareFaction( member, faction, next, group.id );
		return { status: 'queued' };

	}

	setCrowdMode( groups, mode ) {

		if ( groups.some( ( group ) => ! [ FACTION.PROTESTER, FACTION.BYSTANDER, FACTION.COUNTER ].includes( group.faction ) ) ) return { status: 'rejected', code: 'FACTION' };
		this.mission.world.setMode( groups, { hold: MODE.HOLD, march: MODE.MARCH, riot: MODE.RIOT, sit: MODE.SIT, shield: MODE.SHIELD, push: MODE.PUSH, storm: MODE.STORM, panic: MODE.PANIC, disperse: MODE.DISPERSE }[ mode ] );
		return { status: 'completed' };

	}

	splitActor( groups ) {

		const world = this.mission.world, source = groups.filter( ( group ) => group.members.length );
		const total = source.reduce( ( count, group ) => count + group.members.length, 0 );
		if ( total < 8 || world.groups.length + source.length > world.crowd.G ) return { groups: source, newGroups: [] };
		const created = source.map( ( group ) => world.split( group ) ).filter( Boolean );
		return { groups: source, newGroups: created };

	}

	mergeActors( collections ) {

		const world = this.mission.world, groups = collections.flatMap( ( collection ) => collection.filter( ( group ) => group.members.length ) );
		if ( groups.length < 2 ) return { status: 'rejected', code: 'TOO_SMALL' };
		if ( ! groups.every( ( group ) => group.faction === groups[ 0 ].faction ) ) return { status: 'rejected', code: 'FACTION' };
		const merged = world.merge( groups ); if ( ! merged ) return { status: 'rejected', code: 'TOO_SMALL' };
		return { status: 'completed', groups: [ merged ], destination: collections.findIndex( ( collection ) => collection.includes( merged ) ) };

	}

	setCrowdMorale( groups, morale ) {

		if ( groups.some( ( group ) => ! [ FACTION.PROTESTER, FACTION.BYSTANDER, FACTION.COUNTER ].includes( group.faction ) ) ) return { status: 'rejected', code: 'FACTION' };
		for ( const group of groups ) this.mission.crowd.setGroup( group.id, { morale } );
		return { status: 'completed' };

	}
	recallCrowd( groups, floor ) {

		const { crowd, world } = this.mission, members = groups.flatMap( ( group ) => group.members );
		if ( ! world.intel ) return { status: 'rejected', code: 'OBSERVATION_UNAVAILABLE' };
		if ( crowd.pendingEdits.length + members.length > MAX_EDITS ) return { status: 'rejected', code: 'EDIT_CAPACITY' };
		for ( const member of members ) crowd.recall( member, floor );
		return { status: 'completed', people: members.length };

	}

	nudgeCrowd( groups, { agitation, resolve, share = 1, leaders = false, random = Math.random } ) {

		const { world, crowd } = this.mission;
		if ( ! world.intel ) return { status: 'rejected', code: 'OBSERVATION_UNAVAILABLE' };
		if ( groups.some( ( group ) => ! [ FACTION.PROTESTER, FACTION.BYSTANDER, FACTION.COUNTER ].includes( group.faction ) ) ) return { status: 'rejected', code: 'FACTION' };
		let people = 0;
		for ( const group of groups ) {

			if ( leaders ) {

				if ( group.leader >= 0 ) { crowd.nudge( group.leader, agitation, resolve ); people ++; }
				continue;

			}
			for ( const member of group.members ) if ( world.intel.faction( member ) === group.faction && ( share >= 1 || random() < share ) ) {

				crowd.nudge( member, agitation, resolve );
				people ++;

			}

		}
		return { status: 'completed', people };

	}

	spawn( kind, options, signal ) {

		const work = this.queue.then( () => this.allocate( kind, options, signal ) );
		this.queue = work.catch( () => {} );
		return work;

	}

	async allocate( kind, options, signal ) {

		const world = this.mission.world, crowd = this.mission.crowd, random = () => this.mission.runtime.random();
		signal.throwIfAborted();
		if ( kind === 'vehicle' ) {

			const at = world.patrols.snap( ...options.at );
			check( at !== null, 'spawn.vehicle.at', 'no drivable road near this position' );
			const water = options.type === 'water-cannon', van = options.type === 'prisoner-van';
			const patrol = options.type === 'police-patrol', crew = patrol ? options.crew : 0;
			check( crowd.count + crew <= crowd.N && world.groups.length + Number( crew > 0 ) <= crowd.G, 'spawn.vehicle.crew', 'crew capacity exceeded' );
			return world.patrols.add( { at, label: options.label ?? options.id, crew, selectable: options.selectable ?? ( water || patrol ),
				civil: ! water && ! patrol && ! van, water, random } );

		}
		if ( kind === 'bystanders' ) return this.allocateBystanders( options, signal );
		const groupCount = kind === 'squad' ? 1 : Math.ceil( options.people / options.groupSize );
		check( crowd.count + options.people <= crowd.N, 'spawn.people', 'agent capacity exceeded' );
		check( world.groups.length + groupCount <= crowd.G, 'spawn.people', 'group capacity exceeded' );
		const before = world.groups.length;
		try {

			const layer = kind === 'crowd' && options.speed?.[ 1 ] === 0 && options.goal === null
				? await world.exits() : await world.fieldTo( ...( options.goal ?? options.at ), options.goal ? options.goalRadius : 30 );
			signal.throwIfAborted();
			const mode = { hold: MODE.HOLD, march: MODE.MARCH, riot: MODE.RIOT, sit: MODE.SIT, shield: MODE.SHIELD, push: MODE.PUSH, storm: MODE.STORM, panic: MODE.PANIC, disperse: MODE.DISPERSE }[ options.mode ];
			const faction = { protester: FACTION.PROTESTER, bystander: FACTION.BYSTANDER, counter: FACTION.COUNTER }[ options.faction ];
			const groups = kind === 'squad'
				? [ await world.squad( { label: options.id, at: options.at, n: options.people, random } ) ]
				: options.points
					? await world.placeBloc( { kind: 'crowd', label: options.label ?? options.id, points: options.points.map( ( at ) => [ ...at ] ),
						groupSize: options.groupSize, layer, mode, agitation: options.agitation, resolve: options.resolve, morale: options.morale,
						sitters: options.mode === 'sit', faction } )
					: await world.bloc( { kind: options.medic ? 'medics' : 'crowd', label: options.label ?? options.id, at: options.at, n: options.people,
						groupSize: options.groupSize, spread: options.spread, layer, goal: options.goal, goalR: options.goalRadius,
						mode, agitation: options.agitation, resolve: options.resolve,
						morale: options.morale, bikes: options.bikes, random, faction, speed: options.speed } );
			signal.throwIfAborted();
			const S = options.standoff;
			if ( S ) for ( const group of groups ) {

				if ( S.level !== null ) group.heatStart = S.level;
				if ( S.ceiling !== null ) group.ceiling = S.ceiling;
				group.touchy = S.blows;

			}
			if ( options.mode === 'sit' ) {

				this.sittingActors.add( options.id );
				for ( const group of groups ) for ( const member of group.members ) this.sitters.add( member );

			}
			return groups;

		} catch ( error ) {

			this.release( world.groups.slice( before ) );
			throw error;

		}

	}

	async allocateBystanders( options, signal ) {

		const { world, crowd, runtime } = this.mission, before = world.groups.length, groups = [], random = () => runtime.random();
		check( crowd.count + options.people <= crowd.N, 'spawn.people', 'agent capacity exceeded' );
		check( world.groups.length + Math.ceil( options.people / options.groupSize ) <= crowd.G, 'spawn.people', 'group capacity exceeded' );
		try {

			const layers = await Promise.all( options.destinations.map( ( at, index ) => world.field( `scenario:${runtime.run}:${options.id}:wander:${index}`,
				at[ 0 ], at[ 1 ], 25 ) ) );
			signal.throwIfAborted();
			const [ minX, minY, maxX, maxY ] = this.mission.city.bounds;
			for ( let offset = 0; offset < options.people; offset += options.groupSize ) {

				signal.throwIfAborted();
				const at = [ rand( minX + 80, maxX - 80, random ), rand( minY + 80, maxY - 80, random ) ];
				const size = Math.min( options.groupSize, options.people - offset );
				const layer = layers[ Math.floor( random() * layers.length ) ];
				groups.push( ...await world.bloc( { faction: FACTION.BYSTANDER, kind: 'bystanders', label: 'Onlookers', at,
					n: size, groupSize: size, spread: options.spread, layer, speed: [ 0.7, 1.1 ], random } ) );

			}
			for ( const group of groups ) this.wanderGroups.set( group, layers );
			return groups;

		} catch ( error ) {

			this.release( world.groups.slice( before ) );
			throw error;

		}

	}

	updateAmbient( dt ) {

		for ( const group of this.mission.world.groups ?? [] ) {

			if ( group.faction === FACTION.POLICE || ( group.leaderState !== 'arrested' && ! group.leaderDetained ) || group.leaderReported ) continue;
			group.leaderReported = true;
			this.mission.crowd.setGroup( group.id, { morale: 0.15 } );
			this.mission.onLeaderArrested?.( group );

		}
		if ( ! this.wanderGroups.size ) return;
		const random = () => this.mission.runtime.random();
		if ( random() >= dt * 0.5 ) return;
		const groups = [ ...this.wanderGroups.keys() ].filter( ( group ) => group.faction === FACTION.BYSTANDER && group.members.length );
		if ( ! groups.length ) return;
		const group = groups[ Math.floor( random() * groups.length ) ], layers = this.wanderGroups.get( group );
		this.mission.world.setLayer( group, layers[ Math.floor( random() * layers.length ) ] );

	}

	setShelter( groups, until ) {

		for ( const group of groups ) this.scenarioShelters.set( group.id, until );
		this.mission.crowd.setShelter( [ ...this.scenarioShelters.keys() ] );
		return { status: 'completed' };

	}

	updateShelters() {

		let changed = false;
		for ( const [ id, until ] of this.scenarioShelters ) if ( this.mission.runtime.time >= until ) { this.scenarioShelters.delete( id ); changed = true; }
		if ( changed ) this.mission.crowd.setShelter( [ ...this.scenarioShelters.keys() ] );

	}

	observePolicies( sample ) {

		if ( this.mission._medIntel === sample ) return;
		this.mission._medIntel = sample;
		Mission.prototype.treat.call( this.mission, sample );

	}

	readActor( groups, sample ) {

		if ( groups.isCar ) return { alive: groups.alive, center: [ groups.x, groups.y ] };
		let alive = 0, sumX = 0, sumY = 0;
		// a probe out at a police line (Standoff) is still part of its crowd
		const all = groups.flatMap( ( group ) => group.standoff?.probe ? [ group, group.standoff.probeGroup ] : [ group ] );
		for ( const group of all ) for ( const member of group.members ) {

			const faction = sample.faction( member );
			if ( ! Number.isFinite( faction ) ) return null;
			if ( typeof sample.group === 'function' && sample.group( member ) !== group.id ) return null;
			if ( faction < 0 || faction > 9.5 ) continue;
			const positionX = sample.x( member ), positionY = sample.y( member );
			if ( ! Number.isFinite( positionX ) || ! Number.isFinite( positionY ) ) return null;
			alive ++;
			sumX += positionX; sumY += positionY;

		}

		return { alive, center: alive ? [ sumX / alive, sumY / alive ] : null };

	}
	protectedShielded( handle ) {

		const record = this.mission.runtime?.actors.get( handle?.id );
		return record?.handle === handle && Array.isArray( record.backend ) && record.backend.some( ( group ) => group.mode === MODE.SHIELD );

	}

	async prepareMove( groups, request, signal ) {

		signal.throwIfAborted();
		const world = this.mission.world;
		const at = request.line ? [ ( request.line[ 0 ] + request.at[ 0 ] ) / 2, ( request.line[ 1 ] + request.at[ 1 ] ) / 2 ] : request.at;
		const radius = request.line ? Math.min( Math.max( 4, Math.hypot( request.at[ 0 ] - request.line[ 0 ], request.at[ 1 ] - request.line[ 1 ] ) ) / 2, 25 )
			: groups[ 0 ].faction === FACTION.POLICE ? 12 : request.radius;
		const layer = await world.fieldTo( ...at, radius );
		signal.throwIfAborted();
		world.flow.retain( layer );
		return { layer };

	}

	readPeople( groups, sample ) {

		if ( groups.isCar ) return [];
		const people = [];
		for ( const group of groups ) for ( const member of group.members ) {

			const faction = sample.faction( member ), positionX = sample.x( member ), positionY = sample.y( member );
			if ( ! [ faction, positionX, positionY ].every( Number.isFinite ) ) return null;
			const status = faction === FACTION.ARRESTED || faction === FACTION.ARRESTED_SITTER ? 'detained'
				: faction < 0 ? 'gone' : faction > 29.5 ? 'dead' : faction > 9.5 ? 'injured' : 'active';
			people.push( { key: member, backend: Object.freeze( { member, group } ), leader: group.leader === member,
				injurySource: faction > 9.5 && faction < 19.5 ? 'police' : faction > 19.5 && faction < 29.5 ? 'other' : null,
				status, position: [ positionX, positionY ], faction: [ 'protester', 'police', 'bystander', 'counter' ][ faction >= 0 ? Math.floor( faction ) % 10 : group.faction ],
				identified: group.identified === true, agitation: typeof sample.agitation === 'function' ? sample.agitation( member ) : 0,
				membershipMatches: typeof sample.group !== 'function' || sample.group( member ) === group.id } );

		}
		return people;

	}

	promoteLeader( backend, position ) {

		const { group, member } = backend, { crowd } = this.mission;
		check( group.members.includes( member ), 'people.promote', 'person no longer belongs to this group' );
		if ( group.leader === member ) return;
		const previous = group.leader;
		if ( group.members.includes( previous ) ) crowd.regroup( previous, group.id, ROLE.MEMBER );
		crowd.regroup( member, group.id, ROLE.LEADER );
		crowd.setGroup( group.id, { leader: member } );
		group.leader = member; group.leaderState = 'active'; group.leaderPos = [ ...position ]; group.leaderReported = false;

	}

	transferPerson( backend, targets, { promote, sample } ) {

		const source = backend.group, member = backend.member, { world, crowd, game } = this.mission;
		const reject = ( code ) => Object.freeze( { status: 'rejected', code } );
		if ( ! source.members.includes( member ) || ( typeof sample.group === 'function' && sample.group( member ) !== source.id ) ) return reject( 'STALE_MEMBERSHIP' );
		if ( new Set( source.members ).size !== source.members.length ) return reject( 'DUPLICATE_MEMBER' );
		if ( sample.faction( member ) !== source.faction ) return reject( 'PERSON_UNAVAILABLE' );
		const target = targets.find( ( group ) => group !== source && group.faction === source.faction );
		if ( ! target ) return reject( 'INCOMPATIBLE_FACTION' );
		if ( target.members.includes( member ) ) return reject( 'DUPLICATE_MEMBER' );
		const sourceMembers = source.members.filter( ( candidate ) => candidate !== member ), targetMembers = [ ...target.members, member ];
		if ( new Set( sourceMembers ).size !== sourceMembers.length || new Set( targetMembers ).size !== targetMembers.length ) return reject( 'DUPLICATE_MEMBER' );
		const sourceLeader = source.leader === member
			? sourceMembers.find( ( candidate ) => sample.faction( candidate ) === source.faction ) ?? - 1 : source.leader;
		const targetLeader = promote || target.members.length === 0 ? member : target.leader;
		if ( targetLeader !== member && ( ! target.members.includes( targetLeader ) || sample.faction( targetLeader ) !== target.faction ) ) return reject( 'TARGET_LEADER_UNAVAILABLE' );
		const changes = [ [ member, target.id, targetLeader === member ? ROLE.LEADER : ROLE.MEMBER ] ];
		if ( source.leader === member && sourceLeader >= 0 ) changes.push( [ sourceLeader, source.id, ROLE.LEADER ] );
		if ( targetLeader === member && target.members.includes( target.leader ) ) changes.push( [ target.leader, target.id, ROLE.MEMBER ] );
		if ( crowd.pendingEdits.length + changes.length > MAX_EDITS ) return reject( 'EDIT_CAPACITY' );
		const sourcePosition = sourceLeader >= 0 ? [ sample.x( sourceLeader ), sample.y( sourceLeader ) ] : null;
		const targetPosition = [ sample.x( targetLeader ), sample.y( targetLeader ) ];
		const sourceFaction = sourceLeader >= 0 ? sample.faction( sourceLeader ) : - 1;
		if ( ! targetPosition.every( Number.isFinite ) || ( sourcePosition && ( ! sourcePosition.every( Number.isFinite ) || ! Number.isFinite( sourceFaction ) ) ) ) return reject( 'PERSON_UNAVAILABLE' );
		const sourceState = sourceFaction === FACTION.ARRESTED || sourceFaction === FACTION.ARRESTED_SITTER ? 'arrested'
			: sourceFaction < 0 ? 'gone' : sourceFaction > 9.5 ? 'injured' : 'active';
		const sourceOffsets = source.faction === FACTION.POLICE ? World.block( sourceMembers.length ) : null;
		const targetOffsets = target.faction === FACTION.POLICE ? World.block( targetMembers.length ) : null;
		world.uncordon( [ source, target ] );
		source.members = sourceMembers; target.members = targetMembers;
		source.leader = sourceLeader; target.leader = targetLeader;
		source.leaderState = sourceState; source.leaderPos = sourcePosition; source.leaderReported = false;
		target.leaderState = 'active'; target.leaderPos = targetPosition; target.leaderReported = false;
		for ( const change of changes ) crowd.regroup( ...change );
		crowd.setGroup( source.id, { leader: sourceLeader } ); crowd.setGroup( target.id, { leader: targetLeader } );
		if ( sourceOffsets ) crowd.setOffsets( sourceMembers, sourceOffsets );
		if ( targetOffsets ) crowd.setOffsets( targetMembers, targetOffsets );
		source.alive = sourceMembers.filter( ( candidate ) => sample.faction( candidate ) === source.faction ).length;
		target.alive = targetMembers.filter( ( candidate ) => sample.faction( candidate ) === target.faction ).length;
		if ( ! sourceMembers.length ) source.center = null;
		game.selected = game.selected.filter( ( selected ) => selected !== source || source.alive > 0 );
		return Object.freeze( { status: 'completed', backend: Object.freeze( { member, group: target } ) } );

	}

	applyMove( groups, prepared, request, valid ) {

		const world = this.mission.world;
		this.cancelSnatches( groups, 'squad received a movement order' );
		if ( request.line ) return world.lineSquads( groups, request.line, request.at, world.intel?.pos, undefined, { layer: prepared.layer, valid } );
		if ( groups[ 0 ].faction === FACTION.POLICE ) return world.moveSquads( groups, ...request.at, { layer: prepared.layer, valid } );
		return world.march( groups, ...request.at, request.radius, { layer: prepared.layer, valid } );

	}

	releaseMove( prepared ) { this.mission.world.flow.release( prepared.layer ); }

	settleMove( groups ) {

		const { world, runtime } = this.mission, layer = world.exitLayer;
		if ( layer === undefined || ! runtime ) return;
		for ( const group of groups ) {

			if ( group.faction !== FACTION.POLICE || group.mode !== MODE.FORMATION || ! group.center || ! group.anchor
				|| Math.hypot( group.center[ 0 ] - group.anchor[ 0 ], group.center[ 1 ] - group.anchor[ 1 ] ) > 25 ) continue;
			const record = [ ...runtime.actors.values() ].find( ( actor ) => actor.handle.kind === 'squad' && actor.backend?.includes( group ) );
			if ( ! record || runtime.commands.claims.has( record.handle ) || runtime.movement.orders.has( record.handle.id ) ) continue;
			world.setLayer( group, layer );

		}

	}

	stopMove( groups ) {

		const { world, crowd } = this.mission;
		world.uncordon( groups );
		for ( const group of groups ) {

			if ( ! group.center?.every( Number.isFinite ) || ! group.members.length ) continue;
			group.goal = [ ...group.center ];
			if ( group.faction === FACTION.POLICE ) {

				group.anchor = [ ...group.center ];
				group.mode = MODE.FORMATION;
				crowd.setOffsets( group.members, World.block( group.members.length ) );
				crowd.setGroup( group.id, { mode: MODE.FORMATION, ax: group.center[ 0 ], ay: group.center[ 1 ], scale: 1 } );

			} else world.setMode( [ group ], MODE.HOLD );

		}

	}

	snatchOutcome( group, target, result ) {

		const task = this.snatchTasks.get( group );
		if ( ! task || task.targetGroup !== target ) return null;
		this.snatchTasks.delete( group );
		return { operation: task.operation, squad: task.squad, target: task.target,
			type: result === 'abandoned' ? 'snatch.abandoned' : 'snatch.completed', result };

	}

	cancelSnatches( groups, reason ) {

		this.mission.world.endSnatch?.( groups );
		for ( const group of groups ) {

			const task = this.snatchTasks.get( group );
			if ( ! task ) continue;
			this.snatchTasks.delete( group );
			this.mission.runtime.event( 'snatch.cancelled', { operation: task.operation, squad: task.squad, target: task.target, reason } );

		}

	}

	release( groups ) {

		const { world, crowd, game } = this.mission;
		if ( groups.isCar ) {

			this.stopVehicle( groups );
			if ( groups.crew ) this.release( [ groups.crew ] );
			world.patrols.cars = world.patrols.cars.filter( ( car ) => car !== groups );
			world.patrols.group.remove( groups.mesh );
			const resources = new Set<any>();
			groups.mesh.traverse( ( object ) => {

				if ( object.geometry ) resources.add( object.geometry );
				for ( const material of Array.isArray( object.material ) ? object.material : object.material ? [ object.material ] : [] ) resources.add( material );

			} );
			for ( const resource of resources ) resource.dispose();
			game.selected = game.selected.filter( ( selected ) => selected !== groups );
			return;

		}
		for ( const group of groups ) {

			this.wanderGroups.delete( group );
			for ( const member of group.members ) crowd.setFaction( member, - 1 );
			group.members = [];
			group.alive = 0;
			if ( group.layer !== undefined ) { world.flow.release( group.layer ); group.layer = undefined; }
			game.selected = game.selected.filter( ( selected ) => selected !== group );

		}

	}

	readVehicle( car ) { return { position: [ car.x, car.y ], speed: car.speed, moving: car.path !== null }; }

	driveVehicle( car, at ) {

		const patrols = this.mission.world.patrols;
		const destination = patrols.snap( ...at );
		if ( ! destination || ! patrols.driveTo( car, ...destination ) ) return { status: 'rejected', code: 'NO_ROUTE' };
		return { status: 'completed', destination };

	}

	stopVehicle( car ) { car.path = null; car.speed = 0; }

	toggleCrewVehicle( car ) {

		if ( ! car.crew ) return { status: 'rejected', code: 'NO_CREW' };
		if ( car.path ) return { status: 'rejected', code: 'VEHICLE_MOVING' };
		this.mission.world.patrols.toggleCrew( [ car ] );
		return { status: 'completed' };

	}

	prepareBoarding( backends, sample ) {

		const { crowd } = this.mission;
		const unique = [ ...new Map<any, any>( backends.map( ( backend ) => [ backend.member, backend ] ) ).values() ];
		const members = [], groups = new Map<any, any>();
		for ( const backend of unique ) {

			const { member, group } = backend, faction = sample.faction( member );
			if ( ! group.members.includes( member ) || sample.group( member ) !== group.id ) return { status: 'rejected', code: 'STALE_MEMBERSHIP' };
			if ( ! Number.isFinite( faction ) || faction < 0 || faction > 29.5 ) return { status: 'rejected', code: 'PERSON_UNAVAILABLE' };
			if ( crowd.pendingEdits.some( ( edit ) => group.members.includes( edit[ 0 ] ) && [ 1, 2, 4, 6 ].includes( edit[ 1 ] ) ) ) return { status: 'rejected', code: 'PERSON_PENDING' };
			members.push( { ...backend, faction } );
			if ( ! groups.has( group.id ) ) groups.set( group.id, { group, leader: group.leader, leaderState: group.leaderState, leaderPos: group.leaderPos,
				replacement: group.members.find( ( candidate ) => ! unique.some( ( entry ) => entry.member === candidate ) && sample.faction( candidate ) === group.faction ) ?? - 1 } );

		}
		if ( crowd.pendingEdits.length + members.length + groups.size * 2 > MAX_EDITS ) return { status: 'rejected', code: 'EDIT_CAPACITY' };
		return { status: 'completed', members, groups: [ ...groups.values() ], edits: [] };

	}

	commitBoarding( plan ) {

		const { crowd } = this.mission;
		for ( const entry of plan.members ) {

			crowd.compareFaction( entry.member, entry.faction, - 1, entry.group.id );
			plan.edits.push( crowd.pendingEdits.at( - 1 ) );

		}
		for ( const entry of plan.groups ) {

			if ( ! plan.members.some( ( member ) => member.member === entry.leader ) ) continue;
			entry.group.leader = entry.replacement;
			entry.group.leaderState = entry.replacement >= 0 ? 'active' : 'gone';
			crowd.setGroup( entry.group.id, { leader: entry.replacement } );
			if ( entry.replacement >= 0 ) {

				crowd.regroup( entry.replacement, entry.group.id, ROLE.LEADER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );

			}

		}

	}

	boardingConfirmed( plan, sample ) { return plan.members.every( ( entry ) => sample.faction( entry.member ) === - 1 && sample.group( entry.member ) === entry.group.id ); }
	boardingRestored( plan, sample ) { return plan.members.every( ( entry ) => Number.isFinite( sample.faction( entry.member ) ) && sample.faction( entry.member ) !== - 1 ); }

	abandonBoarding( plan ) {

		const owned = new Set( plan.edits );
		const pending = this.mission.crowd.pendingEdits;
		for ( let index = pending.length - 1; index >= 0; index -- ) if ( owned.has( pending[ index ] ) ) pending.splice( index, 1 );
		plan.edits = [];

	}

	commandEligible( id, groups ) {

		return id !== 'shield-push' || groups.some( ( group ) => group.cordon );

	}

	custodyEnvironment() {

		const { world, crowd, runtime } = this.mission;
		return {
			time: () => runtime.time, intel: () => world.intel, count: () => crowd.count, capacity: () => crowd.N,
			police: () => world.groupsOf( FACTION.POLICE ).filter( ( group ) => group.center && group.kind !== 'crew' ),
			moveSquads: ( groups, x, y ) => world.moveSquads( groups, x, y ),
			arrest: ( groups, x, y, radius ) => world.arrest( groups, x, y, radius ),
			setGroup: ( id, patch ) => crowd.setGroup( id, patch ),
			countNear: ( x, y, radius ) => world.countNear( x, y, radius, FACTION.PROTESTER ),
			sitter: ( index ) => this.sitters.has( index ),
			sittingActor: ( id ) => this.sittingActors.has( id ),
			respawn: ( id, sitter, at ) => {

				const group = runtime.actors.get( id )?.backend?.[ 0 ], random = () => runtime.random();
				if ( ! group ) return false;
				const [ agent ] = crowd.spawn( [ { x: at[ 0 ] + rand( - 2, 2, random ), y: at[ 1 ] + rand( - 2, 2, random ), faction: group.faction, group: group.id,
					role: sitter ? ROLE.SITTER : ROLE.MEMBER, agitation: 0.4, resolve: 1 } ] );
				if ( agent?.index === undefined ) return false;
				group.members.push( agent.index );
				if ( sitter ) this.sitters.add( agent.index );
				return true;

			},
			actorOf: ( index ) => {

				const seen = world.groups[ world.intel.group( index ) ], group = seen?.probeOf ?? seen; // a probe belongs to its crowd
				return [ ...runtime.actors.values() ].find( ( record ) => Array.isArray( record.backend ) && record.backend.includes( group ) )?.handle.id ?? null;

			},
		};

	}

	async prepareCommand( request, selected, signal ) {

		const { world, crowd, runtime } = this.mission;
		signal.throwIfAborted();
		if ( request.custom ) return { custom: true, groups: selected.flat(), applied: false };
		if ( [ 'hold', 'sit', 'shield', 'scatter', 'disperse', 'fire-up', 'calm', 'umbrella', 'split', 'merge' ].includes( request.id ) ) return { groups: selected.flat(), protest: true, applied: false };
		if ( request.id === 'gas' || request.id === 'shield-push' ) return {};
		let actor = null, groups = selected.flat();
		if ( request.id === 'firearms' ) return { groups, applied: false };
		if ( request.id === 'arrest' && runtime.custody.options ) {

			if ( ! runtime.custody.dropoffs.size ) return { status: 'rejected', code: 'NO_DROPOFF' };
			return { groups, custody: true, applied: false };

		}
		if ( request.id === 'water' ) {

			const truck = groups[ 0 ];
			if ( ! truck?.water ) return { status: 'rejected', code: 'INVALID_SELECTION' };
			if ( truck.sprayUntil > this.mission.t ) return { status: 'rejected', code: 'WATER_BUSY' };
			return { truck, applied: false };

		}
		if ( request.id === 'crew' ) {

			const truck = groups[ 0 ];
			if ( ! truck?.crew ) return { status: 'rejected', code: 'NO_CREW' };
			if ( truck.path ) return { status: 'rejected', code: 'VEHICLE_MOVING' };
			return { truck, applied: false };

		}
		if ( request.id === 'firearms' ) return { groups, applied: false };
		if ( request.id === 'snatch' ) {

			if ( ! request.target ) return { status: 'rejected', code: 'TARGET_NOT_FOUND' };
			return { groups, target: request.target, applied: false };

		}
		if ( request.id === 'reinforce' ) {

			const pending = [ ...runtime.actors.values() ].filter( ( record ) => record.backend === null );
			if ( crowd.count + pending.reduce( ( count, record ) => count + record.requestedPeople, 0 ) + 30 > crowd.N
				|| world.groups.length + pending.reduce( ( count, record ) => count + record.requestedGroups, 0 ) + 1 > crowd.G ) return { status: 'rejected', code: 'CAPACITY' };
			const stations = this.mission.city.landmarks.filter( ( entry ) => entry.kind === 'police' && entry.name !== 'Policija' );
			stations.sort( ( first, second ) => Math.hypot( first.pos[ 0 ] - request.at[ 0 ], first.pos[ 1 ] - request.at[ 1 ] )
				- Math.hypot( second.pos[ 0 ] - request.at[ 0 ], second.pos[ 1 ] - request.at[ 1 ] ) );
			if ( ! stations.length ) return { status: 'rejected', code: 'NO_STATION' };
			let id;
			do { id = `reinforcement-${this.nextReinforcement ++}`; } while ( runtime.actors.has( id ) );
			const spawn = runtime.spawn( 'squad', { id, at: stations[ 0 ].pos, people: 30 } );
			const abort = () => spawn.cancel( 'command cancelled' );
			signal.addEventListener( 'abort', abort, { once: true } );
			let outcome;
			try { outcome = await spawn.settled; }
			finally { signal.removeEventListener( 'abort', abort ); }
			if ( outcome.status !== 'completed' ) return { status: 'rejected', code: 'CAPACITY' };
			actor = outcome.value; groups = runtime.actors.get( actor.id ).backend;
			for ( const group of groups ) group.label = 'Reinforcements';

		}
		let layer;
		try {

			signal.throwIfAborted();
			const radius = request.id === 'kettle' ? request.radius ?? Math.max( 14, Math.sqrt( groups.reduce( ( count, group ) => count + group.members.length, 0 ) ) * 2.6 ) : null;
			layer = await world.fieldTo( ...request.at, request.id === 'kettle' ? radius + 10 : request.id === 'charge' ? 6 : request.id === 'arrest' ? request.radius ?? 5 : 12 );
			signal.throwIfAborted(); world.flow.retain( layer );
			return { layer, radius, actor, groups, applied: false };

		} catch ( error ) {

			if ( actor ) runtime.removeActor( actor );
			throw error;

		}

	}

	applyCommand( request, selected, prepared, current ) {

		const { world, runtime, game } = this.mission;
		if ( ! current() ) return { status: 'rejected', code: 'SUPERSEDED' };
		if ( prepared.custom ) {

			let affected = request.selection;
			if ( request.id === 'split' ) { const result = runtime.splitActor( request.selection[ 0 ], request.operation ); if ( result.status !== 'completed' ) return result; affected = [ ...affected, result.value ]; }
			if ( request.id === 'merge' ) { const result = runtime.mergeActors( request.selection, request.operation ); if ( result.status !== 'completed' ) return result; affected = [ result.value ]; }
			prepared.applied = true;
			return { status: 'completed', value: { affected: Object.freeze( [ ...affected ] ) } };

		}
		const groups = prepared.groups ?? selected.flat();
		let affected = groups;
		if ( request.id !== 'snatch' && [ 'charge', 'arrest', 'kettle', 'shield-push' ].includes( request.id ) ) this.cancelSnatches( groups, `squad received ${request.id}` );
		if ( ! [ 'gas', 'reinforce', 'water', 'crew' ].includes( request.id ) && groups.some( ( group ) => ! group.members.some( ( member ) => world.intel?.faction( member ) === ( prepared.protest ? FACTION.PROTESTER : FACTION.POLICE ) ) ) ) return { status: 'rejected', code: 'INVALID_SELECTION' };
		let work;
		let crewHandle = null;
		if ( prepared.protest ) {

			Mission.prototype.recall.call( this.mission, groups );
			if ( request.id === 'hold' ) world.setMode( groups, MODE.HOLD );
			else if ( request.id === 'disperse' ) world.setMode( groups, MODE.DISPERSE );
			else if ( request.id === 'sit' ) Mission.prototype.sitDown.call( this.mission, groups );
			else if ( request.id === 'shield' ) Mission.prototype.shieldWall.call( this.mission, groups );
			else if ( request.id === 'scatter' ) Mission.prototype.beWater.call( this.mission, groups, ...request.at );
			else if ( request.id === 'fire-up' ) Mission.prototype.fireUp.call( this.mission, groups );
			else if ( request.id === 'calm' ) Mission.prototype.calmDown.call( this.mission, groups );
			else if ( request.id === 'umbrella' ) {

				affected = groups.slice( 0, 8 );
				this.setShelter( affected, this.mission.runtime.time + 30 );

			}

		} else if ( request.id === 'gas' ) { world.gas( ...request.at ); affected = []; }
		else if ( request.id === 'crew' ) {

			const vehicle = runtime.transport.record( request.selection[ 0 ] ), toggled = runtime.transport.toggleCrew( null,
				request.selection[ 0 ], { expectedRevision: vehicle.revision } );
			if ( toggled.status !== 'completed' ) return toggled;
			crewHandle = vehicle.actor.crewHandle;
			affected = [];

		}
		else if ( request.id === 'firearms' ) Mission.prototype.openFire.call( this.mission, groups );
		else if ( request.id === 'water' ) {

			const truck = prepared.truck;
			if ( ! truck?.water || truck.sprayUntil > this.mission.t ) return { status: 'rejected', code: truck?.water ? 'WATER_BUSY' : 'INVALID_SELECTION' };
			world.spray( truck, Math.atan2( request.at[ 1 ] - truck.y, request.at[ 0 ] - truck.x ) );
			truck.sprayUntil = this.mission.t + WATER_JET;
			affected = [];

		}
		else if ( request.id === 'snatch' ) {

			const person = runtime.identity.personRecord( prepared.target.person );
			if ( person.actor !== prepared.target.actor || person.sample?.status !== 'active' || ! person.sample.leader || ! person.sample.identified ) return { status: 'rejected', code: 'TARGET_UNAVAILABLE' };
			const targetGroup = person.backend.group;
			this.cancelSnatches( groups, 'squad assigned to another snatch' );
			world.snatch( groups, targetGroup, this.mission.t );
			for ( const group of groups ) {

				const squad = [ ...runtime.actors.values() ].find( ( record ) => Array.isArray( record.backend ) && record.backend.includes( group ) )?.handle;
				this.snatchTasks.set( group, { operation: request.operation, squad, target: prepared.target.person, targetGroup } );

			}
		}
		else if ( request.id === 'shield-push' ) {

			const lines = [ ...new Set<any>( groups.filter( ( group ) => group.cordon ).map( ( group ) => group.cordon ) ) ];
			if ( lines.some( ( line ) => line.squads.some( ( group ) => ! groups.includes( group ) ) ) ) return { status: 'rejected', code: 'SELECT_ENTIRE_CORDON' };
			const line = world.shieldPush( groups, ...request.at );
			if ( ! line ) return { status: 'rejected', code: 'INVALID_PUSH' };
			affected = line.squads;

		} else if ( request.id === 'charge' ) work = world.charge( groups, ...request.at, { layer: prepared.layer, valid: current } );
		else if ( request.id === 'arrest' && prepared.custody ) runtime.custody.start( groups, request.at );
		else if ( request.id === 'arrest' ) work = world.arrest( groups, ...request.at, request.radius ?? 5,
			request.aim ?? ( request.radius === undefined ? null : request.at ), { layer: prepared.layer, valid: current } );
		else if ( request.id === 'kettle' ) work = world.kettle( groups, ...request.at, prepared.radius, world.intel.pos,
			{ layer: prepared.layer, valid: current, tighten: request.tighten } );
		else if ( request.id === 'reinforce' ) work = world.moveSquads( groups, ...request.at, { layer: prepared.layer, valid: current } );
		if ( work ) work.catch( ( error ) => runtime.fail( error ) );
		prepared.applied = true;
		if ( game?.sound ) {

			if ( request.id === 'reinforce' ) game.sound.reinforce( groups[ 0 ].anchor );
			else if ( request.source !== 'player' ) game.sound.order( { gas: 'g', charge: 'c', arrest: 'a', snatch: 'x', kettle: 'k', 'shield-push': 's' }[ request.id ], request.at );

		}
		const handles = [ ...runtime.actors.values() ].filter( ( record ) => record.backend === prepared.truck
			|| ( Array.isArray( record.backend ) && record.backend.some( ( group ) => affected.includes( group ) ) ) ).map( ( record ) => record.handle );
		if ( crewHandle ) handles.push( crewHandle );
		return { status: 'completed', value: { affected: Object.freeze( handles ), ...( prepared.target ? { target: prepared.target.person } : {} ), ...( prepared.actor ? { actor: prepared.actor } : {} ) } };

	}

	releaseCommand( prepared ) {

		if ( prepared.layer !== undefined ) this.mission.world.flow.release( prepared.layer );
		if ( prepared.actor && ! prepared.applied ) this.mission.runtime.removeActor( prepared.actor );

	}

	rollbackBoarding( plan, discarded = [] ) {

		const { crowd } = this.mission;
		this.abandonBoarding( plan );
		const ignored = new Set( discarded.map( ( backend ) => backend.member ) );
		for ( const entry of plan.members ) if ( ! ignored.has( entry.member ) ) {

			crowd.compareFaction( entry.member, - 1, entry.faction, entry.group.id );
			plan.edits.push( crowd.pendingEdits.at( - 1 ) );

		}
		for ( const entry of plan.groups ) {

			if ( ! plan.members.some( ( member ) => member.member === entry.leader ) ) continue;
			if ( plan.members.filter( ( member ) => member.group === entry.group ).every( ( member ) => ignored.has( member.member ) ) ) continue;
			if ( entry.group.leader !== entry.replacement && entry.group.leader !== entry.leader ) {

				crowd.regroup( entry.leader, entry.group.id, ROLE.MEMBER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );
				continue;

			}
			entry.group.leader = entry.leader; entry.group.leaderState = entry.leaderState; entry.group.leaderPos = entry.leaderPos;
			crowd.setGroup( entry.group.id, { leader: entry.leader } );
			if ( entry.replacement >= 0 ) {

				crowd.regroup( entry.replacement, entry.group.id, ROLE.MEMBER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );

			}
			if ( entry.leader >= 0 ) {

				crowd.regroup( entry.leader, entry.group.id, ROLE.LEADER );
				plan.edits.push( crowd.pendingEdits.at( - 1 ) );

			}

		}

	}

}