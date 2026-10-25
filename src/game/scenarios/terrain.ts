import { check, fields, point } from './definition.ts';
import { inPoly, ringDist } from '../sdk/geometry.ts';

export function terrainDefinitions( values = [] ) {

	check( Array.isArray( values ) && values.length <= 16, 'scenario.terrain', 'must be at most 16 barriers' );
	const ids = new Set();
	return Object.freeze( Array.from( values, ( value, index ) => {

		const name = `scenario.terrain.${index}`; fields( value, [ 'id', 'polygon', 'halfWidth', 'excludeInterior' ], name );
		check( typeof value.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test( value.id ) && ! ids.has( value.id ), `${name}.id`, 'must be a unique slug' ); ids.add( value.id );
		check( Array.isArray( value.polygon ) && value.polygon.length >= 3 && value.polygon.length <= 512, `${name}.polygon`, 'must have 3 to 512 points' );
		const polygon = Object.freeze( Array.from( value.polygon, ( at ) => point( at, `${name}.polygon` ) ) );
		const halfWidth = value.halfWidth ?? 0.4; check( Number.isFinite( halfWidth ) && halfWidth > 0 && halfWidth <= 10, `${name}.halfWidth`, 'must be positive and at most ten meters' );
		check( value.excludeInterior === undefined || typeof value.excludeInterior === 'boolean', `${name}.excludeInterior`, 'must be boolean' );
		return Object.freeze( { id: value.id, polygon, halfWidth, excludeInterior: value.excludeInterior ?? false } );

	} ) );

}

export function prepareTerrain( city, barriers ) {

	if ( ! barriers.length ) return;
	city.scenarioRawSdf = city.sdfData.slice();
	const [ originX, originY ] = city.bounds;
	for ( const barrier of barriers ) {

		const ring = barrier.polygon.flat(), xs = barrier.polygon.map( ( at ) => at[ 0 ] ), ys = barrier.polygon.map( ( at ) => at[ 1 ] );
		const minX = Math.min( ...xs ), maxX = Math.max( ...xs ), minY = Math.min( ...ys ), maxY = Math.max( ...ys );
		for ( let row = Math.max( 0, Math.floor( minY - 3 - originY ) ); row <= Math.min( city.sdf.h - 1, Math.ceil( maxY + 3 - originY ) ); row ++ ) for ( let column = Math.max( 0, Math.floor( minX - 3 - originX ) ); column <= Math.min( city.sdf.w - 1, Math.ceil( maxX + 3 - originX ) ); column ++ ) {

			const distance = ringDist( ring, originX + column + 0.5, originY + row + 0.5 ) - barrier.halfWidth;
			const offset = row * city.sdf.w + column; city.sdfData[ offset ] = Math.min( city.sdfData[ offset ], Math.max( - 127, Math.min( 127, Math.round( distance * 10 ) ) ) );

		}
		for ( let row = Math.max( 0, Math.floor( ( minY - 3 - originY ) / city.cost.res ) ); row <= Math.min( city.cost.h - 1, Math.ceil( ( maxY + 3 - originY ) / city.cost.res ) ); row ++ ) for ( let column = Math.max( 0, Math.floor( ( minX - 3 - originX ) / city.cost.res ) ); column <= Math.min( city.cost.w - 1, Math.ceil( ( maxX + 3 - originX ) / city.cost.res ) ); column ++ ) {

			const x = originX + ( column + 0.5 ) * city.cost.res, y = originY + ( row + 0.5 ) * city.cost.res;
			if ( ringDist( ring, x, y ) <= Math.max( 1.2, barrier.halfWidth + city.cost.res * 0.7 ) || barrier.excludeInterior && inPoly( ring, x, y ) ) city.costData[ row * city.cost.w + column ] = 255;

		}

	}

}
