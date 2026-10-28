import { check, fields } from './definition.ts';

export class BehaviorHost {

	declare runtime: any;
	declare instances: Map<any, any>;
	declare cleanup: Set<any>;

	constructor( runtime ) {

		this.runtime = runtime;
		this.instances = new Map<any, any>();
		this.cleanup = new Set<any>();

	}

	setup() {

		for ( const attachment of this.runtime.definition.behaviors ) {

			const hooks = attachment.create( attachment.options );
			if ( hooks && typeof hooks.then === 'function' ) {

				Promise.resolve( hooks ).catch( () => {} );
				throw new Error( `behavior.${attachment.id}.create: must synchronously return fresh hooks` );

			}
			fields( hooks, [ 'start', 'update', 'observe', 'onEvent', 'onAction', 'stop' ], `behavior.${attachment.id}.hooks` );
			for ( const [ name, hook ] of Object.entries( hooks ) ) check( typeof hook === 'function', `behavior.${attachment.id}.${name}`, 'must be a function' );
			const instance: { id: string, state: string, hooks: Record<string, any>, controller: AbortController, operations: Set<any>, timers: any[], context?: any } = { id: attachment.id, state: 'attached', hooks, controller: new AbortController(), operations: new Set<any>(), timers: [] };
			instance.context = Object.freeze( Object.create( this.runtime.context, Object.fromEntries( Object.entries( {
				id: instance.id,
				signal: instance.controller.signal,
				people: this.runtime.identity.peopleContext( instance ),
				effects: this.runtime.effects.context( instance ),
				opinion: Object.freeze( { adjust: ( delta, reason ) => { this.writable( instance ); this.runtime.context.opinion.adjust( delta, reason ); } } ),
				actors: Object.freeze( { ...this.runtime.context.actors,
					split: ( actor ) => { this.writable( instance ); return this.runtime.splitActor( actor ); },
					merge: ( actors ) => { this.writable( instance ); return this.runtime.mergeActors( actors ); },
					configure: ( actor, options ) => { this.writable( instance ); return this.runtime.configureActor( actor, options ); },
					recruit: ( actor ) => { this.writable( instance ); return this.runtime.recruitActor( actor ); } } ),
				protected: this.runtime.identity.context( instance ),
				vehicles: this.runtime.transport.context( instance ),
				commands: this.runtime.commands.context( instance ),
				convoys: this.runtime.convoys.context( instance ),
				crowd: Object.freeze( {
					setMode: ( actor, mode ) => { this.writable( instance ); return this.runtime.context.crowd.setMode( actor, mode ); },
					nudge: ( actor, options ) => { this.writable( instance ); return this.runtime.context.crowd.nudge( actor, options ); },
					recall: ( actor, floor ) => { this.writable( instance ); return this.runtime.context.crowd.recall( actor, floor ); },
					setMorale: ( actor, morale ) => { this.writable( instance ); return this.runtime.context.crowd.setMorale( actor, morale ); },
				} ),
				presentation: Object.freeze( { markers: ( markers ) => {

					this.writable( instance ); this.runtime.setMarkers( instance, markers );

				}, focus: ( at, zoom ) => {

					this.writable( instance ); this.runtime.context.presentation.focus( at, zoom );

				}, notice: ( text, kind, at ) => {

					this.writable( instance ); this.runtime.context.presentation.notice( text, kind, at );

				}, coach: ( card ) => {

					this.writable( instance ); this.runtime.showCoach( instance, card );

				} } ),
				spawn: Object.freeze( {
					crowd: ( options ) => { this.writable( instance ); return this.runtime.spawn( 'crowd', options, instance ); },
					squad: ( options ) => { this.writable( instance ); return this.runtime.spawn( 'squad', options, instance ); },
					vehicle: ( options ) => { this.writable( instance ); return this.runtime.spawn( 'vehicle', options, instance ); },
				} ),
				movement: Object.freeze( { stop: ( actor ) => {

					this.writable( instance ); return this.runtime.movement.stopActor( instance, actor );

				}, move: ( actor, at, options ) => {

					this.writable( instance );
					return this.runtime.move( instance, actor, at, options );

				} } ),
				timeline: Object.freeze( { after: ( seconds, callback ) => this.after( instance, seconds, callback ) } ),
				complete: () => this.stop( instance, 'completed' ),
			} ).map( ( [ name, value ] ) => [ name, { value, enumerable: true } ] ) ) ) );
			this.instances.set( instance.id, instance );

		}

	}

	writable( instance ) {

		check( [ 'starting', 'active' ].includes( instance.state ), `behavior.${instance.id}`, `cannot mutate while ${instance.state}` );
		this.runtime.writable();

	}

