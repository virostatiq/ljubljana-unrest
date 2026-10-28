import * as THREE from 'three/webgpu';
import { pass, uniform, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { loadCity, buildCityMeshes } from './city.ts';
import { PanZoom } from './controls.ts';
import { PAL } from './palette.ts';
import { FlowFields } from './sim/flowfields.ts';
import { Crowd, FACTION } from './sim/crowd.ts';
import { World } from './sim/world.ts';
import { BUILTIN } from './game/missions/index.ts';
import { MISSIONS, registerMission, findMission } from './game/registry.ts';
import { citiesFor, findCity, cityOf, mapOf } from './game/cities.ts';
import { loadPlugins } from './game/plugins.ts';
import { Patrols } from './game/patrols.ts';
import { Labels } from './labels.ts';
import { Hud } from './ui/hud.ts';
import { Overlay } from './ui/overlay.ts';
import { Sound } from './audio/sound.ts';
import { createScenarioPlaytest } from './game/scenarios/playtest.ts';

if ( location.search.includes( 'debug' ) ) THREE.Node.captureStackTrace = true;

BUILTIN.forEach( registerMission );

const DT = 1 / 60;
const SPEEDS = [ 1, 2, 3 ];
const boot = document.getElementById( 'boot' );
const fail = ( msg ) => { boot.textContent = msg; boot.classList.add( 'err' ); boot.classList.remove( 'hide' ); };
// phones: touch only and a small screen (tablets with a keyboard / mouse still get in)
const isPhone = () => navigator.userAgentData?.mobile ?? (
	/iPhone|iPod|Android.+Mobile|Windows Phone/i.test( navigator.userAgent ) ||
	( matchMedia( '(pointer: coarse)' ).matches && ! matchMedia( '(any-pointer: fine)' ).matches && Math.min( screen.width, screen.height ) < 600 ) );

class Game {

	declare renderer: THREE.WebGPURenderer;
	declare paused: any;
	declare plugins: any;
	declare city: any;
	declare scene: THREE.Scene<THREE.Object3DEventMap>;
	declare camera: THREE.OrthographicCamera;
	declare controls: PanZoom;
	declare labels: Labels;
	declare overlay: Overlay;
	declare sound: Sound;
	declare hud: Hud;
	declare pipeline: THREE.RenderPipeline;
	declare flashU: any;
	declare strobeOff: any;
	declare selected: any;
	declare speed: any;
	declare mouse: THREE.Vector2;
	declare stats: Uint32Array<any>;
	declare flow: FlowFields;
	declare crowd: Crowd;
	declare world: World;
	declare aiming: any;
	declare mission: any;
	declare frameError: any;
	declare statsBusy: boolean;
	declare intelBusy: boolean;
	declare lastIntel: number;
	declare lastHud: number;
	declare lastFrame: number;
	declare newlyIdentified: any[];
	declare lastIdMsg: any;
	declare heatMsg: Record<string, number>;
	declare drawing: any;
	declare armed: any;
	declare lineDrag: boolean;

	async init() {

		if ( isPhone() ) {

			boot.innerHTML = '<div class="phone"><h1>Cordon <span class="bleu">Bleu</span></h1>'
				+ '<p>This game can only be played on a desktop computer: it needs a mouse and a keyboard to select units and give orders.</p></div>';
			return;

		}

		if ( ! navigator.gpu ) return fail( 'This game needs WebGPU (Chrome / Edge 113+, Safari 26+; on Linux enable chrome://flags/#enable-unsafe-webgpu).' );
		const canvas = document.getElementById( 'view' ) as HTMLCanvasElement;
		this.renderer = new THREE.WebGPURenderer( { canvas, antialias: true } );
		this.renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio ) );
		this.renderer.setSize( window.innerWidth, window.innerHeight );
		await this.renderer.init();
		// the GPU gave up (a driver reset, or the browser killed a frame that took too long): say so instead of a frozen map
		const lost = this.renderer.onDeviceLost;
		this.renderer.onDeviceLost = ( info ) => {

			lost.call( this.renderer, info );
			this.paused = true;
			fail( `The graphics device was lost${info.message ? ` (${info.message})` : ''}. Reload the page to continue.` );

		};
		if ( ! ( this.renderer.backend as THREE.Backend & { isWebGPUBackend?: boolean } ).isWebGPUBackend ) return fail( 'WebGPU adapter unavailable — the crowd simulation needs compute shaders.' );

		// a mission plays on its city's map (static city and map, see game/cities.ts); ?map=<city>/<map> shows a map
		// without a mission (the map editor links there)
		const params = new URLSearchParams( location.search ), id = params.get( 'm' );
		// plugins from other sites run code in this page: only in dev, or in a build made with VITE_REMOTE_PLUGINS=1 (and the player confirms)
		this.plugins = await loadPlugins( params.getAll( 'plugin' ), { allowRemote: import.meta.env.DEV || import.meta.env.VITE_REMOTE_PLUGINS === '1' } );
		const M = findMission( id );
		const preview = ! M && /^[a-z0-9_-]+\/[a-z0-9_-]+$/.test( params.get( 'map' ) ?? '' ) ? params.get( 'map' ).split( '/' ) : null;
		const { base } = mapOf( preview ? { city: preview[ 0 ], map: preview[ 1 ] } : M );
		try {

			this.city = await loadCity( base );

		} catch {

			return fail( `No map in public/data at ${ base.slice( 2 ) }: build it first (npm run build:map).` );

		}

		boot.textContent = 'building city…';
		this.scene = new THREE.Scene();
		this.scene.background = PAL.bg;
		this.scene.add( buildCityMeshes( this.city ) );
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0.1, 1000 );
		this.controls = new PanZoom( this.camera, canvas, { bounds: this.city.bounds } );
		// holding the button while aiming aims, and while drawing a cordon (L, or Ctrl) it draws: neither pans
		this.controls.shouldPan = ( e ) => ! e.shiftKey && ! e.ctrlKey && ! this.armed && ! this.aiming && ! this.drawing;
		if ( base === './data/' ) {

			this.controls.center.set( - 250, 50 );
			this.controls.mpp = 0.9;

		} else this.frameMap();
		this.labels = new Labels( document.getElementById( 'labels' ), this.city, this.controls );
		this.overlay = new Overlay( document.getElementById( 'overlay' ), this.controls );
		this.sound = new Sound( this );
		this.hud = new Hud( this );
		this.controls.onChange = () => { if ( this.crowd ) this.crowd.u.mpp.value = this.controls.mpp; this.labels.update(); };
		this.controls.onGesture = ( kind ) => this.emit( kind );
		this.controls.update();

		this.pipeline = new THREE.RenderPipeline( this.renderer );
		const color = pass( this.scene, this.camera ).getTextureNode( 'output' );
		// strobe (Mission.strobe → this.flash): the whole scene flares white for a few frames
		this.flashU = uniform( 0 );
		this.strobeOff = false;
		try { this.strobeOff = localStorage.getItem( 'lu-strobe' ) === '0'; } catch { /* no storage: strobe stays on */ }
		const lit = color.add( bloom( color, 0.85, 0.4, 0.6 ) );
		this.pipeline.outputNode = lit.mul( this.flashU.mul( 1.4 ).add( 1 ) ).add( vec3( 0.32, 0.29, 0.26 ).mul( this.flashU ) );

		this.selected = [];
		this.paused = true;
		this.speed = 1;
		this.mouse = new THREE.Vector2();
		this.stats = null;
		window.addEventListener( 'resize', () => {

			this.renderer.setSize( window.innerWidth, window.innerHeight );
			this.overlay.resize();
			this.controls.update();

		} );
		this._input( canvas );

		if ( M ) await this.load( M );
		else if ( preview ) this.hud.preview( preview.join( '/' ), this.city, () => { location.search = this.query(); } );
		else this.home( findCity( params.get( 'c' ), this.listed() ) );

		boot.classList.add( 'hide' );
		this.renderer.setAnimationLoop( () => this.frame() );
		window.game = this;
		if ( import.meta.env.DEV ) ( window as any ).scenarioPlaytest = createScenarioPlaytest( this );

	}

	// a mission is a fresh page load: simplest way to get pristine GPU state (the plugins come along, they are loaded again)
	go( id ) { location.search = this.query( { m: id } ); }

	listed() { return MISSIONS.filter( ( mission ) => mission.menu !== false ); }

	// the whole map in view (maps other than Ljubljana's centre have no hand-picked opening view)
	frameMap() {

		const [ x0, y0, x1, y1 ] = this.city.bounds;
		this.controls.center.set( ( x0 + x1 ) / 2, ( y0 + y1 ) / 2 );
		this.controls.mpp = 1.05 * Math.max( ( x1 - x0 ) / window.innerWidth, ( y1 - y0 ) / window.innerHeight );

	}

	// the landing page, or a city's missions
	home( city ) {

		const listed = this.listed(), failed = this.plugins.failed;
		const pick = ( q ) => this.go( q.id );
		if ( city ) this.hud.menu( city, listed.filter( ( q ) => cityOf( q ) === city.id ), pick, () => { location.search = this.query(); }, failed );
		else this.hud.home( listed.find( ( q ) => q.tutorial ), citiesFor( listed ), pick, ( c ) => { location.search = this.query( { c: c.id } ); }, failed );

	}

	// back to the mission's city, or to the landing page from training
	toMenu() {

		const c = cityOf( this.mission?.constructor );
		location.search = this.query( c ? { c } : {} );

	}

	query( extra = {} ) {

		const p = new URLSearchParams( extra );
		for ( const u of new URLSearchParams( location.search ).getAll( 'plugin' ) ) p.append( 'plugin', u );
		return p.toString();

	}

	async load( M ) {

		const seed = import.meta.env.DEV ? Number( new URLSearchParams( location.search ).get( 'seed' ) ) : NaN;
		const seededState = Number.isInteger( seed ) && seed >= 0 && seed <= 0xffffffff ? { value: seed || 0x6d2b79f5 } : null;
		if ( seededState ) Math.random = () => {

			let value = seededState.value;
			value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
			seededState.value = value >>> 0;
			return seededState.value / 0x100000000;

		};
		boot.textContent = 'computing routes…';
		M.prepare?.( this.city ); // a mission may change the map data first (a fence); each mission is a fresh page load
		this.flow = new FlowFields( this.city );
		this.crowd = new Crowd( this.renderer, this.city, this.flow );
		this.crowd.u.mpp.value = this.controls.mpp;
		this.scene.add( this.crowd.mesh );
		this.world = new World( this.city, this.crowd, this.flow );
		this.world.patrols = new Patrols( this.world );
		this.world.onFx = ( ...a: Parameters<Sound[ 'fx' ]> ) => this.sound.fx( ...a );
		this.scene.add( this.world.patrols.group );
		this.aiming = null;
		this.mission = new M( this );
		this.world.standoff.exempt = this.mission.side === 'protest' ? [ FACTION.PROTESTER ] : []; // the player's own groups
		if ( seededState ) seededState.value = seed || 0x6d2b79f5;
		await this.mission.setup();
		this.crowd.upload();
		this.world.started = true;
		this.crowd.setZones( this.mission.zones );
		if ( this.mission.focus ) {

			this.controls.center.set( ...( this.mission.focus as [ number, number ] ) );
			this.controls.mpp = this.mission.zoom ?? 0.6;
			this.controls.update();

		}

		this.hud.show( this.mission );
		this.crowd.step();
		await this.refreshIntel();
		this.hud.update( this.mission );
		this.hud.briefing( M, () => { this.paused = false; this.mission.start?.(); }, this.mission.commands() );

	}

	finish( result ) {

		this.paused = true;
		this.sound.end( result.win );
		setTimeout( () => this.hud.result( this.mission.constructor, result, () => this.go( this.mission.constructor.id ) ), 900 );

	}

	confirmFirearms() {

		const was = this.paused;
		this.paused = true;
		const el = this.hud.modal( `<div class="card" style="max-width:480px">
			<h1 style="color:var(--red)">Authorise firearms?</h1>
			<p>Officers in the selected units will open fire. People will be badly hurt, the crowd will panic, the most
			radical will fight back harder, and public opinion will collapse. <b>This mission will score at most one star.</b></p>
			<div class="go"><button id="fNo" class="primary">Stand down</button><button id="fYes">Open fire</button></div></div>` );
		el.querySelector<HTMLElement>( '#fNo' ).onclick = () => { this.hud.modal( '' ); this.paused = was; };
		el.querySelector<HTMLElement>( '#fYes' ).onclick = () => { this.hud.modal( '' ); this.paused = was; this.mission.openFire(); };

	}

	// a white flare over the scene (gunfire strobe), unless the player switched it off (☀ in the top bar)
	flash( k ) { if ( ! this.strobeOff ) this.flashU.value = Math.max( this.flashU.value, k ); }

	toggleStrobe() {

		this.strobeOff = ! this.strobeOff;
		try { localStorage.setItem( 'lu-strobe', this.strobeOff ? '0' : '1' ); } catch { /* not remembered */ }
		this.mission?.event( this.strobeOff ? 'Flashing effects off' : 'Flashing effects on', 'info' );
		this.hud.update( this.mission );

	}

	togglePause() { if ( this.mission && ! this.mission.result ) { this.paused = ! this.paused; this.emit( 'pause', { paused: this.paused } ); } }

	toggleSound() { this.sound.setMuted( ! this.sound.muted ); this.hud.update( this.mission ); this.emit( 'sound', { muted: this.sound.muted } ); }

	cycleSpeed() { this.setSpeed( SPEEDS[ ( SPEEDS.indexOf( this.speed ) + 1 ) % SPEEDS.length ] ); }

	setSpeed( s ) { this.speed = s; this.emit( 'speed', { speed: s } ); }

	// what the player just did, for missions that react to input (the tutorial): Mission.onAction( { type, … } )
	emit( type, data = {} ) { if ( this.mission && ! this.mission.result ) this.mission.onAction?.( { type, ...data } ); }

	// ---------------------------------------------------------------- loop
	// one failing frame would otherwise fail silently every frame after it, with the map frozen: report the first
	frame() {

		try { this._frame(); } catch ( e ) {

			if ( this.frameError ) return;
			this.frameError = e;
			console.error( 'Frame failed; the simulation and the map have stopped updating.', e );
			this.mission?.event( 'Internal error: the map has stopped updating (details in the browser console)', 'bad' );

		}

	}

	_frame() {

		const m = this.mission;
		const now = performance.now();
		if ( m && ! this.paused ) {

			for ( let s = 0; s < this.speed; s ++ ) {

				this.crowd.step();
				this.world.update( DT, this.stats );
				m.update( DT, this.stats );

			}

		}

		if ( this.crowd && ! this.statsBusy ) {

			this.statsBusy = true;
			this.crowd.readStats().then( ( s ) => { this.stats = s; this.statsBusy = false; } );

		}

		if ( this.world && ! this.intelBusy && now - ( this.lastIntel ?? 0 ) > 500 ) {

			this.intelBusy = true;
			this.lastIntel = now;
			this.refreshIntel().then( () => { this.intelBusy = false; this.onIntel(); } );

		}

		if ( m && now - ( this.lastHud ?? 0 ) > 250 ) {

			this.lastHud = now;
			this.hud.update( m );

		}

		if ( this.armed ) this._armedPreview();
		else if ( this.drawing && ! this.lineDrag ) this.overlay.preview = { type: 'radius', x: this.mouse.x, y: this.mouse.y, r: 2, label: 'CORDON LINE · drag' };
		this.sound.update( Math.min( 0.25, ( now - ( this.lastFrame ?? now ) ) / 1000 ) );
		this.lastFrame = now;
		this.overlay.draw( this );
		this.flashU.value = this.strobeOff ? 0 : Math.max( 0, this.flashU.value - 0.016 * 9 ); // a flash fades out in ~0.1 s
		this.pipeline.render();

	}

	async refreshIntel() {

		const mission = this.mission, stamp = mission?.observationStamp?.();
		const sample = await this.world.refreshIntel();
		mission?.onObservation?.( sample, stamp );
		return sample;

	}

	onIntel() {

		const m = this.mission;
		if ( ! m ) return;
		this.sound.intel();
		for ( const g of this.world.groups ) {

			if ( g.justIdentified && m.side === 'police' && g.alive > 20 ) ( this.newlyIdentified ??= [] ).push( g );
			if ( ! g.snatch ) continue;
			const t = g.snatch;
			// the player's snatch squads (World.snatch): one message per leader, however many squads went for them
			if ( g.snatchPlan ) {

				const end = this.world.snatchStep( g, m.t );
				if ( end ) m.onSnatchOutcome?.( g, t, end );
				if ( end === 'abandoned' ) m.event( `${g.label}: lost the leader of ${t.label}, back to post`, 'warn', g.center );
				else if ( end && ! t.snatchReported ) {

					t.snatchReported = true;
					m.event( `${end === 'detained' ? 'Injured leader' : 'Leader'} of ${t.label} ${end} — the group is losing heart`, 'good', t.leaderPos );

				}

				continue;

			}

			if ( t.leaderState === 'active' ) {

				const moved = ! g.lastSnatch || Math.hypot( g.lastSnatch[ 0 ] - t.leaderPos[ 0 ], g.lastSnatch[ 1 ] - t.leaderPos[ 1 ] ) > 12;
				if ( moved && m.t - ( g.lastSnatchAt ?? - Infinity ) >= 8 ) {

					g.lastSnatch = t.leaderPos;
					g.lastSnatchAt = m.t;
					this.world.arrest( [ g ], ...( t.leaderPos as [ number, number ] ) );

				}

			} else {

				if ( t.leaderState === 'arrested' ) m.event( `Leader of ${t.label} arrested — the group is losing heart`, 'good', t.leaderPos );
				g.snatch = null;
				if ( g.center ) this.world.moveSquads( [ g ], ...g.center );

			}

		}

		// CCTV identifications: one summarised message at most every 20 s
		if ( this.newlyIdentified?.length && m.t - ( this.lastIdMsg ?? - 99 ) > 20 ) {

			const ids = this.newlyIdentified;
			this.newlyIdentified = [];
			this.lastIdMsg = m.t;
			m.event( ids.length === 1 ? `CCTV identified the leader of ${ids[ 0 ].label} — select a squad and press X to snatch`
				: `CCTV identified ${ids.length} group leaders — snatch them (X) to break their groups up`, 'info', ids[ 0 ].leaderPos );

		}

		// cordon lines that are losing officers close ranks, then fall back (both sides see it)
		for ( const e of this.world.cordonCheck( m.t, { brace: m.side === 'police' } ) ) {

			const ours = m.side === 'police';
			m.onCordon( e );
			if ( e.type === 'brace' ) { m.event( `${e.label}: in line, shields up`, 'info', e.at ); continue; }
			this.sound.play( e.type === 'retreat' ? 'whistle_3' : 'whistle_1', e.at, { vol: - 3 } );
			m.event( e.type === 'retreat' ? `${e.label}: the line is breaking — falling back to re-form` : `${e.label}: officers down, the line closes ranks`,
				e.type === 'retreat' ? ( ours ? 'bad' : 'good' ) : ( ours ? 'warn' : 'info' ), e.at );

		}

		// crowds facing police lines: stop short, probe, push, firecrackers (Standoff); one message per kind every 12 s
		for ( const e of this.world.standoff.update() ) {

			const ours = m.side === 'police', g = e.group;
			const key = e.type === 'standoff' ? 'standoff' : `${e.type}${e.level}`;
			if ( m.t - ( ( this.heatMsg ??= {} )[ key ] ?? - 99 ) < 12 ) continue;
			this.heatMsg[ key ] = m.t;
			const text = e.type === 'standoff' ? `${g.label} stops short of the police line`
				: e.type === 'down' ? `${g.label} is calming down`
				: e.level === 2 ? `${g.label}: small groups break off to probe the line`
				: e.level === 3 ? `${g.label} tries to break through the line`
				: `${g.label}: firecrackers at the line, a concentrated breach`;
			const kind = e.type === 'down' ? ( ours ? 'good' : 'info' ) : e.type === 'standoff' || e.level === 2 ? 'info' : e.level === 3 ? 'warn' : ( ours ? 'bad' : 'warn' );
			m.event( text, kind, e.at );
			if ( e.type === 'up' && e.level >= 3 ) this.sound.swell( e.at, e.level / 4 );

		}

		// shield pushes that reached their mark or ran into a crowd they cannot move
		for ( const e of this.world.pushEvents.splice( 0 ) ) {

			const ours = m.side === 'police';
			m.event( e.type === 'done' ? `${e.label}: shield push complete, holding the line` : `${e.label}: the crowd is too dense to push back, the line holds here`,
				e.type === 'done' ? 'info' : ( ours ? 'warn' : 'info' ), e.at );

		}

		// drop dead units from the selection
		this.selected = this.selected.filter( ( g ) => ( g.alive ?? 1 ) > 0 );
		if ( this.drawing && ! this.squads.length ) { this.drawing = false; this.overlay.preview = null; }
		this.crowd.u.selA.value = this.squads[ 0 ]?.id ?? - 1;
		this.crowd.u.selB.value = this.squads[ 1 ]?.id ?? - 1;

	}

	// the selection can mix squads / groups and police cars
	get squads() { return this.selected.filter( ( g ) => ! g.isCar ); }

	get cars() { return this.selected.filter( ( g ) => g.isCar ); }

	// squad orders need a squad (or group) selected, car orders a car
	hasSelFor( c ) { return ! c.needsSel || ( c.forCordon ? this.squads.some( ( g ) => g.cordon ) : ( c.forCars ? this.cars : this.squads ).length > 0 ); }

	// ---------------------------------------------------------------- input
	get myFactions() { return this.mission?.side === 'protest' ? [ FACTION.PROTESTER ] : [ FACTION.POLICE ]; }

	command( key ) {

		const m = this.mission;
		if ( ! m || m.result ) return;
		if ( key !== 'l' ) this.drawing = false;
		const c = m.commands().find( ( q ) => q.key === key );
		if ( ! c || ! c.run ) return;
		if ( ! this.hasSelFor( c ) ) { m.onCommandBlocked?.( key ); m.event( c.forCars ? 'Select a patrol car first' : c.forCordon ? 'Select squads standing in a cordon line (right-drag to form one)' : 'Select a unit first', 'warn' ); return; }
		const r = c.resource ? m.resources[ c.resource ] : null;
		if ( r && ( r.left <= 0 || r.ready > 0 ) ) { m.onCommandBlocked?.( key ); this.sound.refuse(); m.event( `${c.label} not available`, 'warn' ); return; }
		if ( c.aim ) { this._aim( c ); return; }
		// commands without a target run immediately; targeted ones arm and fire on the next map click
		if ( c.run.length === 0 ) { c.run(); this.emit( 'order', { key } ); return; }
		this.armed = this.armed === key ? null : key;
		if ( ! this.armed ) this.overlay.preview = null;

	}

	// cordon line without a right button (trackpads): L arms it, the next left-drag draws the line; L / Esc again cancels
	drawLine() {

		this.armed = null;
		this.aiming = null;
		this.drawing = ! this.drawing;
		this.overlay.preview = null;

	}

	// water cannon: W on a selected truck shows its reach; holding the left button aims, releasing sprays.
	// Shield push: S on squads in a cordon shows how far the line can go; holding aims, releasing advances.
	_aim( c ) {

		const truck = this.cars.find( ( q ) => q.water );
		if ( this.aiming ) { this.aiming = null; return; }
		if ( c.forCordon ) {

			this.armed = null;
			this.overlay.preview = null;
			this.aiming = { squads: this.squads.filter( ( g ) => g.cordon ), c, held: false };
			return;

		}

		if ( ! truck ) { this.sound.refuse(); this.mission.event( 'Select the water cannon first', 'warn' ); return; }
		this.armed = null;
		this.overlay.preview = null;
		this.aiming = { truck, c, held: false };
		truck.aim = Math.atan2( this.mouse.y - truck.y, this.mouse.x - truck.x );

	}

	_fireArmed( x, y ) {

		const c = this.mission.commands().find( ( q ) => q.key === this.armed );
		this.armed = null;
		this.overlay.preview = null;
		if ( ! c?.run ) return;
		if ( this.mission.side === 'police' && c.needsSel && ! c.danger ) this.sound.order( c.key, [ x, y ] );
		c.run( x, y );
		this.emit( 'order', { key: c.key, at: [ x, y ] } );

	}

	_armedPreview() {

		const k = this.armed, p = this.mouse;
		const people = this.selected.reduce( ( s, q ) => s + ( q.alive ?? q.members.length ), 0 );
		const r = k === 'k' ? Math.max( 14, Math.sqrt( people ) * 2.6 ) : k === 'g' ? 20 : k === 'b' ? 70 : 6;
		const label = { k: 'KETTLE', g: 'TEAR GAS', c: 'CHARGE', a: this.mission.side === 'protest' ? 'ASSAULT' : 'ARREST', x: 'SNATCH', f: 'REINFORCE', r: 'RALLY HERE', b: 'DISPERSAL ORDER',
			w: this.mission.side === 'protest' ? 'REGROUP HERE' : 'WATER CANNON' }[ k ] ?? k.toUpperCase();
		this.overlay.preview = { type: 'radius', x: p.x, y: p.y, r, label: label + ' · click' };

	}

	_input( canvas ) {

		let right = null, box = null, leftDown = null;
		canvas.addEventListener( 'pointermove', ( e ) => {

			this.mouse = this.controls.screenToWorld( e.clientX, e.clientY );
			const A = this.aiming;
			if ( A?.truck && ! ( A.truck.sprayUntil > this.mission.t ) ) A.truck.aim = Math.atan2( this.mouse.y - A.truck.y, this.mouse.x - A.truck.x );
			if ( right ) {

				right.moved = Math.hypot( this.mouse.x - right.a[ 0 ], this.mouse.y - right.a[ 1 ] ) > Math.max( 4, this.controls.mpp * 12 );
				this.overlay.preview = right.moved && this.mission?.side === 'police' ? { type: 'line', a: right.a, b: [ this.mouse.x, this.mouse.y ] } : null;

			}

			if ( box ) {

				box.x1 = e.clientX; box.y1 = e.clientY;
				this.overlay.preview = { type: 'box', x0: Math.min( box.x0, box.x1 ), y0: Math.min( box.y0, box.y1 ), x1: Math.max( box.x0, box.x1 ), y1: Math.max( box.y0, box.y1 ) };

			}

		} );

		canvas.addEventListener( 'pointerdown', ( e ) => {

			if ( ! this.mission ) return;
			const w = this.controls.screenToWorld( e.clientX, e.clientY );
			if ( this.aiming ) {

				// left: start aiming (fires on release); right: put the cannon away
				if ( e.button === 0 ) this.aiming.held = true;
				if ( e.button === 2 ) this.aiming = null;
				return;

			}

			// a line (or a move) by the right button, or by the left one with Ctrl held (Mac: Ctrl-click) or after L
			if ( e.button === 2 || ( e.button === 0 && ( e.ctrlKey || this.drawing ) ) ) { right = { a: [ w.x, w.y ], moved: false, left: e.button === 0, how: e.button === 2 ? 'right' : e.ctrlKey ? 'ctrl' : 'l' }; this.lineDrag = true; return; }
			if ( e.button === 0 ) {

				leftDown = { x: e.clientX, y: e.clientY };
				if ( e.shiftKey ) box = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };

			}

		} );

		canvas.addEventListener( 'pointerup', ( e ) => {

			const m = this.mission;
			if ( ! m || m.result ) { right = box = null; return; }
			const w = this.controls.screenToWorld( e.clientX, e.clientY );

			if ( this.aiming ) {

				const A = this.aiming;
				if ( e.button !== 0 || ! A.held ) return;
				this.aiming = null;
				leftDown = null;
				A.c.run( w.x, w.y );
				this.emit( 'order', { key: A.c.key, at: [ w.x, w.y ] } );
				return;

			}

			if ( right && ( e.button === 2 || ( e.button === 0 && right.left ) ) ) {

				this.lineDrag = false;
				// after L a click is not a line: keep waiting for a drag
				if ( right.left && this.drawing && ! right.moved ) { right = null; this.overlay.preview = null; m.event( 'Drag with the left button to draw the cordon line (Esc cancels)', 'info' ); return; }
				if ( right.moved && this.squads.length ) this.drawing = false;
				const sel = this.squads;
				for ( const c of this.cars ) {

					const handled = m.onPlayerVehicleDrive?.( { vehicle: c, at: [ w.x, w.y ] } );
					if ( ! handled && ! this.world.patrols.driveTo( c, w.x, w.y ) ) m.event( `${c.label}: no road there`, 'warn' );
					else this.emit( 'drive', { car: c, at: [ w.x, w.y ] } );

				}

				if ( this.cars.length && ! sel.length ) this.overlay.ping( w.x, w.y, 'info' );
				if ( sel.length ) {

					if ( m.side === 'police' ) {

						const handled = m.onPlayerMovement?.( { type: right.moved ? 'line' : 'move', units: sel, a: right.a, at: [ w.x, w.y ] } );
						if ( ! handled ) {

							if ( right.moved ) this.world.lineSquads( sel, right.a, [ w.x, w.y ], this.world.intel?.pos );
							else this.world.moveSquads( sel, w.x, w.y );

						}
						this.sound.order( right.moved ? 'line' : 'move', [ w.x, w.y ] );
						for ( const g of sel ) g.snatch = null;
						this.emit( right.moved ? 'line' : 'move', { a: right.a, at: [ w.x, w.y ], how: right.how, units: sel } );

					} else {

						const handled = m.onPlayerMovement?.( { type: 'move', units: sel, at: [ w.x, w.y ] } );
						if ( ! handled ) { m.recall?.( sel ); this.world.march( sel, w.x, w.y, 15 ); }
						this.emit( 'move', { at: [ w.x, w.y ], how: right.how, units: sel } );

					}
					this.overlay.ping( w.x, w.y, 'info' );

				}

				right = null;
				this.overlay.preview = null;
				return;

			}

			if ( e.button !== 0 ) return;
			if ( box ) {

				const x0 = Math.min( box.x0, box.x1 ), x1 = Math.max( box.x0, box.x1 ), y0 = Math.min( box.y0, box.y1 ), y1 = Math.max( box.y0, box.y1 );
				box = null;
				this.overlay.preview = null;
				if ( x1 - x0 > 6 || y1 - y0 > 6 ) {

					const cars = m.side === 'police' ? this.world.patrols.cars.filter( ( c ) => c.selectable ) : [];
					const inBox = [ ...this.world.groups, ...cars ].filter( ( g ) => this.myFactions.includes( g.faction ) && g.center && ( g.alive ?? 0 ) > 0 && ( ( [ sx, sy ] ) => sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 )( this.controls.worldToScreen( ...( g.center as [ number, number ] ) ) ) );
					this.selected = [ ...new Set( [ ...this.selected, ...inBox ] ) ];
					this.onIntel();
					this.emit( 'select', { how: 'box' } );
					return;

				}

			}

			if ( ! leftDown || Math.hypot( e.clientX - leftDown.x, e.clientY - leftDown.y ) > 5 ) return;
			leftDown = null;
			if ( this.armed ) { this._fireArmed( w.x, w.y ); return; }
			const pickR = Math.max( 4, this.controls.mpp * 12 );
			const g = ( m.side === 'police' && this.world.patrols.pick( w.x, w.y, Math.max( 3.5, pickR ) ) ) || this.world.groupAt( w.x, w.y, this.myFactions, pickR );
			if ( e.shiftKey && g ) this.selected = this.selected.includes( g ) ? this.selected.filter( ( q ) => q !== g ) : [ ...this.selected, g ];
			else this.selected = g ? [ g ] : [];
			this.onIntel();
			this.emit( 'select', { how: e.shiftKey ? 'add' : 'click' } );

		} );

		window.addEventListener( 'keydown', ( e ) => {

			if ( ! this.mission || ( e.target as HTMLElement ).tagName === 'INPUT' ) return;
			const k = e.key.toLowerCase();
			if ( k === ' ' ) { e.preventDefault(); this.togglePause(); return; }
			if ( k === '+' || k === '=' ) { this.setSpeed( Math.min( 3, this.speed + 1 ) ); return; }
			if ( k === '-' ) { this.setSpeed( Math.max( 1, this.speed - 1 ) ); return; }
			if ( k === 'n' ) { this.toggleSound(); return; }
			if ( k === 'escape' ) { if ( this.aiming ) { this.aiming = null; return; } if ( this.drawing ) { this.drawing = false; this.overlay.preview = null; return; } this.armed = null; this.overlay.preview = null; this.selected = []; this.onIntel(); this.emit( 'deselect' ); return; }
			if ( k === 'tab' ) {

				e.preventDefault();
				const mine = this.world.groups.filter( ( g ) => this.myFactions.includes( g.faction ) && ( g.alive ?? 0 ) > 0 && g.center );
				if ( ! mine.length ) return;
				const i = ( mine.indexOf( this.selected[ 0 ] ) + 1 ) % mine.length;
				this.selected = [ mine[ i ] ];
				this.controls.center.set( ...mine[ i ].center );
				this.controls.update();
				this.onIntel();
				this.emit( 'select', { how: 'tab' } );
				return;

			}

			const c = this.mission.commands().find( ( q ) => q.key === k );
			if ( ! c?.run ) { if ( this.mission.constructor.sdkScenario ) this.emit( 'key', { key: k, at: [ this.mouse.x, this.mouse.y ] } ); return; }
			// keyboard: targeted commands fire at the cursor right away (the water cannon is aimed with the mouse)
			if ( c.run.length === 0 || c.aim ) { this.command( k ); return; }
			this.armed = k;
			const r = c.resource ? this.mission.resources[ c.resource ] : null;
			if ( ! this.hasSelFor( c ) || ( r && ( r.left <= 0 || r.ready > 0 ) ) ) { this.armed = null; this.command( k ); return; }
			this._fireArmed( this.mouse.x, this.mouse.y );

		} );

	}

	// fast-forward for testing: `seconds` of sim time as fast as the GPU allows
	async advance( seconds ) {

		const was = this.paused;
		this.paused = true;
		const steps = Math.round( seconds / DT );
		for ( let s = 0; s < steps; s ++ ) {

			this.crowd.step();
			this.world.update( DT, this.stats );
			this.mission.update( DT, this.stats );
			if ( s % 30 === 29 ) {

				this.stats = await this.crowd.readStats();
				if ( s % 60 === 59 ) { await this.refreshIntel(); this.onIntel(); }

			}

			if ( this.mission.result ) break;

		}

		this.paused = was && ! this.mission.result ? was : this.paused;
		return { t: this.mission.t, result: this.mission.result, objectives: this.mission.objectives().map( ( o ) => `${o.label}: ${o.text} [${o.state}]` ), opinion: this.mission.opinion };

	}

}

new Game().init().catch( ( e ) => { console.error( e ); fail( 'Error: ' + e.message ); } );
