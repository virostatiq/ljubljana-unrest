import { check, fields } from './definition.ts';

export class EffectHost {

	declare runtime: any;
	declare pending: Map<any, any>;
	constructor( runtime ) { this.runtime = runtime; this.pending = new Map(); }
	context( owner = null ) {

		return Object.freeze( { nudge: ( person, options ) => {

			if ( owner ) this.runtime.behaviors.writable( owner );
			this.runtime.writable(); fields( options, [ 'agitation', 'resolve', 'expectedSample' ], 'effects.nudge' );
			const record = this.runtime.identity.personRecord( person );
			check( Number.isInteger( options.expectedSample ) && options.expectedSample > 0, 'effects.expectedSample', 'must identify a sample' );
			for ( const key of [ 'agitation', 'resolve' ] ) check( options[ key ] === undefined || Number.isFinite( options[ key ] ) && Math.abs( options[ key ] ) <= 2, `effects.${key}`, 'must be finite and within two' );
			if ( options.expectedSample !== this.runtime.observation?.sequence ) return Object.freeze( { status: 'rejected', code: 'STALE_OBSERVATION' } );
			if ( record.sample?.status !== 'active' || record.transport ) return Object.freeze( { status: 'rejected', code: 'PERSON_UNAVAILABLE' } );
			return this.runtime.adapter.nudgePerson( record.backend, options.agitation ?? 0, options.resolve ?? 0 );

		}, apply: ( person, options ) => {

			if ( owner ) this.runtime.behaviors.writable( owner );
			return this.apply( person, options );

		} } );

	}
	apply( handle, options ) {

		this.runtime.writable(); fields( options, [ 'status', 'source', 'expectedSample' ], 'effects.apply' );
		check( [ 'injured', 'dead', 'detained', 'removed' ].includes( options.status ), 'effects.status', 'unsupported person effect' );
		check( options.source === undefined || [ 'police', 'other' ].includes( options.source ), 'effects.source', 'must be police or other' );
		check( Number.isInteger( options.expectedSample ) && options.expectedSample > 0, 'effects.expectedSample', 'must identify a sample' );
		const person = this.runtime.identity.personRecord( handle ), reject = ( code ) => Object.freeze( { status: 'rejected', code } );
		if ( options.expectedSample !== this.runtime.observation?.sequence ) return reject( 'STALE_OBSERVATION' );
		if ( person.pending || person.transport ) return reject( 'CONTROL_BUSY' );
		if ( this.pending.has( handle ) ) return reject( 'EFFECT_PENDING' );
		if ( ! person.sample || ! [ 'active', 'injured' ].includes( person.sample.status ) || options.status === 'injured' && person.sample.status !== 'active' ) return reject( 'PERSON_UNAVAILABLE' );
		const result = this.runtime.adapter.applyPersonEffect( person.backend, options.status, options.source ?? 'other' );
		if ( result.status !== 'queued' ) return reject( result.code );
		const receipt = Object.freeze( { person: handle, status: options.status, source: options.source ?? 'other', sample: options.expectedSample, step: this.runtime.step } );
		this.pending.set( handle, receipt ); this.runtime.event( 'effect.queued', receipt );
		return Object.freeze( { status: 'queued', value: receipt } );

	}
	observe( sample ) {

		for ( const [ handle, receipt ] of this.pending ) {

			if ( sample.step <= receipt.step ) continue;
			const person = this.runtime.identity.getPerson( handle ); if ( ! person ) continue;
			const expected = receipt.status === 'removed' ? 'gone' : receipt.status;
			this.pending.delete( handle );
			this.runtime.event( person.status === expected ? 'effect.confirmed' : 'effect.rejected', { ...receipt, observed: person.status } );

		}

	}

}
