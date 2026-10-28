import { check, fields } from './definition.ts';

export function protectionRules( options ) {

	fields( options, [ 'friendly', 'hostile', 'radius', 'downRadius', 'seconds', 'downSeconds', 'minimum', 'downMinimum', 'advantage', 'recoveryMinimum', 'captureRate' ], 'protection' );
	const rules: Record<string, any> = { radius: 8, seconds: 4, downSeconds: 8, minimum: 2, downMinimum: 4, advantage: 2, recoveryMinimum: 4, ...options };
	if ( options.captureRate !== undefined ) {

		fields( options.captureRate, [ 'perHostile', 'maximum', 'shieldMultiplier' ], 'protection.captureRate' );
		const captureRate = { perHostile: 0.5, maximum: 2, shieldMultiplier: 0.5, ...options.captureRate };
		for ( const key of [ 'perHostile', 'maximum' ] ) check( Number.isFinite( captureRate[ key ] ) && captureRate[ key ] > 0 && captureRate[ key ] <= 10, `protection.captureRate.${key}`, 'must be positive, finite and at most 10' );
		check( Number.isFinite( captureRate.shieldMultiplier ) && captureRate.shieldMultiplier >= 0 && captureRate.shieldMultiplier <= 1,
			'protection.captureRate.shieldMultiplier', 'must be between zero and one' );
		rules.captureRate = Object.freeze( captureRate );

	}
	rules.downRadius ??= rules.radius;
	for ( const key of [ 'friendly', 'hostile' ] ) {

		check( Array.isArray( rules[ key ] ) && rules[ key ].length > 0 && Array.from( rules[ key ] ).every( ( id ) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test( id ) ), `protection.${key}`, 'must be a non-empty dense array of actor IDs' );
		check( new Set( rules[ key ] ).size === rules[ key ].length, `protection.${key}`, 'actor IDs must be unique' );
		rules[ key ] = Object.freeze( [ ...rules[ key ] ] );

	}
	check( ! rules.friendly.some( ( id ) => rules.hostile.includes( id ) ), 'protection', 'friendly and hostile actors must not overlap' );
	for ( const key of [ 'radius', 'downRadius', 'seconds', 'downSeconds', 'advantage' ] ) check( Number.isFinite( rules[ key ] ) && rules[ key ] > 0 && rules[ key ] <= 1000, `protection.${key}`, 'must be positive, finite and at most 1000' );
	for ( const key of [ 'minimum', 'downMinimum', 'recoveryMinimum' ] ) check( Number.isInteger( rules[ key ] ) && rules[ key ] > 0, `protection.${key}`, 'must be a positive integer' );
	return Object.freeze( rules );

}

export function captureState( entity, rules, people, available, elapsed, shielded = false ) {

	check( Number.isFinite( elapsed ) && elapsed >= 0, 'protection.elapsed', 'must be non-negative and finite' );
	const down = entity.state === 'down';
	const required = down ? rules.downSeconds : rules.seconds;
	if ( ! entity.position || ! [ ...rules.friendly, ...rules.hostile ].every( ( id ) => available.has( id ) ) ) {

		return Object.freeze( { held: entity.capture?.held ?? 0, required, pressure: false, available: false, friendly: 0, hostile: 0 } );

	}
	let friendly = 0, hostile = 0;
	for ( const person of people ) {

		if ( person.status !== 'active' || person.handle === entity.subject || person.handle === entity.carrier ) continue;
		if ( Math.hypot( person.position[ 0 ] - entity.position[ 0 ], person.position[ 1 ] - entity.position[ 1 ] ) > ( down ? rules.downRadius : rules.radius ) ) continue;
		if ( rules.friendly.includes( person.actor.id ) ) friendly ++;
		if ( rules.hostile.includes( person.actor.id ) ) hostile ++;

	}
	const pressure = hostile >= ( down ? rules.downMinimum : rules.minimum ) && hostile * ( down ? 1 : rules.advantage ) > friendly;
	const rate = ! down && rules.captureRate ? Math.min( rules.captureRate.maximum, hostile * rules.captureRate.perHostile )
		* ( shielded ? rules.captureRate.shieldMultiplier : 1 ) : 1;
	const held = pressure ? Math.min( required, ( entity.capture?.held ?? 0 ) + elapsed * rate )
		: down ? 0 : Math.max( 0, ( entity.capture?.held ?? 0 ) - elapsed );
	return Object.freeze( { held, required, pressure, available: true, friendly, hostile } );

}

export function personTransition( entity, subject, carrier ) {

	if ( [ 'captured', 'dead' ].includes( entity.state ) ) return null;
	if ( subject?.status === 'dead' ) return { state: 'dead', reason: 'subject dead' };
	if ( subject?.status === 'detained' || carrier?.status === 'detained' ) return { state: 'captured', reason: 'detained' };
	if ( [ 'active', 'carried' ].includes( entity.state ) && carrier && carrier.status !== 'active' ) return { state: 'down', reason: `carrier ${carrier.status}` };
	return null;

}