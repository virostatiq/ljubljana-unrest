import { resourceDefinitions } from './resources.ts';
import { commandDefinitions } from './commands.ts';
import { terrainDefinitions } from './terrain.ts';

export const SDK_VERSION = 1;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const text = ( value ) => typeof value === 'string' && value.trim() !== '';
const dense = ( value, check ) => Array.isArray( value ) && Array.from( value ).every( check );

export function check( condition: unknown, path: string, message: string ): asserts condition {

	if ( ! condition ) throw new Error( `${path}: ${message}` );

}

export function fields( value: unknown, allowed: readonly string[], path: string ): asserts value is Record<string, any> {

	check( value !== null && typeof value === 'object' && ! Array.isArray( value ), path, 'must be an object' );
	for ( const key of Object.keys( value ) ) check( allowed.includes( key ), `${path}.${key}`, 'unsupported field in this SDK preview' );

}

export function point( value: any, path: string ): readonly [ number, number ] {

	check( dense( value, Number.isFinite ) && value.length === 2, path, 'must be two finite coordinates in meters' );
	return Object.freeze( [ ...value ] ) as readonly [ number, number ];

}

export function place( name ) {

	check( text( name ), 'place.name', 'must be a non-empty string' );
	return Object.freeze( { kind: 'place', name } );

}

export function target( name ) {

	check( text( name ), 'target.name', 'must be a non-empty string' );
	return Object.freeze( { kind: 'target', name } );

}

export function landmark( name ) {

	check( text( name ), 'landmark.name', 'must be a non-empty string' );
	return Object.freeze( { kind: 'landmark', name } );

}

export function holdBuilding( options ) {

	fields( options, [ 'id', 'target', 'seconds', 'label', 'reason', 'exitAt' ], 'objective' );
	check( typeof options.target === 'string' && ID.test( options.target ), 'objective.target', 'must be a target alias' );
	const { target: alias, exitAt = {}, ...timed } = options;
	fields( exitAt, Object.keys( exitAt ), 'objective.exitAt' );
	const exits = Object.fromEntries( Object.entries( exitAt ).map( ( [ index, at ] ) => {

		check( /^(0|[1-9][0-9]*)$/.test( index ), 'objective.exitAt', 'keys must be zero-based exit indices' );
		return [ index, point( at, `objective.exitAt.${index}` ) ];

	} ) );
	return Object.freeze( { ...survive( { seconds: 720, label: 'Hold the building', reason: 'The building held.', ...timed } ),
		kind: 'hold-building', target: alias, exitAt: Object.freeze( exits ) } );

}

export function defineOutcome( rule ) {

	fields( rule, [ 'id', 'evaluate', 'kind' ], 'outcome' );
	check( rule.kind === undefined || rule.kind === 'outcome', 'outcome.kind', 'must be an outcome rule' );
	check( typeof rule.id === 'string' && ID.test( rule.id ), 'outcome.id', 'must be a lowercase slug' );
	check( typeof rule.evaluate === 'function', 'outcome.evaluate', 'must be a synchronous rule function' );
	return Object.freeze( { kind: 'outcome', id: rule.id, evaluate: rule.evaluate } );

}

const METRIC_COUNTERS = [ 'injuriesByPolice', 'otherInjuries', 'officersInjured', 'arrests', 'sitterArrests', 'peopleGone', 'gasUsed', 'shotsFired', 'treatedByMedics', 'peopleKilled', 'officersKilled' ];

function metricIndicators( values ) {

	check( dense( values, ( value ) => value && typeof value === 'object' && ! Array.isArray( value ) ), 'scenario.indicators', 'must be a dense array of metric thresholds' );
	const indicators = values.map( ( value ) => {

		fields( value, [ 'id', 'label', 'counter', 'maximum', 'warnAt' ], 'scenario.indicator' );
		check( typeof value.id === 'string' && ID.test( value.id ), 'scenario.indicator.id', 'must be a lowercase slug' );
		check( text( value.label ), 'scenario.indicator.label', 'must be non-empty text' );
		check( METRIC_COUNTERS.includes( value.counter ), 'scenario.indicator.counter', 'unknown semantic counter' );
		check( Number.isFinite( value.maximum ) && value.maximum > 0, 'scenario.indicator.maximum', 'must be positive and finite' );
		check( value.warnAt === undefined || ( Number.isFinite( value.warnAt ) && value.warnAt >= 0 && value.warnAt <= value.maximum ),
			'scenario.indicator.warnAt', 'must be between zero and maximum' );
		return Object.freeze( { ...value } );

	} );
	check( new Set( indicators.map( ( value ) => value.id ) ).size === indicators.length, 'scenario.indicators', 'IDs must be unique' );
	return Object.freeze( indicators );

}