	async bounded( promise, path, signal? ) {

		let timer, abort;
		try {

			return await Promise.race( [ promise, new Promise( ( _, reject ) => {

				timer = setTimeout( () => reject( new Error( `${path}: timed out` ) ), this.runtime.timeout );
				abort = () => reject( new Error( `${path}: interrupted` ) );
				if ( signal?.aborted ) abort();
				else signal?.addEventListener( 'abort', abort, { once: true } );

			} ) ] );

		} finally { clearTimeout( timer ); if ( abort ) signal?.removeEventListener( 'abort', abort ); }

	}

	invoke( instance, name, args = [], asyncAllowed = false ) {

		try {

			const result = instance.hooks[ name ]?.( instance.context, ...args );
			if ( result && typeof result.then === 'function' && ! asyncAllowed ) {

				Promise.resolve( result ).catch( () => {} );
				throw new Error( 'must be synchronous; start asynchronous work through owned operations' );

			}
			return result;

		} catch ( error ) { throw new Error( `behavior.${instance.id}.${name}: ${error.message}`, { cause: error } ); }

	}

	async start() {

		for ( const instance of this.instances.values() ) {

			if ( instance.state !== 'attached' ) continue;
			check( this.runtime.state === 'starting', 'runtime.start', 'interrupted' );
			instance.state = 'starting';
			const result = this.invoke( instance, 'start', [], true );
			if ( result && typeof result.then === 'function' ) {

				try { await this.bounded( result, `behavior.${instance.id}.start`, instance.controller.signal ); }
				catch ( error ) { throw new Error( `behavior.${instance.id}.start: ${error.message}`, { cause: error } ); }

			}
			if ( instance.state === 'starting' ) instance.state = 'active';

		}

	}

	dispatch( name, ...args ) {

		for ( const instance of this.instances.values() ) if ( instance.state === 'active' ) this.invoke( instance, name, args );

	}

	after( instance, seconds, callback ) {

		this.writable( instance );
		check( Number.isFinite( seconds ) && seconds >= 0, 'timeline.after.seconds', 'must be non-negative and finite' );
		check( typeof callback === 'function', 'timeline.after.callback', 'must be a function' );
		const timer = { at: this.runtime.time + seconds, callback, state: 'pending' };
		instance.timers.push( timer );
		return Object.freeze( { get state() { return timer.state; }, cancel: () => { if ( timer.state === 'pending' ) timer.state = 'cancelled'; } } );

	}

	update( dt ) {

		for ( const instance of this.instances.values() ) {

			if ( instance.state !== 'active' ) continue;
			const due = instance.timers.filter( ( timer ) => timer.state === 'pending' && timer.at <= this.runtime.time );
			instance.timers = instance.timers.filter( ( timer ) => timer.state === 'pending' );
			for ( const timer of due ) {

				if ( instance.state !== 'active' || timer.state !== 'pending' ) continue;
				timer.state = 'completed';
				this.invoke( { ...instance, hooks: { timer: timer.callback } }, 'timer' );

			}
			instance.timers = instance.timers.filter( ( timer ) => timer.state === 'pending' );
			if ( instance.state === 'active' ) this.invoke( instance, 'update', [ dt ] );

		}

	}

	stop( instance, reason ) {

		if ( ! [ 'attached', 'starting', 'active' ].includes( instance.state ) ) return;
		instance.state = reason === 'completed' ? 'completed' : 'stopped';
		instance.controller.abort( reason );
		this.runtime.clearCoach( instance );
		this.runtime.markerOwners.delete( instance );
		this.runtime.commands.releaseOwner( instance );
		for ( const timer of instance.timers ) if ( timer.state === 'pending' ) timer.state = 'cancelled';
		instance.timers = [];
		for ( const operation of [ ...instance.operations ] ) operation.cancel( reason );
		this.runtime.stopOwnerMovement( instance );
		this.runtime.transport.stopOwner( instance );
		this.runtime.identity.stopOwner( instance );
		this.runtime.releaseOwnerActors( instance );
		try {

			const result = instance.hooks.stop?.( Object.freeze( {
				time: this.runtime.time, observation: this.runtime.observation, signal: instance.controller.signal,
			} ), reason );
			if ( result && typeof result.then === 'function' ) {

				const cleanup = this.bounded( result, `behavior.${instance.id}.stop` ).catch( ( error ) => this.runtime.cleanupErrors.push( error ) );
				this.cleanup.add( cleanup );
				cleanup.then( () => this.cleanup.delete( cleanup ) );

			}

		} catch ( error ) { this.runtime.cleanupErrors.push( new Error( `behavior.${instance.id}.stop: ${error.message}`, { cause: error } ) ); }

	}

	stopAll( reason ) {

		for ( const instance of this.instances.values() ) this.stop( instance, reason );

	}

}