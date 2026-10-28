import { check, fields, point } from './definition.ts';
import { captureState, personTransition, protectionRules } from './protection.ts';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class IdentityHost {

	declare runtime: any;
	declare people: Map<any, any>;
	declare byKey: Map<any, any>;
	declare entities: Map<any, any>;
	declare nextPerson: number;
	declare snapshots: any;
	declare membershipEvents: any[];
	declare availableActors: Set<any>;

	constructor( runtime ) {

		this.runtime = runtime;
		this.people = new Map<any, any>();
		this.byKey = new Map<any, any>();
		this.entities = new Map<any, any>();
		this.nextPerson = 1;
		this.snapshots = Object.freeze( [] );
		this.membershipEvents = [];
		this.availableActors = new Set<any>();

	}

	personRecord( handle ) {

		const record = this.people.get( handle?.id );
		check( handle?.run === this.runtime.run && record?.handle === handle, 'people.get', 'unknown or foreign person handle' );
		return record;

	}

	entityRecord( handle ) {

		const record = this.entities.get( handle?.id );
		check( handle?.run === this.runtime.run && record?.handle === handle, 'protected.get', 'unknown or foreign protected handle' );
		return record;

	}

	getPerson( handle ) { return this.personRecord( handle ).sample ?? null; }
	actorProtected( handle ) { return [ ...this.entities.values() ].some( ( entity ) => entity.actor === handle ); }
	get( handle ) { return this.snapshot( this.entityRecord( handle ) ); }

	peopleContext( owner = null ) {

		return Object.freeze( {
			members: ( actor ) => this.members( actor ), get: ( handle ) => this.getPerson( handle ),
			state: ( handle ) => this.personState( handle ),
			transfer: ( handle, options ) => {

				if ( owner ) this.runtime.behaviors.writable( owner );
				return this.transferPerson( handle, options );

			},
		} );

	}

	personState( handle ) {

		const person = this.personRecord( handle );
		return Object.freeze( { handle, actor: person.actor, revision: person.revision ?? 0,
			pending: person.pending ? Object.freeze( { ...person.pending } ) : null,
			transport: person.transport ? Object.freeze( { vehicle: person.transport.vehicle.actor.handle, state: person.transport.state } ) : null } );

	}

	transferPerson( handle, options, recoveryEntity = null ) {

		this.runtime.writable();
		fields( options, [ 'to', 'expectedRevision', 'expectedSample', 'promote' ], 'people.transfer' );
		const person = this.personRecord( handle );
		check( Number.isInteger( options.expectedRevision ) && options.expectedRevision >= 0, 'people.expectedRevision', 'must be a non-negative revision' );
		check( Number.isInteger( options.expectedSample ) && options.expectedSample > 0, 'people.expectedSample', 'must identify an observation' );
		check( options.promote === undefined || typeof options.promote === 'boolean', 'people.promote', 'must be a boolean' );
		const targetHandle = typeof options.to === 'string' ? this.runtime.context.actors.resolve( options.to ) : options.to;
		const target = this.runtime.actors.get( targetHandle?.id );
		check( target?.handle === targetHandle && targetHandle.run === this.runtime.run && target.backend !== null, 'people.to', 'unknown or unavailable actor' );
		const reject = ( code ) => Object.freeze( { status: 'rejected', code } );
		if ( options.expectedRevision !== ( person.revision ?? 0 ) ) return reject( 'STALE_REVISION' );
		if ( options.expectedSample !== this.runtime.observation?.sequence ) return reject( 'STALE_OBSERVATION' );
		if ( person.pending ) return reject( 'MEMBERSHIP_PENDING' );
		if ( person.transport ) return reject( 'PERSON_IN_TRANSPORT' );
		if ( this.runtime.commands?.claims.has( person.actor ) || this.runtime.commands?.claims.has( targetHandle ) ) return reject( 'CONTROL_BUSY' );
		if ( this.runtime.transport?.locked( person.actor ) || this.runtime.transport?.locked( targetHandle ) ) return reject( 'BOARDING_PENDING' );
		if ( person.sample?.status !== 'active' ) return reject( 'PERSON_UNAVAILABLE' );
		if ( person.actor === targetHandle ) return reject( 'ALREADY_MEMBER' );
		const attached = [ ...this.entities.values() ].filter( ( entity ) => entity.carrier === handle );
		if ( attached.some( ( entity ) => entity.rules && ! entity.rules.friendly.includes( targetHandle.id ) ) ) return reject( 'PROTECTED_TARGET' );
		for ( const entity of this.entities.values() ) {

			const protectedActor = entity.actor ?? ( entity.rules && entity.subject ? this.people.get( entity.subject.id )?.actor : null );
			if ( protectedActor === targetHandle && ! attached.includes( entity ) && entity !== recoveryEntity ) return reject( 'PROTECTED_TARGET' );

		}
		const result = this.runtime.adapter.transferPerson( person.backend, target.backend, {
			promote: options.promote === true, sample: this.runtime.lastSample,
		} );
		check( result && [ 'completed', 'rejected' ].includes( result.status ), 'people.transfer', 'adapter returned no transaction receipt' );
		if ( result.status === 'rejected' ) return reject( result.code );
		const previous = person.actor;
		person.actor = targetHandle; person.backend = result.backend; person.revision = ( person.revision ?? 0 ) + 1;
		person.pending = { step: this.runtime.step, sample: this.runtime.observation.sequence };
		for ( const entity of attached ) { entity.actor = targetHandle; entity.revision ++; }
		this.refresh();
		this.runtime.event( 'person.transferred', { person: handle, previous, actor: targetHandle, revision: person.revision } );
		for ( const entity of attached ) this.runtime.event( 'protected.carrier-changed', {
			entity: entity.handle, carrier: handle, actor: targetHandle, revision: entity.revision,
		} );
		return Object.freeze( { status: 'completed', value: this.personState( handle ) } );

	}

	context( owner = null ) {

		const mutate = ( action ) => {

			if ( owner ) this.runtime.behaviors.writable( owner );
			return action();

		};
		return Object.freeze( {
			create: ( options ) => mutate( () => this.create( options, owner ) ),
			resolve: ( id ) => { check( this.entities.has( id ), 'protected.resolve', `unknown identity '${id}'` ); return this.entities.get( id ).handle; },
			get: ( handle ) => this.get( handle ),
			transfer: ( handle, options ) => mutate( () => this.transfer( handle, options ) ),
			drop: ( handle, options ) => mutate( () => this.drop( handle, options ) ),
		} );

	}

	members( actor ) {

		const handle = typeof actor === 'string' ? this.runtime.context.actors.resolve( actor ) : actor;
		this.runtime.actor( handle );
		return Object.freeze( [ ...this.people.values() ].filter( ( record ) => record.sample?.actor === handle ).map( ( record ) => record.sample ) );

	}

	create( options, owner = null ) {

		this.runtime.writable();
		fields( options, [ 'id', 'label', 'carrier', 'kind', 'protection' ], 'protected.create' );
		check( typeof options.id === 'string' && ID.test( options.id ), 'protected.id', 'must be a lowercase slug' );
		check( ! this.entities.has( options.id ), 'protected.id', 'is already allocated' );
		check( options.label === undefined || ( typeof options.label === 'string' && options.label.trim() !== '' ), 'protected.label', 'must be non-empty text' );
		const actor = typeof options.carrier === 'string' ? this.runtime.context.actors.resolve( options.carrier ) : options.carrier;
		check( this.runtime.actors.get( actor?.id )?.handle === actor, 'protected.carrier', 'must be a registered actor' );
		check( actor.kind !== 'vehicle', 'protected.carrier', 'must be a population actor' );
		check( ! [ ...this.entities.values() ].some( ( entity ) => entity.actor === actor ), 'protected.carrier', 'actor already carries a protected identity' );
		check( options.kind === undefined || options.kind === 'object' || options.kind === 'person', 'protected.kind', 'must be object or person' );
		check( options.kind === 'person' || options.protection === undefined, 'protected.protection', 'requires a protected person' );
		const rules = options.kind === 'person' ? protectionRules( options.protection ) : null;
		if ( rules ) {

			for ( const id of [ ...rules.friendly, ...rules.hostile ] ) check( this.runtime.context.actors.resolve( id ).kind !== 'vehicle', `protection.${id}`, 'requires a population actor' );
			check( rules.friendly.includes( actor.id ), 'protected.protection.friendly', 'must include the initial actor' );

		}
		const handle = Object.freeze( { id: options.id, kind: rules ? 'protected-person' : 'protected-object', run: this.runtime.run } );
		this.entities.set( handle.id, { handle, label: options.label ?? options.id, revision: 0, state: 'pending',
			carrier: null, actor, position: null, owner, subject: null, rules, capture: null } );
		this.refresh();
		return handle;

	}

	snapshot( entity ) {

		return Object.freeze( { handle: entity.handle, label: entity.label, revision: entity.revision, state: entity.state,
			carrier: entity.carrier, actor: entity.actor, position: entity.position ? point( entity.position, 'protected.position' ) : null,
			subject: entity.subject, capture: entity.capture,
			transport: entity.transport ? Object.freeze( { vehicle: entity.transport.vehicle.actor.handle, state: entity.transport.state } ) : null } );

	}

	collect( sample, stamp = { step: this.runtime.step ?? 0 } ) {

		this.membershipEvents = [];
		this.availableActors = new Set<any>();
		for ( const record of this.people.values() ) record.sample = null;
		for ( const actor of this.runtime.actors.values() ) {

			if ( actor.backend === null ) continue;
			const members = this.runtime.adapter.readPeople?.( actor.backend, sample );
			if ( ! members ) continue;
			this.availableActors.add( actor.handle.id );
			for ( const member of members ) {

				check( member.key !== undefined && member.key !== null, 'person.key', 'adapter must supply a stable identity' );
				let person = this.byKey.get( member.key );
				if ( ! person ) {

					const handle = Object.freeze( { id: `person-${this.nextPerson ++}`, kind: 'person', run: this.runtime.run } );
					person = { handle, sample: null, backend: member.backend, actor: actor.handle, revision: 0, pending: null };
					this.byKey.set( member.key, person ); this.people.set( handle.id, person );

				}
				if ( member.membershipMatches === false || ( person.pending && ( stamp.step <= person.pending.step || actor.handle !== person.actor ) ) ) {

					this.availableActors.delete( actor.handle.id );
					continue;

				}
				check( person.sample === null, 'person.membership', 'one person cannot belong to multiple actors' );
				check( [ 'active', 'injured', 'detained', 'gone', 'dead' ].includes( member.status ), 'person.status', 'adapter returned an invalid status' );
				person.backend = member.backend;
				if ( person.pending ) this.membershipEvents.push( { type: 'person.membership-confirmed', person: person.handle,
					actor: person.actor, revision: person.revision } );
				person.pending = null;
				person.actor = actor.handle;
				const faction = member.faction ?? ( actor.handle.kind === 'squad' ? 'police' : 'protester' ), agitation = member.agitation ?? 0;
				check( [ 'protester', 'police', 'bystander', 'counter' ].includes( faction ), 'person.faction', 'adapter returned an invalid faction' );
				check( Number.isFinite( agitation ) && agitation >= 0 && agitation <= 1, 'person.agitation', 'must be between 0 and 1' );
				person.sample = Object.freeze( { handle: person.handle, actor: actor.handle, status: member.status,
					injurySource: member.injurySource ?? null,
					leader: member.leader === true, position: point( member.position, 'person.position' ),
					faction, agitation, identified: member.identified === true } );

			}

		}
		return Object.freeze( [ ...this.people.values() ].filter( ( person ) => person.sample ).map( ( person ) => person.sample ) );

	}

	reconcile( { elapsed = 0 } = {} ) {

		const events = this.membershipEvents;
		this.membershipEvents = [];
		for ( const entity of this.entities.values() ) {

			if ( entity.transport ) continue;
			if ( entity.state === 'pending' ) {

				const leader = this.members( entity.actor ).find( ( person ) => person.leader && ( entity.rules || person.status === 'active' ) );
				if ( ! leader ) continue;
				entity.carrier = leader.handle; entity.state = entity.rules ? 'active' : 'carried'; entity.revision ++;
				if ( entity.rules ) entity.subject = leader.handle;
				events.push( { type: 'protected.carrier-changed', entity: entity.handle, carrier: leader.handle, actor: entity.actor, revision: entity.revision } );

			}
			if ( entity.rules ) {

				const carrier = entity.carrier ? this.getPerson( entity.carrier ) : null;
				const subject = entity.subject ? this.people.get( entity.subject.id )?.sample : null;
				if ( carrier ) entity.position = carrier.position;
				const transition = personTransition( entity, subject, carrier );
				if ( transition ) events.push( this.transitionPerson( entity, transition.state, transition.reason ) );
				if ( [ 'active', 'down', 'carried' ].includes( entity.state ) ) {

					const people = [ ...this.people.values() ].filter( ( person ) => person.sample ).map( ( person ) => person.sample );
					const shielded = ! ( entity.state === 'down' ) && this.runtime.adapter.protectedShielded?.( entity.actor ) === true;
					entity.capture = captureState( entity, entity.rules, people, this.availableActors, transition ? 0 : elapsed, shielded );
					if ( entity.capture.available && entity.capture.held >= entity.capture.required ) events.push( this.transitionPerson( entity, 'captured', 'hostile pressure' ) );

				}
				continue;

			}
			if ( entity.state !== 'carried' ) continue;
			const carrier = this.getPerson( entity.carrier );
			if ( ! carrier ) continue;
			entity.position = carrier.position;
			if ( carrier.status !== 'active' ) {

				entity.carrier = null; entity.actor = null; entity.state = 'dropped'; entity.revision ++;
				events.push( { type: 'protected.dropped', entity: entity.handle, position: entity.position, revision: entity.revision, reason: carrier.status } );

			} else entity.actor = carrier.actor;

		}
		this.refresh();
		return events;

	}

	transitionPerson( entity, state, reason ) {

		const previous = entity.state;
		entity.state = state; entity.carrier = null; entity.actor = null; entity.revision ++;
		if ( state === 'down' ) entity.capture = Object.freeze( { held: 0, required: entity.rules.downSeconds,
			pressure: false, available: false, friendly: 0, hostile: 0 } );
		return { type: 'protected.state-changed', entity: entity.handle, subject: entity.subject, previous, state,
			position: entity.position, revision: entity.revision, reason };

	}

	refresh() { this.snapshots = Object.freeze( [ ...this.entities.values() ].map( ( entity ) => this.snapshot( entity ) ) ); }

	transfer( entityHandle, options ) {

		this.runtime.writable();
		fields( options, [ 'carrier', 'expectedRevision', 'expectedSample', 'promote', 'radius', 'joinGroup' ], 'protected.transfer' );
		const entity = this.entityRecord( entityHandle ), person = this.personRecord( options.carrier );
		if ( options.joinGroup !== undefined ) {

			fields( options.joinGroup, [ 'speed' ], 'protected.transfer.joinGroup' );
			check( Number.isFinite( options.joinGroup.speed ) && options.joinGroup.speed >= 0 && options.joinGroup.speed <= 4,
				'protected.transfer.joinGroup.speed', 'must be from zero to four' );

		}
		check( Number.isInteger( options.expectedRevision ) && options.expectedRevision >= 0, 'protected.expectedRevision', 'must be a non-negative revision' );
		check( Number.isInteger( options.expectedSample ) && options.expectedSample > 0, 'protected.expectedSample', 'must identify an observation' );
		check( options.promote === undefined || typeof options.promote === 'boolean', 'protected.promote', 'must be a boolean' );
		const radius = options.radius ?? 12;
		check( Number.isFinite( radius ) && radius > 0 && radius <= 100, 'protected.radius', 'must be positive and at most 100 meters' );
		if ( entity.revision !== options.expectedRevision ) return Object.freeze( { status: 'rejected', code: 'STALE_REVISION' } );
		if ( this.runtime.observation?.sequence !== options.expectedSample ) return Object.freeze( { status: 'rejected', code: 'STALE_OBSERVATION' } );
		if ( entity.transport || person.transport ) return Object.freeze( { status: 'rejected', code: 'TRANSPORT_STATE' } );
		if ( this.runtime.commands?.claims.has( person.actor ) ) return Object.freeze( { status: 'rejected', code: 'CONTROL_BUSY' } );
		if ( this.runtime.transport?.locked( person.actor ) ) return Object.freeze( { status: 'rejected', code: 'MEMBERSHIP_PENDING' } );
		if ( entity.rules && [ 'captured', 'dead' ].includes( entity.state ) ) return Object.freeze( { status: 'rejected', code: 'TERMINAL_STATE' } );
		if ( entity.rules && ! [ 'down', 'carried' ].includes( entity.state ) ) return Object.freeze( { status: 'rejected', code: 'NOT_DOWN' } );
		if ( person.pending ) return Object.freeze( { status: 'rejected', code: 'MEMBERSHIP_PENDING' } );
		if ( person.sample?.status !== 'active' ) return Object.freeze( { status: 'rejected', code: 'CARRIER_UNAVAILABLE' } );
		if ( entity.carrier === person.handle ) return Object.freeze( { status: 'rejected', code: 'ALREADY_CARRIER' } );
		if ( ! entity.position || Math.hypot( person.sample.position[ 0 ] - entity.position[ 0 ], person.sample.position[ 1 ] - entity.position[ 1 ] ) > radius ) return Object.freeze( { status: 'rejected', code: 'OUT_OF_RANGE' } );
		if ( entity.rules ) {

			if ( ! entity.rules.friendly.includes( person.sample.actor.id ) ) return Object.freeze( { status: 'rejected', code: 'RECOVERY_BLOCKED' } );
			if ( Math.hypot( person.sample.position[ 0 ] - entity.position[ 0 ], person.sample.position[ 1 ] - entity.position[ 1 ] ) > ( entity.rules.downRadius ?? entity.rules.radius ) ) return Object.freeze( { status: 'rejected', code: 'OUT_OF_RANGE' } );
			if ( ! entity.capture?.available ) return Object.freeze( { status: 'rejected', code: 'OBSERVATION_UNAVAILABLE' } );
			if ( entity.capture.friendly < entity.rules.recoveryMinimum || entity.capture.hostile >= entity.capture.friendly ) return Object.freeze( { status: 'rejected', code: 'RECOVERY_BLOCKED' } );

		}
		for ( const other of this.entities.values() ) if ( other !== entity && ( other.carrier === person.handle || other.actor === person.sample.actor ) ) return Object.freeze( { status: 'rejected', code: 'CARRIER_BUSY' } );
		let joinedGroup = false;
		if ( options.joinGroup !== undefined ) {

			if ( ! entity.rules || entity.state !== 'down' || ! entity.subject ) return Object.freeze( { status: 'rejected', code: 'NOT_DOWN' } );
			const subject = this.people.get( entity.subject.id ), targetActor = subject?.actor, target = targetActor && this.runtime.actors.get( targetActor.id );
			if ( ! target || target.handle !== targetActor || target.backend === null || targetActor.kind === 'vehicle'
				|| ! entity.rules.friendly.includes( targetActor.id ) ) return Object.freeze( { status: 'rejected', code: 'PROTECTED_TARGET' } );
			if ( person.actor !== targetActor ) {

				const joined = this.transferPerson( person.handle, { to: targetActor, expectedRevision: person.revision ?? 0,
					expectedSample: options.expectedSample, promote: options.promote === true }, entity );
				if ( joined.status !== 'completed' ) return Object.freeze( joined );

			} else if ( options.promote ) this.runtime.adapter.promoteLeader( person.backend, person.sample.position );
			check( typeof this.runtime.adapter.configureActor === 'function', 'protected.transfer.joinGroup', 'host does not support group configuration' );
			this.runtime.adapter.configureActor( target.backend, { speed: options.joinGroup.speed } );
			joinedGroup = true;

		}
		if ( options.promote && ! joinedGroup && options.joinGroup === undefined ) this.runtime.adapter.promoteLeader( person.backend, person.sample.position );
		entity.carrier = person.handle; entity.actor = person.actor; entity.position = person.sample.position;
		entity.state = 'carried'; entity.revision ++;
		if ( entity.rules ) entity.capture = Object.freeze( { ...entity.capture, held: 0, required: entity.rules.seconds } );
		this.refresh();
		this.runtime.event( 'protected.carrier-changed', { entity: entity.handle, carrier: person.handle, actor: entity.actor, revision: entity.revision } );
		return Object.freeze( { status: 'completed', value: this.snapshot( entity ) } );

	}

	drop( entityHandle, options ) {

		this.runtime.writable();
		fields( options, [ 'expectedRevision', 'expectedSample' ], 'protected.drop' );
		const entity = this.entityRecord( entityHandle );
		check( Number.isInteger( options.expectedRevision ) && options.expectedRevision >= 0, 'protected.expectedRevision', 'must be a non-negative revision' );
		check( Number.isInteger( options.expectedSample ) && options.expectedSample > 0, 'protected.expectedSample', 'must identify an observation' );
		if ( entity.revision !== options.expectedRevision ) return Object.freeze( { status: 'rejected', code: 'STALE_REVISION' } );
		if ( this.runtime.observation?.sequence !== options.expectedSample ) return Object.freeze( { status: 'rejected', code: 'STALE_OBSERVATION' } );
		if ( entity.transport ) return Object.freeze( { status: 'rejected', code: 'TRANSPORT_STATE' } );
		if ( entity.state !== 'carried' ) return Object.freeze( { status: 'rejected', code: 'NOT_CARRIED' } );
		if ( entity.rules ) {

			const event = this.transitionPerson( entity, 'down', 'released' );
			this.refresh(); this.runtime.event( event.type, event );
			return Object.freeze( { status: 'completed', value: this.snapshot( entity ) } );

		}
		entity.carrier = null; entity.actor = null; entity.state = 'dropped'; entity.revision ++;
		this.refresh();
		this.runtime.event( 'protected.dropped', { entity: entity.handle, position: entity.position, revision: entity.revision, reason: 'released' } );
		return Object.freeze( { status: 'completed', value: this.snapshot( entity ) } );

	}

	remove( entity ) {

		this.runtime.transport?.releaseEntity( entity );
		this.entities.delete( entity.handle.id );
		this.refresh();
		this.runtime.event( 'protected.removed', { entity: entity.handle, reason: 'owner stopped' } );

	}

	stopOwner( owner ) {

		for ( const entity of [ ...this.entities.values() ] ) if ( entity.owner === owner ) this.remove( entity );

	}

	releaseActor( actor ) {

		for ( const entity of this.entities.values() ) if ( entity.actor === actor ) {

			if ( entity.rules ) {

				const event = this.transitionPerson( entity, 'down', 'actor removed' );
				this.runtime.event( event.type, event );
				continue;

			}
			entity.carrier = null; entity.actor = null; entity.state = 'dropped'; entity.revision ++;
			this.runtime.event( 'protected.dropped', { entity: entity.handle, position: entity.position, revision: entity.revision, reason: 'actor removed' } );

		}
		for ( const [ key, person ] of this.byKey ) if ( person.actor === actor ) {

			this.people.delete( person.handle.id ); this.byKey.delete( key );

		}
		this.refresh();

	}

	dispose() { this.entities.clear(); this.people.clear(); this.byKey.clear(); this.refresh(); }

}