export function survive( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason' ], 'objective' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'objective.id', 'must be a lowercase slug' );
	check( Number.isFinite( options.seconds ) && options.seconds > 0, 'objective.seconds', 'must be positive and finite' );
	for ( const key of [ 'label', 'reason' ] ) if ( options[ key ] !== undefined ) check( text( options[ key ] ), `objective.${key}`, 'must be a non-empty string' );
	return Object.freeze( { kind: 'survive', id: options.id, seconds: options.seconds,
		label: options.label ?? 'Hold position', reason: options.reason ?? 'Objective complete.' } );

}

export function holdCrowd( options ) {

	fields( options, [ 'id', 'at', 'radius', 'minimumPeople', 'holdSeconds', 'timeoutSeconds', 'minimumAlive', 'minimumAliveAfter',
		'label', 'reason', 'populationFailureReason', 'timeoutReason' ], 'objective' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'objective.id', 'must be a lowercase slug' );
	check( typeof options.at === 'string' || Array.isArray( options.at ), 'objective.at', 'must be a location alias or coordinates' );
	const at = Array.isArray( options.at ) ? point( options.at, 'objective.at' ) : options.at;
	const { radius, minimumPeople, holdSeconds, timeoutSeconds, minimumAlive = 0, minimumAliveAfter = 0 } = options;
	check( Number.isFinite( radius ) && radius > 0 && radius <= 1000, 'objective.radius', 'must be positive and at most 1000 meters' );
	check( Number.isInteger( minimumPeople ) && minimumPeople > 0, 'objective.minimumPeople', 'must be a positive integer' );
	check( Number.isFinite( holdSeconds ) && holdSeconds > 0, 'objective.holdSeconds', 'must be positive and finite' );
	check( Number.isFinite( timeoutSeconds ) && timeoutSeconds >= holdSeconds, 'objective.timeoutSeconds', 'must be finite and at least holdSeconds' );
	check( Number.isInteger( minimumAlive ) && minimumAlive >= 0, 'objective.minimumAlive', 'must be a non-negative integer' );
	check( Number.isFinite( minimumAliveAfter ) && minimumAliveAfter >= 0 && minimumAliveAfter <= timeoutSeconds,
		'objective.minimumAliveAfter', 'must be between zero and timeoutSeconds' );
	for ( const key of [ 'label', 'reason', 'populationFailureReason', 'timeoutReason' ] ) if ( options[ key ] !== undefined ) {
		check( text( options[ key ] ), `objective.${key}`, 'must be non-empty text' );
	}
	return Object.freeze( { kind: 'hold-crowd', id: options.id, at, radius, minimumPeople, holdSeconds, timeoutSeconds, minimumAlive, minimumAliveAfter,
		label: options.label ?? 'Hold the square', reason: options.reason ?? 'The crowd held the square.',
		populationFailureReason: options.populationFailureReason ?? 'The protest fizzled out.',
		timeoutReason: options.timeoutReason ?? 'The square was never held long enough.' } );

}

export function preventClash( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason', 'failureReason' ], 'objective' );
	check( options.failureReason === undefined || text( options.failureReason ), 'objective.failureReason', 'must be non-empty text' );
	const { failureReason, ...timed } = options;
	return Object.freeze( { ...survive( { label: 'Keep them apart for 12:00', reason: 'The march ended without a brawl.', ...timed } ),
		kind: 'prevent-clash', failureReason: failureReason ?? 'A full street brawl erupted between the two crowds.' } );

}

