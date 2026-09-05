// Voice chat: a small WebRTC mesh (fine for a handful of friends). MC.Net relays the
// signaling (offer/answer/ICE) as opaque messages; audio itself flows peer-to-peer and
// never touches the relay server.
(function () {
  var ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  var Voice = {
    enabled: false, mode: 'ptt', // 'ptt' (hold V) or 'open' (always on)
    localStream: null, localTalking: false,
    peers: {}, // id -> { pc, audioEl, analyser, talking }
    _knownIds: [],

    start: function () {
      if (this.enabled) return Promise.resolve();
      var self = this;
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(function (stream) {
        self.enabled = true; self.localStream = stream;
        self._setLocalEnabled(self.mode === 'open');
        MC.Net.onPeers = function (ids) { self._sync(ids); };
        self._sync(Object.keys(MC.Net.players));
        return true;
      });
    },
    stop: function () {
      this.enabled = false;
      for (var id in this.peers) this._closePeer(id);
      this.peers = {};
      if (this.localStream) { this.localStream.getTracks().forEach(function (t) { t.stop(); }); this.localStream = null; }
      MC.Net.onPeers = null;
    },
    setMode: function (m) { this.mode = m; if (m === 'open') this._setLocalEnabled(true); },
    // called every frame from game.js with whether the push-to-talk key is held
    setTalking: function (held) {
      if (!this.enabled) return;
      var want = this.mode === 'open' ? true : held;
      if (want !== this.localTalking) { this.localTalking = want; this._setLocalEnabled(want); }
    },
    _setLocalEnabled: function (on) {
      if (!this.localStream) return;
      this.localStream.getAudioTracks().forEach(function (t) { t.enabled = on; });
    },

    _sync: function (ids) {
      if (!this.enabled) return;
      var self = this;
      ids.forEach(function (id) { if (!self.peers[id]) self._connectTo(id, MC.Net.selfId > id); });
      Object.keys(this.peers).forEach(function (id) { if (ids.indexOf(id) < 0) self._closePeer(id); });
    },
    // The peer with the "greater" id initiates the offer — avoids both sides racing to offer each other.
    _connectTo: function (id, iOffer) {
      var self = this;
      var pc = new RTCPeerConnection({ iceServers: ICE });
      var entry = { pc: pc, audioEl: null, analyser: null, data: new Uint8Array(64), talking: false, sinceTalk: 0 };
      this.peers[id] = entry;
      if (this.localStream) this.localStream.getTracks().forEach(function (t) { pc.addTrack(t, self.localStream); });
      pc.onicecandidate = function (e) { if (e.candidate) MC.Net.sendSignal(id, { candidate: e.candidate }); };
      pc.ontrack = function (e) {
        var audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = e.streams[0]; audio.volume = 1;
        entry.audioEl = audio;
        try {
          var ctx = MC.Voice._actx || (MC.Voice._actx = new (window.AudioContext || window.webkitAudioContext)());
          var src = ctx.createMediaStreamSource(e.streams[0]); var an = ctx.createAnalyser(); an.fftSize = 128; src.connect(an); entry.analyser = an;
        } catch (err) { }
      };
      if (iOffer) {
        pc.onnegotiationneeded = function () {
          pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () { MC.Net.sendSignal(id, { sdp: pc.localDescription }); }).catch(function () { });
        };
      }
    },
    _onSignal: function (from, data) {
      var self = this;
      if (!this.peers[from]) { if (!this.enabled) return; this._connectTo(from, false); }
      var entry = this.peers[from]; var pc = entry.pc;
      if (data.sdp) {
        pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(function () {
          if (data.sdp.type === 'offer') return pc.createAnswer().then(function (ans) { return pc.setLocalDescription(ans); }).then(function () { MC.Net.sendSignal(from, { sdp: pc.localDescription }); });
        }).catch(function () { });
      } else if (data.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () { });
      }
    },
    _closePeer: function (id) {
      var e = this.peers[id]; if (!e) return;
      try { e.pc.close(); } catch (err) { }
      if (e.audioEl) { e.audioEl.srcObject = null; }
      delete this.peers[id];
    },
    // simple voice-activity check per remote peer, polled once a frame; drives the nametag talk indicator
    tick: function () {
      if (!this.enabled) return;
      for (var id in this.peers) {
        var e = this.peers[id]; if (!e.analyser) continue;
        e.analyser.getByteTimeDomainData(e.data);
        var sum = 0; for (var i = 0; i < e.data.length; i++) { var v = e.data[i] - 128; sum += v * v; }
        var level = Math.sqrt(sum / e.data.length);
        var talking = level > 4;
        if (talking) e.sinceTalk = 0.35; else e.sinceTalk -= 1 / 60;
        e.talking = e.sinceTalk > 0;
        var rp = MC.Net.players[id]; if (rp) rp.setTalking(e.talking);
      }
    }
  };

  MC.Voice = Voice;
})();
