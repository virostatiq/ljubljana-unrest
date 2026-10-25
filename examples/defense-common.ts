import type * as Sdk from '../src/game/scenarios/sdk.d.ts';

export function defenseTargets( ctx: Sdk.ScenarioContext, alias: string, exitAt = {} ) {

	const building = ctx.spatial.buildingGeometry( alias, exitAt ), outer = building.footprints[ 0 ], edges = [];
	for ( let index = 0; index < outer.length; index += 2 ) {

		const startX = outer[ index ], startY = outer[ index + 1 ], endX = outer[ ( index + 2 ) % outer.length ], endY = outer[ ( index + 3 ) % outer.length ];
		edges.push( { length: Math.hypot( endX - startX, endY - startY ), x: ( startX + endX ) / 2, y: ( startY + endY ) / 2 } );

	}
	return edges.sort( ( first, second ) => second.length - first.length ).slice( 0, 4 ).map( ( edge ) => {

		const deltaX = edge.x - building.position[ 0 ], deltaY = edge.y - building.position[ 1 ], distance = Math.hypot( deltaX, deltaY ) || 1;
		return ctx.spatial.sample( [ edge.x + deltaX / distance * 5, edge.y + deltaY / distance * 5 ], { radius: 4 } );

	} ).concat( building.exits );

}

export function defenseDirector( onRiot = ( actor: any ) => {} ) {

	let lastDecisionAt = 0;
	return ( ctx, groups, targets ) => {

		if ( ! ctx.observation || ctx.time - lastDecisionAt <= 20 ) return;
		lastDecisionAt = ctx.time;
		const positions = typeof targets === 'function' ? targets() : targets;
		const guards = positions.map( ( at ) => ctx.spatial.count( { at, radius: 25, faction: 'police' } ) );
		if ( guards.some( ( count ) => count === null ) ) return;
		for ( const state of groups.values() ) {

			if ( state.goalKind === 'route' || state.pending ) continue;
			const actor = ctx.actors.get( state.actor ), people = ctx.people.members( state.actor ).filter( ( person ) => person.status === 'active' );
			if ( ! actor?.center || ! people.length || ctx.random() < 0.5 ) continue;
			const agitation = people.reduce( ( total, person ) => total + person.agitation, 0 ) / people.length;
			const committed = state.goalKind === 'target', sticky = committed && ctx.time - ( state.committedAt ?? - 999 ) < 120;
			if ( ! sticky && agitation < ( committed ? 0.25 : 0.45 ) ) {

				if ( state.goalKind !== 'rally' ) {

					state.goalKind = 'rally'; ctx.movement.move( state.actor, state.rally ?? state.route.rally, { radius: state.route ? 25 : 35 } );

				}
				continue;

			}
			const riot = agitation > 0.65;
			if ( committed && ctx.random() < 0.7 ) { if ( riot ) { ctx.crowd.setMode( state.actor, 'riot' ); onRiot( state.actor ); } continue; }
			if ( ! committed ) { state.committedAt = ctx.time; ctx.presentation.notice( `${state.label}: an angry group is heading for the building`, 'warn', actor.center ); }
			state.goalKind = 'target';
			let best = positions[ 0 ], bestScore = Infinity;
			positions.forEach( ( at, index ) => {

				const score = guards[ index ] + Math.hypot( at[ 0 ] - actor.center[ 0 ], at[ 1 ] - actor.center[ 1 ] ) / 3 + ctx.random() * 25;
				if ( score < bestScore ) { bestScore = score; best = at; }

			} );
			state.target = best;
			ctx.movement.move( state.actor, best, { radius: 10 } ).settled.then( ( outcome ) => {

				if ( riot && outcome.status === 'completed' && ! ctx.signal.aborted ) { ctx.crowd.setMode( state.actor, 'riot' ); onRiot( state.actor ); }

			} ).catch( () => {} );

		}

	};

}

export function defenseWarnings( alias: string, exitAt = {} ) {

	let warnedQuarter = false, warnedHalf = false;
	return ( ctx, event ) => {

		if ( event.type !== 'building.pressure' || event.target !== alias ) return;
		const building = ctx.spatial.buildingGeometry( alias, exitAt );
		event.current.blocked.forEach( ( blocked, index ) => {

			if ( blocked !== event.previous.blocked[ index ] ) ctx.presentation.notice( `Exit ${index + 1} ${blocked ? 'blocked!' : 'cleared'}`, blocked ? 'bad' : 'good', building.exits[ index ] );

		} );
		const breach = event.current.breach;
		if ( breach > 0.25 && ! warnedQuarter ) { warnedQuarter = true; ctx.presentation.notice( 'Protesters are pressing against the doors', 'warn', building.position ); }
		if ( breach < 0.1 ) warnedQuarter = false;
		if ( breach > 0.5 && ! warnedHalf ) { warnedHalf = true; ctx.presentation.notice( 'The doors are giving way — push them off the façade!', 'bad', building.position ); }
		if ( breach < 0.3 ) warnedHalf = false;

	};

}

export function deployDefense( ctx: Sdk.ScenarioContext, alias: string, exitAt = {} ) {

	const building = ctx.spatial.buildingGeometry( alias, exitAt ), outer = building.footprints[ 0 ];
	const inside = ( x, y ) => {

		let result = false;
		for ( let current = 0, previous = outer.length - 2; current < outer.length; previous = current, current += 2 ) {

			const x0 = outer[ current ], y0 = outer[ current + 1 ], x1 = outer[ previous ], y1 = outer[ previous + 1 ];
			if ( ( y0 > y ) !== ( y1 > y ) && x < ( x1 - x0 ) * ( y - y0 ) / ( y1 - y0 ) + x0 ) result = ! result;

		}
		return result;

	};
	ctx.presentation.focus( alias, 0.55 );
	ctx.spawn.vehicle( { id: 'water-cannon', label: 'Water cannon', type: 'water-cannon', at: building.exits[ 0 ] } );
	const patrols = [ ...building.exits.slice( 1 ), ctx.locations.get( 'station' ), ctx.locations.get( 'station' ) ].slice( 0, 2 );
	for ( const [ index, at ] of patrols.entries() ) ctx.spawn.vehicle( { id: `patrol-${index + 1}`, type: 'police-patrol', at } );
	const ring = Array.from( { length: 6 }, ( _, index ) => {

		const angle = index / 6 * Math.PI * 2, deltaX = Math.cos( angle ), deltaY = Math.sin( angle ); let distance = 0;
		while ( distance < building.radius * 2 && inside( building.position[ 0 ] + deltaX * distance, building.position[ 1 ] + deltaY * distance ) ) distance ++;
		return ctx.spatial.sample( [ building.position[ 0 ] + deltaX * ( distance + 14 ), building.position[ 1 ] + deltaY * ( distance + 14 ) ], { radius: 8, streetOnly: false } );

	} );
	for ( const [ index, at ] of [ ...ring, ...building.exits, ...ring.slice( 0, 3 ) ].entries() ) ctx.spawn.squad( { id: `guard-${index + 1}`, at, people: 30 } );
	ctx.spawn.bystanders( { id: 'onlookers', people: 2200, destinations: [ 'preseren', 'kongresni', 'metelkova', 'railway', 'tivoli', 'mestni', 'dragon' ] } );

}
