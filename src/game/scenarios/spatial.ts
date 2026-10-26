import { check, fields, point } from './definition.ts';
import { ringDist } from '../sdk/geometry.ts';

export function mapTarget( value, path ) {

	check( value && typeof value.name === 'string', path, 'target was not found' );
	check( Number.isFinite( value.radius ) && value.radius > 0, `${path}.radius`, 'must be positive and finite' );
	check( Array.isArray( value.footprints ) && value.footprints.length > 0 && Array.from( value.footprints ).every( Array.isArray ), `${path}.footprints`, 'must contain a dense array of outer footprint rings' );
	const footprints = value.footprints.map( ( ring ) => {

		check( Array.isArray( ring ) && ring.length >= 6 && ring.length % 2 === 0 && Array.from( ring ).every( Number.isFinite ), `${path}.footprints`, 'rings must contain finite flattened x/y pairs' );
		return Object.freeze( [ ...ring ] );

	} );
	check( Array.isArray( value.exits ) && value.exits.length > 0, `${path}.exits`, 'must contain evacuation exits' );
	return Object.freeze( { name: value.name, position: point( value.position, `${path}.position` ), radius: value.radius,
		footprints: Object.freeze( footprints ), exits: Object.freeze( Array.from( value.exits, ( at ) => point( at, `${path}.exits` ) ) ) } );

}

export class SpatialHost {

	declare runtime: any;
	declare targets: Map<any, any>;
	declare buildings: Map<any, any>;
	declare measurements: Map<any, any>;
	declare measuredObservation: any;

	constructor( runtime ) {

		this.runtime = runtime;
		this.targets = new Map<any, any>();
		this.buildings = new Map<any, any>();
		this.measurements = new Map<any, any>();
		this.measuredObservation = null;

	}

	target( alias ) {

		check( this.targets.has( alias ), 'targets.get', `unknown target alias '${alias}'` );
		return this.targets.get( alias );

	}

	buildingGeometry( alias, exitAt = {} ) {

		return this.prepareBuilding( alias, exitAt );

	}

	available() {

		const sample = this.runtime.observation;
		if ( ! sample ) return false;
		const known = new Set( sample.actors.map( ( actor ) => actor.handle ) );
		return [ ...this.runtime.actors.values() ].every( ( actor ) => actor.backend === null || actor.handle.kind === 'vehicle' || known.has( actor.handle ) );

	}

	count( options ) {

		fields( options, [ 'at', 'radius', 'faction', 'minimumAgitation' ], 'spatial.count' );
		const at = this.runtime.location( options.at ), agitation = options.minimumAgitation ?? 0;
		check( Number.isFinite( options.radius ) && options.radius > 0, 'spatial.count.radius', 'must be positive and finite' );
		check( options.faction === undefined || [ 'protester', 'police', 'bystander', 'counter' ].includes( options.faction ), 'spatial.count.faction', 'unknown faction' );
		check( Number.isFinite( agitation ) && agitation >= 0 && agitation <= 1, 'spatial.count.minimumAgitation', 'must be between 0 and 1' );
		if ( ! this.available() ) return null;
		return this.runtime.observation.people.filter( ( person ) => person.status === 'active'
			&& ( ! options.faction || person.faction === options.faction ) && person.agitation >= agitation
			&& Math.hypot( person.position[ 0 ] - at[ 0 ], person.position[ 1 ] - at[ 1 ] ) < options.radius ).length;

	}

	roadSpan( at, maxDistance = 30 ) {

		check( Number.isFinite( maxDistance ) && maxDistance > 0 && maxDistance <= 100, 'spatial.roadSpan.maxDistance', 'must be positive and at most 100 meters' );
		const [ first, second ] = this.runtime.adapter.roadSpan( this.runtime.location( at ), maxDistance );
		const a = point( first, 'spatial.roadSpan.a' ), b = point( second, 'spatial.roadSpan.b' );
		return Object.freeze( { a, b, width: Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) } );

	}
	roadRoute( from, to ) {

		const route = this.runtime.adapter.roadRoute( this.runtime.location( from ), this.runtime.location( to ) );
		if ( route === null ) return null;
		check( Array.isArray( route ) && route.length > 0, 'spatial.roadRoute', 'host returned an invalid path' );
		const points = Object.freeze( Array.from( route, ( at, index ) => point( at, `spatial.roadRoute.${index}` ) ) );
		const length = points.slice( 1 ).reduce( ( total, at, index ) => total + Math.hypot( at[ 0 ] - points[ index ][ 0 ], at[ 1 ] - points[ index ][ 1 ] ), 0 );
		check( Number.isFinite( length ), 'spatial.roadRoute', 'host returned an invalid path length' );
		return Object.freeze( { points, length } );

	}

	prepareBuilding( alias, exitAt = {} ) {

		const key = JSON.stringify( [ alias, exitAt ] );
		if ( this.buildings.has( key ) ) return this.buildings.get( key );
		const target = this.target( alias );
		for ( const index of Object.keys( exitAt ) ) check( Number( index ) < target.exits.length, `objective.exitAt.${index}`, 'exit does not exist on this target' );
		const exits = target.exits.map( ( exit, index ) => {

			if ( exitAt[ index ] ) return point( this.runtime.adapter.snapRoad( exitAt[ index ] ) ?? exitAt[ index ], 'building.exit' );
			let directionX = exit[ 0 ] - target.position[ 0 ], directionY = exit[ 1 ] - target.position[ 1 ];
			const length = Math.hypot( directionX, directionY ) || 1;
			directionX /= length; directionY /= length;
			let at = exit;
			for ( let distance = 0; distance < 40 && Math.min( ...target.footprints.map( ( ring ) => ringDist( ring, ...( at as [ number, number ] ) ) ) ) < 20; distance += 2 ) {

				at = [ exit[ 0 ] + directionX * distance, exit[ 1 ] + directionY * distance ];

			}
			return point( this.runtime.adapter.snapRoad( at ) ?? at, 'building.exit' );

		} );
		const prepared = Object.freeze( { ...target, exits: Object.freeze( exits ) } );
		this.buildings.set( key, prepared );
		return prepared;

	}

	measureBuilding( alias, exitAt = {} ) {

		const target = this.prepareBuilding( alias, exitAt );
		if ( ! this.available() ) return null;
		if ( this.measuredObservation !== this.runtime.observation ) {

			this.measurements.clear(); this.measuredObservation = this.runtime.observation;

		}
		const key = JSON.stringify( [ alias, exitAt ] );
		if ( this.measurements.has( key ) ) return this.measurements.get( key );
		const people = this.runtime.observation.people.filter( ( person ) => person.status === 'active' && person.faction === 'protester' );
		const facade = people.filter( ( person ) => person.agitation >= 0.4
			&& Math.hypot( person.position[ 0 ] - target.position[ 0 ], person.position[ 1 ] - target.position[ 1 ] ) <= target.radius + 40
			&& target.footprints.some( ( ring ) => ringDist( ring, ...( person.position as [ number, number ] ) ) < 3 ) ).length;
		const exits = target.exits.map( ( exit ) => people.filter( ( person ) => Math.hypot( person.position[ 0 ] - exit[ 0 ], person.position[ 1 ] - exit[ 1 ] ) < 12 ).length );
		const measurement = Object.freeze( { facade, exits: Object.freeze( exits ) } );
		this.measurements.set( key, measurement );
		return measurement;

	}

}