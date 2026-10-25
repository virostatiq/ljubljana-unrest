import { check, point } from './definition.ts';

export function createScenarioPlaytest( game, { timeout = 30000 } = {} ) {

	check( Number.isFinite( timeout ) && timeout > 0 && timeout <= 30000, 'playtest.timeout', 'must be positive and at most 30000 milliseconds' );
	let advancing = false, timedOut = false;
	const current = () => {

		check( game.mission?.runtime, 'playtest', 'requires an SDK scenario' );
		return game.mission.runtime;

	};
	const snapshot = () => {

		const runtime = current(), flow = game.world.flow;
		return Object.freeze( { id: runtime.definition.id, time: runtime.time, state: runtime.state,
			paused: game.paused, sampleAge: runtime.observation ? runtime.time - runtime.observation.sampledAt : null,
			pendingOperations: runtime.operations.size, error: runtime.error?.message ?? null,
			result: runtime.result, metrics: runtime.metrics(), objectives: Object.freeze( runtime.objectives() ),
			navigation: Object.freeze( { capacity: flow.layers, allocated: flow.slots.filter( Boolean ).length,
				referenced: flow.slots.filter( ( slot ) => slot?.refs > 0 ).length, pending: flow.pending.size, queued: flow.queue.length } ) } );

	};
	return Object.freeze( {
		snapshot,
		pause() { check( ! advancing, 'playtest.pause', 'advance in progress' ); game.paused = true; current().pause( true ); },
		frame( at, metersPerPixel = 0.8 ) {

			current();
			check( Number.isFinite( metersPerPixel ) && metersPerPixel >= game.controls.minMpp && metersPerPixel <= game.controls.maxMpp, 'playtest.frame', 'invalid zoom' );
			game.controls.center.set( ...point( at, 'playtest.frame.at' ) ); game.controls.mpp = metersPerPixel; game.controls.update();

		},
		project( at ) { current(); return point( game.controls.worldToScreen( ...point( at, 'playtest.project.at' ) ), 'playtest.project.result' ); },
		async advance( seconds ) {

			check( Number.isFinite( seconds ) && seconds > 0 && seconds <= 30, 'playtest.advance', 'seconds must be positive and at most 30' );
			check( ! advancing, 'playtest.advance', 'advance in progress' );
			check( ! timedOut, 'playtest.advance', 'previous advance timed out; page reload required' );
			const runtime = current();
			check( [ 'running', 'paused' ].includes( runtime.state ), 'playtest.advance', 'scenario is not running' );
			advancing = true;
			let timer;
			try {

				await Promise.race( [ ( async () => {

					await game.advance( seconds );
					while ( runtime.operations.size && [ 'running', 'paused' ].includes( runtime.state ) ) {

						await Promise.all( [ ...runtime.operations ].map( ( operation ) => operation.settled ) );

					}

				} )(), new Promise( ( _, reject ) => { timer = setTimeout( () => { timedOut = true; reject( new Error( 'playtest.advance: wall-clock limit exceeded; page reload required' ) ); }, timeout ); } ) ] );
				game.paused = true; runtime.pause( true );
				return snapshot();

			}
			finally { clearTimeout( timer ); game.paused = true; runtime.pause( true ); advancing = false; }

		},
	} );

}
