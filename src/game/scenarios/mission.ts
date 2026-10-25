import { Mission } from '../mission.ts';
import { ORANGE } from '../sdk/colors.ts';
import { prepareTerrain } from './terrain.ts';
import { normalizeScenario } from './definition.ts';
import { ScenarioEngine } from './engine.ts';
import { ScenarioRuntime, formatTime } from './runtime.ts';

const MARKER_COLORS = { info: 'rgb(43,140,255)', good: 'rgb(79,209,139)', warn: ORANGE, bad: 'rgb(255,45,85)' };

export function scenarioMission( value ) {

	const definition = normalizeScenario( value );
	return class ScenarioMission extends Mission {

		declare runtime: ScenarioRuntime;
		declare leave: any;
		declare started: Promise<void>;

		static id = definition.id;
		static prepare( city ) { prepareTerrain( city, definition.terrain ); }
		static title = definition.title;
		static subtitle = definition.subtitle;
		static brief = definition.brief;
		static side = definition.side;
		static city = definition.city;
		static map = definition.map;
		static goals = definition.goals;
		static tips = definition.tips;
		static menu = definition.menu;
		static sdkScenario = true;

		constructor( game ) {

			super( game );
			this.opinion = definition.opinion.initial;
			this.gasOpinion = definition.opinion.gas;
			this.waterOpinion = definition.opinion.water;
			this.runtime = new ScenarioRuntime( definition, new ScenarioEngine( this ), {
				onFinish: ( result ) => { this.result = result; game.finish( result ); },
				onFailure: ( error ) => {

					game.paused = true;
					console.error( `Scenario ${definition.id}:`, error );
					game.hud.modal( '' );
					const panel = document.createElement( 'div' );
					panel.className = 'card';
					const title = document.createElement( 'h1' ), message = document.createElement( 'p' ), button = document.createElement( 'button' );
					title.textContent = 'Scenario failed';
					message.textContent = error.message;
					button.textContent = 'Back to missions';
					button.onclick = () => game.toMenu();
					panel.append( title, message, button );
					const modal = game.hud.modal( '' );
					modal.appendChild( panel );
					modal.hidden = false;

				},
			} );
			const runtime = this.runtime;
			this.resources = Object.fromEntries( Object.keys( definition.resources ).map( ( id ) => [ id, Object.freeze( {
				max: definition.resources[ id ].capacity,
				get left() { return runtime.resources.get( id ).available; },
				get ready() { return runtime.resources.get( id ).readyIn; },
			} ) ] ) );
			this.leave = () => this.runtime.dispose();
			window.addEventListener( 'pagehide', this.leave, { once: true } );

		}

		async setup() {

			await this.world.exits();
			await this.runtime.setup();

		}

		start() {

			this.runtime.observe( this.world.intel );
			this.game.paused = true;
			this.started = this.runtime.start();
			this.started.then( () => {

				if ( this.runtime.state === 'running' ) this.game.paused = false;

			}, () => {} );

		}

		observationStamp() { return { sampledAt: this.runtime.time, step: this.runtime.step }; }

		onObservation( sample, stamp ) {

			try { this.runtime.observe( sample, stamp ); } catch ( error ) { this.runtime.fail( error ); }

		}

		onPlayerMovement( action ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return true;
			try {

				const kind = definition.side === 'protest' ? 'crowd' : 'squad';
				for ( const handle of this.selectionHandles( action.units, kind ) ) this.runtime.playerMove( handle, action.at,
					definition.side === 'police' && action.type === 'line' ? { line: action.a } : {} );

			} catch ( error ) { this.runtime.fail( error ); }
			return true;

		}

		onPlayerVehicleDrive( action ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return true;
			const record = [ ...this.runtime.actors.values() ].find( ( actor ) => actor.backend === action.vehicle );
			if ( ! record ) return false;
			try {

				const vehicle = this.runtime.context.vehicles.get( record.handle );
				const result = this.runtime.transport.drive( null, record.handle, action.at, { expectedRevision: vehicle.revision } );
				if ( result.status === 'rejected' ) this.event( `${action.vehicle.label}: ${result.code.toLowerCase().replaceAll( '_', ' ' )}`, 'warn', action.at );

			} catch ( error ) { this.runtime.fail( error ); }
			return true;

		}

		selectionHandles( groups, kind = 'squad' ) {

			return [ ...this.runtime.actors.values() ].filter( ( record ) => record.handle.kind === kind && ( kind === 'vehicle'
				? groups.includes( record.backend ) : Array.isArray( record.backend ) && record.backend.some( ( group ) => groups.includes( group ) ) ) ).map( ( record ) => record.handle );

		}

		executeCommand( id, x, y, source = 'player' ) {

			if ( ! [ 'running', 'paused' ].includes( this.runtime.state ) ) return;
			const command = this.runtime.commands.list().find( ( entry ) => entry.id === id );
			const kind = command.forCars ? 'vehicle' : command.side === 'protest' ? 'crowd' : 'squad';
			const operation = this.runtime.commands.execute( null, id, { at: [ x, y ],
				selection: command.needsSelection ? this.selectionHandles( command.forCars ? this.game.cars : command.side === 'protest' ? this.game.selected : this.game.squads, kind ) : [] }, source );
			operation.settled.then( ( outcome: any ) => {

				this.escalation = this.runtime.commands.escalation;
				if ( outcome.status === 'rejected' ) this.event( `${command.label}: ${outcome.code.toLowerCase().replaceAll( '_', ' ' )}`, 'warn', [ x, y ] );

			} );
			return operation;

		}

		onCommandBlocked( key ) {

			const command = this.runtime.commands.list().find( ( entry ) => entry.key === key && ( entry.side === 'protest' ) === ( definition.side === 'protest' ) );
			if ( command && ! command.danger ) return this.executeCommand( command.id, this.game.mouse.x, this.game.mouse.y );

		}

		openFire() {

			return this.executeCommand( 'firearms', this.game.mouse.x, this.game.mouse.y, 'confirmed-player' );

		}

		onSnatchOutcome( group, target, result ) {

			const event = this.runtime.adapter.snatchOutcome( group, target, result );
			if ( event ) this.runtime.event( event.type, event );

		}

		update( dt, stats ) {

			this.stats = stats;
			try {

				if ( stats ) this._trackOpinion( stats );
				this.t = this.runtime.time + dt;
				const due = this.timers.filter( ( timer ) => timer.at <= this.t ); this.timers = this.timers.filter( ( timer ) => timer.at > this.t );
				for ( const timer of due ) timer.fn();
				if ( this.shelters.some( ( shelter ) => shelter.until <= this.t ) ) { this.shelters = this.shelters.filter( ( shelter ) => shelter.until > this.t ); this.crowd.setShelter( this.shelters.map( ( shelter ) => shelter.id ) ); }
				if ( definition.side === 'protest' ) this.fireTick( dt );
				this.runtime.pause( false );
				this.runtime.update( dt );
				this.t = this.runtime.time;
				this.escalation = this.runtime.commands.escalation;

			} catch ( error ) { this.runtime.fail( error ); }

		}

		onAction( action ) {

			if ( action.type === 'pause' ) this.runtime.pause( action.paused );
			const rawSelection = action.units ?? this.game.selected;
			const kind = definition.side === 'protest' ? 'crowd' : 'squad';
			const selection = [ ...this.selectionHandles( rawSelection, kind ), ...this.selectionHandles( rawSelection, 'vehicle' ) ];
			const safe: Record<string, any> = { type: action.type, selection: Object.freeze( selection ) };
			for ( const key of [ 'how', 'key', 'paused', 'speed', 'muted' ] ) if ( action[ key ] !== undefined ) safe[ key ] = action[ key ];
			for ( const key of [ 'at', 'a' ] ) if ( action[ key ] ) safe[ key === 'a' ? 'line' : key ] = Object.freeze( [ ...action[ key ] ] );
			if ( action.car ) {

				const vehicle = [ ...this.runtime.actors.values() ].find( ( record ) => record.handle.kind === 'vehicle' && record.backend === action.car );
				if ( vehicle ) safe.vehicle = vehicle.handle;

			}
			this.runtime.playerAction( Object.freeze( safe ) );

		}

		commands() {

			const movement = [ { key: 'rmb', label: 'Move', hint: 'right-click', needsSel: true } ];
			return [ ...movement,
				...( definition.side === 'police' ? [ { key: 'l', label: 'Cordon line', needsSel: true, run: () => this.game.drawLine() } ] : [] ),
				...this.runtime.commands.list().filter( ( command ) => ( command.side === 'protest' ) === ( definition.side === 'protest' ) ).map( ( command ) => ( { key: command.key, label: command.label,
					needsSel: command.needsSelection, resource: command.resource, forCars: command.forCars, forCordon: command.id === 'shield-push', aim: command.aim,
					danger: command.danger,
					desc: command.id === 'reinforce' ? 'Dispatch a fresh squad from the nearest police station to this point'
						: command.id === 'gas' ? 'Deploy a tear gas cloud at this point' : undefined,
					run: command.id === 'firearms' ? () => this.game.confirmFirearms()
						: command.immediate ? () => this.executeCommand( command.id, this.game.mouse.x, this.game.mouse.y )
						: ( x, y ) => this.executeCommand( command.id, x, y ),
				} ) ),
			];

		}

		phase() { return this.runtime.phase(); }
		objectives() { return this.runtime.objectives(); }

		opinionWeights() {

			const w = definition.opinion.weights;
			return { injByPolice: w.injuriesByPolice, injPolice: w.officersInjured, arrested: w.arrests, arrestedSitters: w.sitterArrests, injOther: w.otherInjuries };

		}

		draw( overlay ) {

			if ( definition.objectives[ 0 ].kind === 'hold-building' && this.runtime.buildingState ) {

				const objective = definition.objectives[ 0 ], state = this.runtime.buildingState;
				const target = this.runtime.spatial.prepareBuilding( objective.target, objective.exitAt );
				this.drawZone( overlay, ...( target.position as [ number, number ] ), target.radius + 10, state.breach > 0.3 ? 'rgb(255,45,85)' : 'rgb(255,176,32)', target.name, 0.05 + state.breach * 0.2 );
				target.exits.forEach( ( at, index ) => this.drawZone( overlay, ...( at as [ number, number ] ), 12, state.blocked[ index ] ? 'rgb(255,45,85)' : 'rgb(233,228,216)', `EXIT ${index + 1}` ) );

			}
			for ( const marker of this.runtime.markers() ) {

				if ( marker.shape ) {

					const ctx = overlay.ctx, color = MARKER_COLORS[ marker.kind ]; ctx.beginPath();
					marker.points.forEach( ( at, index ) => { const [ x, y ] = overlay.toScreen( at[ 0 ], at[ 1 ] ); if ( index ) ctx.lineTo( x, y ); else ctx.moveTo( x, y ); } );
					if ( marker.shape === 'polygon' ) { ctx.closePath(); ctx.fillStyle = color.replace( ')', ',0.12)' ).replace( 'rgb', 'rgba' ); ctx.fill(); }
					ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash( marker.shape === 'path' ? [ 4, 8 ] : [] ); ctx.stroke(); ctx.setLineDash( [] );
					const [ x, y ] = overlay.toScreen( marker.at[ 0 ], marker.at[ 1 ] ); ctx.fillStyle = color; ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.textAlign = 'center'; ctx.fillText( marker.label, x, y - 8 );

				} else this.drawZone( overlay, marker.at[ 0 ], marker.at[ 1 ], marker.radius, MARKER_COLORS[ marker.kind ], marker.label );

			}
			for ( const entity of this.runtime.identity.snapshots ) {

				if ( ! entity.position ) continue;
				const danger = [ 'dropped', 'down', 'captured', 'dead' ].includes( entity.state );
				const label = entity.handle.kind === 'protected-person' ? `${entity.label} · ${entity.state.toUpperCase()}` : entity.label;
				this.drawZone( overlay, ...( entity.position as [ number, number ] ), 5, danger ? 'rgb(255,45,85)' : 'rgb(255,176,32)', label );

			}
			this.drawCustody( overlay );

		}

		drawCustody( o ) {

			const jobs = this.runtime.custody.jobs;
			if ( ! jobs ) return;
			const ctx = o.ctx, cap = jobs.options.capacity;
			ctx.font = '600 10px "IBM Plex Mono", monospace';
			ctx.textAlign = 'center';
			for ( const v of jobs.dropoffs ) {

				const [ x, y ] = o.toScreen( ...v.at );
				ctx.fillStyle = v.blocked ? 'rgb(255,45,85)' : 'rgb(43,140,255)';
				ctx.fillText( v.blocked ? 'VAN · BLOCKADED' : 'PRISONER VAN', x, y - 14 );

			}
			// detainees held by each squad: small dots round it, and the spot it is working
			for ( const [ s, j ] of jobs.jobs ) {

				if ( ! s.center ) continue;
				const [ x, y ] = o.toScreen( ...s.center );
				let sitters = 0;
				for ( const [ actor, n ] of j.byActor ) if ( actor !== null && jobs.env.sittingActor( actor ) ) sitters += n;
				for ( let k = 0; k < j.held; k ++ ) {

					const a = k / cap * Math.PI * 2 + this.runtime.time * 0.5, r = 6 / o.mpp + 4;
					ctx.fillStyle = k < sitters ? 'rgb(233,228,216)' : 'rgb(255,106,16)';
					ctx.beginPath(); ctx.arc( x + Math.cos( a ) * r, y + Math.sin( a ) * r, 2.5, 0, Math.PI * 2 ); ctx.fill();

				}
				if ( j.held || j.state !== 'idle' ) {

					ctx.fillStyle = 'rgb(43,140,255)';
					ctx.fillText( `${j.held}/${cap}${j.state === 'cart' ? ' → VAN' : j.state === 'unload' ? ( j.van.blocked ? ' VAN BLOCKED' : ' HANDING OVER' ) : ''}`, x, y + 6 / o.mpp + 16 );

				}
				if ( ( j.state === 'arrest' || j.state === 'approach' ) && j.at ) {

					const [ ax, ay ] = o.toScreen( ...j.at );
					ctx.strokeStyle = 'rgba(43,140,255,0.7)';
					ctx.setLineDash( [ 3, 4 ] );
					ctx.beginPath(); ctx.arc( ax, ay, 12 / o.mpp, 0, Math.PI * 2 ); ctx.stroke();
					ctx.setLineDash( [] );

				}

			}

		}

	};

}