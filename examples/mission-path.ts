import type { Point } from '../src/game/scenarios/sdk.d.ts';

export const gap = ( first: Point, second: Point ) => Math.hypot( first[ 0 ] - second[ 0 ], first[ 1 ] - second[ 1 ] );
export const timeText = ( seconds: number ) => `${Math.floor( Math.max( 0, seconds ) / 60 )}:${String( Math.floor( Math.max( 0, seconds ) % 60 ) ).padStart( 2, '0' )}`;

export function path( input: readonly Point[] ) {

	if ( input.length < 2 ) throw new Error( 'A mission path requires at least two points' );
	const points = input.map( ( at ) => [ at[ 0 ], at[ 1 ] ] as Point ), cumulative = [ 0 ];
	for ( let index = 1; index < points.length; index ++ ) cumulative.push( cumulative.at( - 1 ) + gap( points[ index - 1 ], points[ index ] ) );
	const length = cumulative.at( - 1 );
	const at = ( distance: number ): Point => {

		const bounded = Math.max( 0, Math.min( length, distance ) ); let index = 1;
		while ( index < points.length - 1 && cumulative[ index ] < bounded ) index ++;
		const fraction = ( bounded - cumulative[ index - 1 ] ) / ( cumulative[ index ] - cumulative[ index - 1 ] || 1 );
		return [ points[ index - 1 ][ 0 ] + ( points[ index ][ 0 ] - points[ index - 1 ][ 0 ] ) * fraction,
			points[ index - 1 ][ 1 ] + ( points[ index ][ 1 ] - points[ index - 1 ][ 1 ] ) * fraction ];

	};
	const project = ( position: Point ) => {

		let nearest = 0, best = Infinity;
		for ( let index = 1; index < points.length; index ++ ) {

			const start = points[ index - 1 ], end = points[ index ], deltaX = end[ 0 ] - start[ 0 ], deltaY = end[ 1 ] - start[ 1 ];
			const fraction = Math.max( 0, Math.min( 1, ( ( position[ 0 ] - start[ 0 ] ) * deltaX + ( position[ 1 ] - start[ 1 ] ) * deltaY ) / ( deltaX ** 2 + deltaY ** 2 || 1 ) ) );
			const distance = Math.hypot( position[ 0 ] - start[ 0 ] - deltaX * fraction, position[ 1 ] - start[ 1 ] - deltaY * fraction );
			if ( distance < best ) { best = distance; nearest = cumulative[ index - 1 ] + fraction * ( cumulative[ index ] - cumulative[ index - 1 ] ); }

		}
		return nearest;

	};
	return { points, cumulative, length, at, project };

}

export function ringDistance( ring: readonly number[], position: Point ) {

	let best = Infinity;
	for ( let index = 0; index < ring.length; index += 2 ) {

		const startX = ring[ index ], startY = ring[ index + 1 ], deltaX = ring[ ( index + 2 ) % ring.length ] - startX, deltaY = ring[ ( index + 3 ) % ring.length ] - startY;
		const fraction = Math.max( 0, Math.min( 1, ( ( position[ 0 ] - startX ) * deltaX + ( position[ 1 ] - startY ) * deltaY ) / ( deltaX ** 2 + deltaY ** 2 || 1 ) ) );
		best = Math.min( best, Math.hypot( position[ 0 ] - startX - deltaX * fraction, position[ 1 ] - startY - deltaY * fraction ) );

	}
	return best;

}