export function escortConvoy( options ) {

	fields( options, [ 'id', 'convoy', 'seconds', 'maxBlocked', 'label', 'reason', 'blockedReason', 'integrityReason', 'timeoutReason' ], 'objective' );
	check( typeof options.convoy === 'string' && ID.test( options.convoy ), 'objective.convoy', 'must be a convoy ID' );
	const maxBlocked = options.maxBlocked ?? 75;
	check( Number.isFinite( maxBlocked ) && maxBlocked > 0, 'objective.maxBlocked', 'must be positive and finite' );
	for ( const key of [ 'blockedReason', 'integrityReason', 'timeoutReason' ] ) if ( options[ key ] !== undefined ) check( text( options[ key ] ), `objective.${key}`, 'must be non-empty text' );
	const { convoy, maxBlocked: ignored, blockedReason, integrityReason, timeoutReason, ...timed } = options;
	return Object.freeze( { ...survive( { seconds: 900, label: 'Escort the convoy', reason: 'The convoy arrived at its destination.', ...timed } ),
		kind: 'escort-convoy', convoy, maxBlocked, blockedReason: blockedReason ?? 'The convoy was stuck too long.',
		integrityReason: integrityReason ?? 'The VIP vehicle was overrun.', timeoutReason: timeoutReason ?? 'The convoy did not reach its destination in time.' } );

}

export function protect( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason', 'protected' ], 'objective' );
	check( typeof options.protected === 'string' && ID.test( options.protected ), 'objective.protected', 'must be a protected identity ID' );
	const { protected: entity, ...timed } = options;
	return Object.freeze( { ...survive( { label: 'Protect the person', reason: 'The protected person is safe.', ...timed } ),
		kind: 'protect', protected: entity } );

}

export function extract( options ) {

	fields( options, [ 'id', 'seconds', 'label', 'reason', 'protected', 'at', 'radius' ], 'objective' );
	const { at, radius = 10, ...protectedOptions } = options;
	check( Number.isFinite( radius ) && radius > 0 && radius <= 100, 'objective.radius', 'must be positive and at most 100 meters' );
	check( typeof at === 'string' || Array.isArray( at ), 'objective.at', 'must be a location alias or coordinates' );
	return Object.freeze( { ...protect( { label: 'Extract the person', reason: 'The protected person escaped.', ...protectedOptions } ),
		kind: 'extract', at: Array.isArray( at ) ? point( at, 'objective.at' ) : at, radius } );

}

function configuration( value, path ) {

	if ( value === null || typeof value === 'string' || typeof value === 'boolean' ) return value;
	if ( typeof value === 'number' ) { check( Number.isFinite( value ), path, 'must be finite' ); return value; }
	if ( Array.isArray( value ) ) {

		check( Array.from( value ).every( ( entry ) => entry !== undefined ), path, 'must be a dense configuration array' );
		return Object.freeze( value.map( ( entry, index ) => configuration( entry, `${path}[${index}]` ) ) );

	}
	check( value !== undefined && typeof value === 'object' && [ Object.prototype, null ].includes( Object.getPrototypeOf( value ) ),
		path, 'must contain only plain configuration data' );
	return Object.freeze( Object.fromEntries( Object.entries( value ).map( ( [ key, entry ] ) => [ key, configuration( entry, `${path}.${key}` ) ] ) ) );

}

export function defineBehavior( definition ) {

	fields( definition, [ 'id', 'create', 'validate' ], 'behavior' );
	check( typeof definition.id === 'string' && ID.test( definition.id ), 'behavior.id', 'must be a lowercase slug' );
	check( typeof definition.create === 'function', 'behavior.create', 'must be a function returning fresh hooks' );
	check( definition.validate === undefined || typeof definition.validate === 'function', 'behavior.validate', 'must be a function' );
	const { id: type, create, validate } = definition;
	return ( options ) => {

		check( typeof options?.id === 'string' && ID.test( options.id ), 'behavior.instance.id', 'must be a lowercase slug' );
		const detached = configuration( options, `behavior.${options.id}.options` );
		validate?.( detached );
		return Object.freeze( { kind: 'behavior', id: options.id, type, options: detached, create } );

	};

}

