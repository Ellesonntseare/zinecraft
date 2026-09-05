// Multiplayer: connects to the relay server (server/server.js), keeps remote players'
// avatars in sync, relays block edits + chat. World terrain itself is never sent over
// the network — every client generates the same terrain locally from the shared seed,
// so only the diff (block edits) and player state need to travel.
(function () {
  function reconcile(map, incoming, createFn, updateFn, removeFn) {
    var seen = {};
    for (var i = 0; i < incoming.length; i++) {
      var d = incoming[i]; seen[d.id] = true;
      var obj = map[d.id]; if (!obj) { obj = createFn(d); if (!obj) continue; map[d.id] = obj; }
      updateFn(obj, d);
    }
    Object.keys(map).forEach(function (id) { if (!seen[id]) { removeFn(map[id]); delete map[id]; } });
  }

  // ---------------- remote player avatar (custom glTF character + nametag) ----------------
  // The old box-rig avatar was replaced with a real rigged/animated character
  // (converted from a Renderpeople FBX to glTF). Loaded once and shared; each
  // RemotePlayer gets its own animated clone via THREE.SkeletonUtils.clone.
  var PLAYER_MODEL_URL = 'assets/models/nathan.glb';
  var PLAYER_MODEL_HEIGHT = 1.86; // approx meters tall, used for the nametag height
  var nathanTemplate = null;   // { scene, clip } once loaded
  var nathanLoading = false;
  var nathanWaiters = [];
  function ensurePlayerModel(onReady) {
    if (nathanTemplate) { onReady(nathanTemplate); return; }
    nathanWaiters.push(onReady);
    if (nathanLoading) return;
    nathanLoading = true;
    var loader = new THREE.GLTFLoader();
    loader.load(PLAYER_MODEL_URL, function (gltf) {
      gltf.scene.traverse(function (o) { if (o.isMesh) { o.frustumCulled = false; } });
      nathanTemplate = { scene: gltf.scene, clip: gltf.animations[0] };
      nathanWaiters.forEach(function (fn) { fn(nathanTemplate); });
      nathanWaiters.length = 0;
    }, undefined, function (err) {
      console.error('Failed to load player model (' + PLAYER_MODEL_URL + '):', err);
    });
  }
  // The voxel world/mobs use a custom baked-lighting shader with no concept of
  // THREE lights; the imported glTF character instead uses a normal PBR
  // material, so it needs real scene lights. These are the only THREE lights
  // in the game and only illuminate player avatars. Intensity is driven each
  // frame from the sky's day/night value so avatars still dim at night.
  var playerLights = null;
  function ensurePlayerLighting(scene) {
    if (playerLights) return playerLights;
    var hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a3226, 0.6);
    var sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
    sun.position.set(0.5, 1, 0.35);
    scene.add(hemi); scene.add(sun);
    playerLights = { hemi: hemi, sun: sun };
    return playerLights;
  }
  function nameTexture(name, talking) {
    var c = document.createElement('canvas'); var g = c.getContext('2d'); g.font = 'bold 24px sans-serif';
    var w = Math.max(32, Math.ceil(g.measureText(name).width) + 16); c.width = w; c.height = 32; g.font = 'bold 24px sans-serif'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 4, w, 24);
    g.fillStyle = talking ? '#7CFC7C' : '#ffffff'; g.textAlign = 'center'; g.fillText(name, w / 2, 16);
    return c;
  }

  function RemotePlayer(id, name, mats, shared, scene) {
    this.id = id; this.name = name;
    this.pos = new THREE.Vector3(); this.renderPosV = new THREE.Vector3(); this.hasPos = false;
    this.yaw = 0; this.pitch = 0; this.renderYaw = 0;
    this.selected = null; this.swinging = false; this.swing = 0; this.talking = false; this.lastTalking = null;
    this.moveSpeed = 0; this.lastUpdate = performance.now();

    this.group = new THREE.Group(); this.mesh = this.group;
    this.modelRoot = null; this.mixer = null; this.walkAction = null; this.armR = null;

    ensurePlayerLighting(scene);
    var self = this;
    ensurePlayerModel(function (tpl) {
      var model = THREE.SkeletonUtils.clone(tpl.scene);
      self.modelRoot = model;
      self.group.add(model);
      model.traverse(function (o) { if (o.isBone && /upperarm_r$/.test(o.name)) self.armR = o; });
      if (tpl.clip) {
        self.mixer = new THREE.AnimationMixer(model);
        self.walkAction = self.mixer.clipAction(tpl.clip);
        self.walkAction.play();
        self.walkAction.paused = true; // holds on frame 0 (a standing-ish pose) until the player actually moves
      }
    });

    this.nameMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(nameTexture(name, false)), depthTest: false, depthWrite: false, transparent: true });
    this.nameSprite = new THREE.Sprite(this.nameMat); this.nameSprite.scale.set(1.2 * (this.nameMat.map.image.width / 128), 0.3, 1); this.nameSprite.position.set(0, PLAYER_MODEL_HEIGHT + 0.2, 0); this.nameSprite.renderOrder = 10;
    this.group.add(this.nameSprite);
  }
  RemotePlayer.prototype.applyState = function (s) {
    var now = performance.now();
    var newPos = new THREE.Vector3(s.x, s.y, s.z);
    if (this.hasPos) this.moveSpeed = newPos.distanceTo(this.pos) / Math.max(0.02, (now - this.lastUpdate) / 1000);
    this.pos.copy(newPos); this.yaw = s.yaw; this.pitch = s.pitch || 0;
    if (!this.hasPos) { this.renderPosV.copy(this.pos); this.renderYaw = this.yaw; this.hasPos = true; }
    if (s.swinging && !this.swinging) { this.swinging = true; this.swing = 0; }
    this.lastUpdate = now;
  };
  RemotePlayer.prototype.setTalking = function (t) {
    this.talking = t;
    if (t !== this.lastTalking) { this.lastTalking = t; this.nameMat.map.dispose(); this.nameMat.map = new THREE.CanvasTexture(nameTexture(this.name, t)); this.nameMat.needsUpdate = true; }
  };
  RemotePlayer.prototype.update = function (dt, world, dayLight) {
    if (!this.hasPos) return;
    var f = 1 - Math.pow(0.001, dt); // smoothing factor, framerate independent
    this.renderPosV.lerp(this.pos, f);
    var dy = this.yaw - this.renderYaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    this.renderYaw += dy * f;
    this.group.position.copy(this.renderPosV);
    this.group.rotation.y = this.renderYaw;

    if (this.swinging) { this.swing += dt / 0.3; if (this.swing >= 1) { this.swing = 0; this.swinging = false; } }

    if (this.mixer) {
      var moving = this.moveSpeed > 0.3;
      this.walkAction.paused = !moving;
      if (moving) this.walkAction.timeScale = MC.clamp(this.moveSpeed / 4.3, 0.4, 1.8);
      this.mixer.update(dt);
      // simple additive attack "chop", layered on top of whatever the walk cycle is doing with the arm
      if (this.swinging && this.armR) this.armR.rotateX(-Math.sin(Math.min(1, this.swing) * Math.PI) * 0.9);
    }
  };
  RemotePlayer.prototype.dispose = function (scene) {
    scene.remove(this.group);
    this.nameMat.map.dispose(); this.nameMat.dispose();
    if (this.mixer) this.mixer.stopAllAction();
  };

  // ---------------- networking ----------------
  var STATE_HZ2 = 15; var ENTITY_HZ = 4; // mob/item snapshots need less frequency than player position
  var Net = {
    active: false, ws: null, room: null, selfId: null, name: 'Player', isHost: false,
    players: {}, // id -> RemotePlayer
    dropPuppets: {}, xpPuppets: {}, // netId -> entity
    applyingRemote: false,
    game: null,
    _stateT: 0, _entT: 0, _idc: 0,
    onPeers: null, // callback(list) for voice module

    nextId: function () { return 'e' + (++this._idc); },

    connect: function (url, opts, cb) {
      this.disconnect();
      var self = this;
      var ws;
      try { ws = new WebSocket(url); } catch (e) { cb({ error: 'Could not open ' + url }); return; }
      this.ws = ws; this.name = opts.name || 'Player'; this._pendingCb = cb; this._connectOpts = opts; this.isHost = (opts.mode === 'host');
      ws.onopen = function () {
        if (opts.mode === 'host') ws.send(JSON.stringify({ t: 'host', room: opts.room || '', name: self.name, seed: opts.seed, gameMode: opts.gameMode }));
        else ws.send(JSON.stringify({ t: 'join', room: opts.room, name: self.name }));
      };
      ws.onmessage = function (ev) { self._onMessage(ev.data); };
      ws.onclose = function () {
        if (self._pendingCb) { self._pendingCb({ error: 'Connection closed before joining.' }); self._pendingCb = null; }
        else if (self.game && self.game.chat) self.game.chat.add('\u00a7cDisconnected from the multiplayer server.');
        self._teardown();
      };
      ws.onerror = function () { if (self._pendingCb) { self._pendingCb({ error: 'Could not reach ' + url }); self._pendingCb = null; } };
    },
    _onMessage: function (raw) {
      var m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'hosted') {
        this.active = true; this.room = m.room; this.selfId = m.id;
        if (this._pendingCb) { this._pendingCb({ room: m.room, seed: this._connectOpts.seed, gameMode: this._connectOpts.gameMode, players: [] }); this._pendingCb = null; }
      } else if (m.t === 'joined') {
        this.active = true; this.room = m.room; this.selfId = m.id;
        if (this._pendingCb) { this._pendingCb({ room: m.room, seed: m.seed, gameMode: m.gameMode, players: m.players }); this._pendingCb = null; }
        var self = this;
        m.players.forEach(function (p) { self._addRemote(p.id, p.name); });
      } else if (m.t === 'error') {
        if (this._pendingCb) { this._pendingCb({ error: m.message }); this._pendingCb = null; }
      } else if (m.t === 'peer-join') {
        this._addRemote(m.id, m.name);
        if (this.game && this.game.chat) this.game.chat.add('\u00a7e' + m.name + ' joined the game');
        this._notifyPeers();
      } else if (m.t === 'peer-leave') {
        this._removeRemote(m.id);
        this._notifyPeers();
      } else if (m.t === 'state') {
        var rp = this.players[m.id]; if (rp) rp.applyState(m);
      } else if (m.t === 'block') {
        if (this.game) {
          this.applyingRemote = true;
          var applied = -1;
          try { applied = this.game.world.setBlock(m.x, m.y, m.z, m.id, m.meta || 0); } finally { this.applyingRemote = false; }
          // chunk not loaded on our side yet (out of render distance) — queue the edit so it's baked in
          // the moment that chunk is generated locally, using the same mechanism as reloading a save.
          if (applied === -1) this.game.recordEdit(m.x, m.y, m.z, m.id, m.meta || 0);
        }
      } else if (m.t === 'chat') {
        if (this.game && this.game.chat && m.id !== this.selfId) this.game.chat.add('<' + m.name + '> ' + m.text);
      } else if (m.t === 'signal') {
        if (MC.Voice) MC.Voice._onSignal(m.from, m.data);
      } else if (m.t === 'entities') {
        this._applyEntities(m);
      } else if (m.t === 'reqDrop') {
        if (this.isHost && this.game) this.game.spawnDrop({ id: m.item, count: m.count, damage: m.dmg || 0 }, new THREE.Vector3(m.x, m.y, m.z), m.vel ? new THREE.Vector3(m.vel[0], m.vel[1], m.vel[2]) : undefined, m.pickupDelay);
      } else if (m.t === 'reqXp') {
        if (this.isHost && this.game) this.game.spawnXP(new THREE.Vector3(m.x, m.y, m.z), m.n);
      } else if (m.t === 'reqMobHit') {
        if (this.isHost) { var mob = MC.Mobs.byNetId(m.id); if (mob) mob.hurt(m.dmg, 'player', { x: m.from[0], y: m.from[1], z: m.from[2] }, m.knock); }
      } else if (m.t === 'reqMobInteract') {
        if (this.isHost) {
          var mob2 = MC.Mobs.byNetId(m.id);
          if (mob2) { if (m.action === 'shear' && mob2.type === 'sheep' && !mob2.sheared) mob2.setSheared(true); else if (m.action === 'feed') mob2.lookAtPlayer = 3; }
        }
      } else if (m.t === 'pickup') {
        if (this.isHost && this.game) {
          var list = this.game.entities.list;
          for (var i = 0; i < list.length; i++) { if (list[i].netId === m.id) { this.game.entities.remove(list[i]); break; } }
        }
      }
    },
    _addRemote: function (id, name) {
      if (id === this.selfId || this.players[id] || !this.game) return;
      this.players[id] = new RemotePlayer(id, name, null, this.game.world.materials.uniforms, this.game.scene);
      this.game.scene.add(this.players[id].mesh);
      this._notifyPeers();
    },
    _removeRemote: function (id) {
      var rp = this.players[id]; if (!rp) return;
      rp.dispose(this.game.scene); delete this.players[id];
    },
    _notifyPeers: function () {
      if (this.onPeers) this.onPeers(Object.keys(this.players));
    },
    peerName: function (id) { var rp = this.players[id]; return rp ? rp.name : id; },
    sendChat: function (text) { if (this.active) this.ws.send(JSON.stringify({ t: 'chat', text: text })); },
    sendBlock: function (x, y, z, id, meta) { if (this.active) this.ws.send(JSON.stringify({ t: 'block', x: x, y: y, z: z, id: id, meta: meta || 0 })); },
    sendSignal: function (to, data) { if (this.active) this.ws.send(JSON.stringify({ t: 'signal', to: to, data: data })); },
    requestDrop: function (stack, pos, vel, pickupDelay) { if (!this.active) return; this.ws.send(JSON.stringify({ t: 'reqDrop', item: stack.id, count: stack.count, dmg: stack.damage || 0, x: pos.x, y: pos.y, z: pos.z, vel: vel ? [vel.x, vel.y, vel.z] : null, pickupDelay: pickupDelay })); },
    requestXP: function (pos, n) { if (!this.active) return; this.ws.send(JSON.stringify({ t: 'reqXp', x: pos.x, y: pos.y, z: pos.z, n: n })); },
    sendPickup: function (kind, id) { if (!this.active || id == null) return; this.ws.send(JSON.stringify({ t: 'pickup', kind: kind, id: id })); },
    sendMobHit: function (id, dmg, from, knock) { if (!this.active || id == null) return; this.ws.send(JSON.stringify({ t: 'reqMobHit', id: id, dmg: dmg, from: [from.x, from.y, from.z], knock: knock })); },
    sendMobInteract: function (id, action) { if (!this.active || id == null) return; this.ws.send(JSON.stringify({ t: 'reqMobInteract', id: id, action: action })); },

    // ---- host: broadcast authoritative mob / item-drop / xp-orb snapshots ----
    _broadcastEntities: function () {
      var drops = [], xp = [], mobs = [];
      this.game.entities.list.forEach(function (e) {
        if (e.puppet) return;
        if (e instanceof MC.ItemDrop) { if (!e.netId) e.netId = Net.nextId(); drops.push({ id: e.netId, x: +e.pos.x.toFixed(2), y: +e.pos.y.toFixed(2), z: +e.pos.z.toFixed(2), item: e.stack.id, count: e.stack.count, dmg: e.stack.damage || 0 }); }
        else if (e instanceof MC.XPOrb) { if (!e.netId) e.netId = Net.nextId(); xp.push({ id: e.netId, x: +e.pos.x.toFixed(2), y: +e.pos.y.toFixed(2), z: +e.pos.z.toFixed(2), v: e.value }); }
      });
      MC.Mobs.list.forEach(function (m) {
        if (m.puppet) return; if (!m.netId) m.netId = Net.nextId();
        mobs.push({ id: m.netId, type: m.type, x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2), yaw: +m.yaw.toFixed(2), health: m.health, sheared: !!m.sheared, fire: m.fire > 0 ? 1 : 0 });
      });
      this.ws.send(JSON.stringify({ t: 'entities', drops: drops, xp: xp, mobs: mobs }));
    },
    // ---- non-host: reconcile puppets against the host's latest snapshot ----
    _applyEntities: function (m) {
      if (!this.game || this.isHost) return;
      var self = this;
      reconcile(this.dropPuppets, m.drops, function (d) {
        var obj = new MC.ItemDrop(self.game.entities, { id: d.item, count: d.count, damage: d.dmg || 0 }, new THREE.Vector3(d.x, d.y, d.z));
        obj.puppet = true; obj.netId = d.id; self.game.entities.add(obj); return obj;
      }, function (obj, d) { obj.applyNetState(d); }, function (obj) { self.game.entities.remove(obj); });
      reconcile(this.xpPuppets, m.xp, function (d) {
        var obj = new MC.XPOrb(self.game.entities, new THREE.Vector3(d.x, d.y, d.z), d.v);
        obj.puppet = true; obj.netId = d.id; self.game.entities.add(obj); return obj;
      }, function (obj, d) { obj.applyNetState(d); }, function (obj) { self.game.entities.remove(obj); });
      var mobMap = {}; MC.Mobs.list.forEach(function (mo) { if (mo.puppet) mobMap[mo.netId] = mo; });
      reconcile(mobMap, m.mobs, function (d) { return MC.Mobs.spawnPuppet(d.id, d.type, new THREE.Vector3(d.x, d.y, d.z)); },
        function (obj, d) { obj.applyNetState(d); }, function (obj) { MC.Mobs.despawnPuppet(obj); });
    },

    // called every frame while playing
    tick: function (dt, player) {
      if (!this.active) return;
      if (playerLights) {
        var dl = this.game.sky.dayLight;
        playerLights.hemi.intensity = 0.25 + 0.55 * dl;
        playerLights.sun.intensity = 0.15 + 0.85 * dl;
      }
      for (var id in this.players) this.players[id].update(dt, this.game.world, this.game.sky.dayLight);
      this._stateT += dt;
      if (this._stateT >= 1 / STATE_HZ2) {
        this._stateT = 0;
        this.ws.send(JSON.stringify({
          t: 'state', x: +player.pos.x.toFixed(2), y: +player.pos.y.toFixed(2), z: +player.pos.z.toFixed(2),
          yaw: +player.yaw.toFixed(3), pitch: +player.pitch.toFixed(3), swinging: !!(player.swinging && player.swing < 0.15)
        }));
      }
      if (this.isHost) {
        this._entT += dt;
        if (this._entT >= 1 / ENTITY_HZ) { this._entT = 0; this._broadcastEntities(); }
      }
    },
    // small always-on-top overlay: player list + talk indicator
    renderOverlay: function (g) {
      if (!this.active) return;
      var names = [this.name + ' (you)']; var ids = [null];
      for (var id in this.players) { names.push(this.players[id].name); ids.push(id); }
      var w = 0; for (var i = 0; i < names.length; i++) w = Math.max(w, MC.Font.width(names[i]));
      w += 26;
      var x = g.W - w - 4, y = 4;
      g.ctx.fillStyle = 'rgba(0,0,0,0.35)'; g.ctx.fillRect(x - 4, y - 2, w + 4, names.length * 11 + 4);
      for (i = 0; i < names.length; i++) {
        var talking = ids[i] === null ? (MC.Voice && MC.Voice.localTalking) : (this.players[ids[i]] && this.players[ids[i]].talking);
        g.ctx.fillStyle = talking ? '#7CFC7C' : '#666666'; g.ctx.beginPath(); g.ctx.arc(x + 4, y + 5 + i * 11, 3, 0, 7); g.ctx.fill();
        g.text(names[i], x + 12, y + i * 11, '#ffffff', true);
      }
    },
    _teardown: function () {
      this.active = false; this.isHost = false; this._idc = 0;
      for (var id in this.players) this._removeRemote(id);
      this.players = {}; this.room = null; this.selfId = null;
      if (this.game) {
        for (var did in this.dropPuppets) this.game.entities.remove(this.dropPuppets[did]);
        for (var xid in this.xpPuppets) this.game.entities.remove(this.xpPuppets[xid]);
        MC.Mobs.list.slice().forEach(function (m) { if (m.puppet) MC.Mobs.despawnPuppet(m); });
      }
      this.dropPuppets = {}; this.xpPuppets = {};
      if (MC.Voice) MC.Voice.stop();
    },
    disconnect: function () {
      if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) { } this.ws = null; }
      this._teardown();
    }
  };

  MC.Net = Net;
})();