function behaviorAttachment( value ) {

	fields( value, [ 'kind', 'id', 'type', 'options', 'create' ], 'scenario.behavior' );
	check( value.kind === 'behavior', 'scenario.behavior', 'must be a behavior attachment' );
	return defineBehavior( { id: value.type, create: value.create } )( { ...value.options, id: value.id } );

}

// per-person opinion change for each new injury/arrest counted in the stats; defaults match the base Mission
export const OPINION_WEIGHTS = Object.freeze( { injuriesByPolice: - 0.5, officersInjured: 0.25, arrests: - 0.05, sitterArrests: - 0.15, otherInjuries: - 0.05 } );

function opinionPolicy( value = {} ) {

	fields( value, [ 'initial', 'gas', 'water', 'weights' ], 'scenario.opinion' );
	const initial = value.initial ?? 60, gas = value.gas ?? - 2, water = value.water ?? - 2, weights = value.weights ?? {};
	check( Number.isFinite( initial ) && initial >= 0 && initial <= 100, 'scenario.opinion.initial', 'must be from 0 to 100' );
	for ( const [ key, cost ] of [ [ 'gas', gas ], [ 'water', water ] ] ) check( Number.isFinite( cost ) && cost >= - 100 && cost <= 0, `scenario.opinion.${key}`, 'must be a cost from -100 to 0' );
	fields( weights, Object.keys( OPINION_WEIGHTS ), 'scenario.opinion.weights' );
	for ( const [ key, weight ] of Object.entries( weights ) ) check( Number.isFinite( weight ) && Math.abs( weight ) <= 10, `scenario.opinion.weights.${key}`, 'must be finite and at most 10 in size' );
	return Object.freeze( { initial, gas, water, weights: Object.freeze( { ...OPINION_WEIGHTS, ...weights } ) } );

}

export function defineScenario( options ) {

	fields( options, [ 'id', 'title', 'subtitle', 'brief', 'side', 'city', 'map', 'goals', 'tips', 'locations', 'setup', 'objectives', 'behaviors', 'resources', 'commands', 'initiallyLockedCommands', 'score', 'menu', 'seed', 'outcomes', 'indicators', 'phase', 'opinion', 'hud', 'terrain' ], 'scenario' );
	check( typeof options.id === 'string' && ID.test( options.id ), 'scenario.id', 'must be a lowercase slug' );
	for ( const key of [ 'title', 'subtitle', 'brief' ] ) check( text( options[ key ] ), `scenario.${key}`, 'must be a non-empty string' );
	check( options.side === undefined || [ 'police', 'protest' ].includes( options.side ), 'scenario.side', 'must be police or protest' );
	check( options.city == null || ( typeof options.city === 'string' && /^[a-z0-9_-]+$/.test( options.city ) ), 'scenario.city', 'must be a city id' );
	check( options.map == null || ( typeof options.map === 'string' && /^[a-z0-9_-]+$/.test( options.map ) ), 'scenario.map', 'must be a map name' );
	for ( const key of [ 'goals', 'tips' ] ) check( dense( options[ key ] ?? [], text ), `scenario.${key}`, 'must be a dense array of non-empty strings' );
	check( options.setup === undefined || typeof options.setup === 'function', 'scenario.setup', 'must be a function' );
	check( options.score == null || typeof options.score === 'function', 'scenario.score', 'must be a synchronous scoring function' );
	check( options.menu === undefined || typeof options.menu === 'boolean', 'scenario.menu', 'must be a boolean' );
	check( options.seed == null || ( Number.isInteger( options.seed ) && options.seed >= 0 && options.seed <= 0xffffffff ), 'scenario.seed', 'must be an unsigned 32-bit integer' );
	check( options.phase == null || typeof options.phase === 'function', 'scenario.phase', 'must be a synchronous phase-text function' );
	check( options.hud == null || typeof options.hud === 'function', 'scenario.hud', 'must be a synchronous HUD-rows function' );
	const locations = Object.create( null );
	fields( options.locations ?? {}, Object.keys( options.locations ?? {} ), 'scenario.locations' );
	for ( const [ id, reference ] of Object.entries( options.locations ?? {} ) ) {

		check( ID.test( id ), `scenario.locations.${id}`, 'must be a lowercase slug' );
		if ( Array.isArray( reference ) ) locations[ id ] = point( reference, `scenario.locations.${id}` );
		else {

			fields( reference, [ 'kind', 'name' ], `scenario.locations.${id}` );
			check( [ 'place', 'target', 'landmark' ].includes( reference.kind ), `scenario.locations.${id}`, 'must be a place, landmark, target reference or coordinates' );
			locations[ id ] = reference.kind === 'target' ? target( reference.name ) : reference.kind === 'landmark' ? landmark( reference.name ) : place( reference.name );

		}

	}

	check( Array.isArray( options.objectives ) && options.objectives.length === 1 && [ 'survive', 'protect', 'extract', 'hold-building', 'hold-crowd', 'prevent-clash', 'escort-convoy' ].includes( options.objectives[ 0 ]?.kind ),
		'scenario.objectives', 'this SDK preview requires exactly one supported objective' );
	check( dense( options.behaviors ?? [], ( entry ) => entry?.kind === 'behavior' ), 'scenario.behaviors', 'must be a dense array of behavior attachments' );
	const behaviors = ( options.behaviors ?? [] ).map( behaviorAttachment );
	check( new Set( behaviors.map( ( entry ) => entry.id ) ).size === behaviors.length, 'scenario.behaviors', 'instance IDs must be unique' );
	check( dense( options.outcomes ?? [], ( entry ) => entry?.kind === 'outcome' ), 'scenario.outcomes', 'must be a dense array of outcome rules' );
	const outcomes = ( options.outcomes ?? [] ).map( ( entry ) => defineOutcome( entry ) );
	check( new Set( outcomes.map( ( entry ) => entry.id ) ).size === outcomes.length, 'scenario.outcomes', 'rule IDs must be unique' );
	const indicators = metricIndicators( options.indicators ?? [] );
	const { kind, ...objective } = options.objectives[ 0 ];
	const resources = resourceDefinitions( options.resources ), commands = commandDefinitions( options.commands, resources );
	const initiallyLockedCommands = options.initiallyLockedCommands ?? [];
	check( dense( initiallyLockedCommands, ( id ) => typeof id === 'string' && commands.some( ( command ) => command.id === id ) ),
		'scenario.initiallyLockedCommands', 'must be a dense list of declared command IDs' );
	check( new Set( initiallyLockedCommands ).size === initiallyLockedCommands.length, 'scenario.initiallyLockedCommands', 'IDs must be unique' );
	return Object.freeze( { kind: 'scenario', sdkVersion: SDK_VERSION, id: options.id, title: options.title,
		subtitle: options.subtitle, brief: options.brief, side: options.side ?? 'police', city: options.city ?? null, map: options.map ?? null,
		goals: Object.freeze( [ ...( options.goals ?? [] ) ] ), tips: Object.freeze( [ ...( options.tips ?? [] ) ] ), menu: options.menu ?? true,
		locations: Object.freeze( locations ), setup: options.setup, score: options.score ?? null, seed: options.seed ?? null,
		behaviors: Object.freeze( behaviors ), outcomes: Object.freeze( outcomes ), indicators, phase: options.phase ?? null, hud: options.hud ?? null, opinion: opinionPolicy( options.opinion ), terrain: terrainDefinitions( options.terrain ),
		initiallyLockedCommands: Object.freeze( [ ...initiallyLockedCommands ] ), resources, commands,
		objectives: Object.freeze( [ kind === 'hold-building' ? holdBuilding( objective ) : kind === 'hold-crowd' ? holdCrowd( objective ) : kind === 'escort-convoy' ? escortConvoy( objective ) : kind === 'prevent-clash' ? preventClash( objective )
			: kind === 'extract' ? extract( objective ) : kind === 'protect' ? protect( objective ) : survive( objective ) ] ) } );

}

export function normalizeScenario( value ) {

	check( value?.kind === 'scenario' && value.sdkVersion === SDK_VERSION, 'scenario', 'expected an SDK v1 scenario definition' );
	const { kind, sdkVersion, ...options } = value;
	return defineScenario( options );

}