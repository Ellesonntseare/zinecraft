// Keyboard / mouse / pointer-lock input. Exposes injectMouse for the headless harness.
(function () {
  var keys = {}, pressed = {}, released = {};
  var mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, wheel: 0, clicks: [], locked: false, moved: false };
  var textTarget = null; // callback receiving typed characters when a text field is focused (legacy path, kept as a fallback)
  var canvas = null;

  // ---- real (invisible) HTML text input backing the canvas text fields ----
  // Using an actual <input> gets us free, reliable native typing, native
  // copy/paste (no clipboard-permission prompts), IME support, and a mobile
  // on-screen keyboard — none of which a raw keydown listener can guarantee.
  var hiddenInput = null;
  var realInput = null; // { onChange(value), onControl(key) } while a field is focused

  function ensureHiddenInput() {
    if (hiddenInput) return hiddenInput;
    hiddenInput = document.createElement('input');
    hiddenInput.type = 'text';
    hiddenInput.autocomplete = 'off';
    hiddenInput.autocorrect = 'off';
    hiddenInput.autocapitalize = 'off';
    hiddenInput.spellcheck = false;
    hiddenInput.setAttribute('aria-hidden', 'true');
    hiddenInput.setAttribute('tabindex', '-1');
    hiddenInput.style.cssText = 'position:fixed;top:-1000px;left:0;width:1px;height:1px;opacity:0;padding:0;margin:0;border:none;font-size:16px;pointer-events:none;';
    document.body.appendChild(hiddenInput);
    hiddenInput.addEventListener('input', function () {
      if (realInput && realInput.onChange) realInput.onChange(hiddenInput.value);
    });
    hiddenInput.addEventListener('keydown', function (e) {
      if (!realInput) return;
      var key = null;
      if (e.key === 'Enter') key = '\n';
      else if (e.key === 'Escape') key = '\x1b';
      else if (e.key === 'Tab') key = '\t';
      else if (e.key === 'ArrowUp') key = '\x13';
      else if (e.key === 'ArrowDown') key = '\x14';
      if (key) { e.preventDefault(); if (realInput.onControl) realInput.onControl(key); }
      e.stopPropagation(); // don't let WASD etc. leak through to the game while typing
    });
    return hiddenInput;
  }
  // onChange(value) fires on every native edit (typing, paste, IME, autofill).
  // onControl(key) fires for Enter/Escape/Tab/ArrowUp/ArrowDown as the same
  // single-char codes the old keydown path used, so callers don't need to change.
  function focusRealInput(initialValue, onChange, onControl) {
    ensureHiddenInput();
    realInput = { onChange: onChange, onControl: onControl };
    hiddenInput.value = initialValue || '';
    try { hiddenInput.focus({ preventScroll: true }); } catch (e) { hiddenInput.focus(); }
    var len = hiddenInput.value.length;
    try { hiddenInput.setSelectionRange(len, len); } catch (e) { }
  }
  function updateRealInputValue(v) {
    if (!hiddenInput) return;
    hiddenInput.value = v;
    var len = v.length; try { hiddenInput.setSelectionRange(len, len); } catch (e) { }
  }
  function blurRealInput() {
    realInput = null;
    if (hiddenInput) hiddenInput.blur();
  }
  var BIND = {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft',
    inventory: 'KeyE', drop: 'KeyQ', chat: 'KeyT', command: 'Slash', debug: 'F3', hideGui: 'F1', perspective: 'F5', fullscreen: 'F11', swapHands: 'KeyF', pickBlock: 'MouseMiddle'
  };
  function init(cv) {
    canvas = cv;
    window.addEventListener('keydown', function (e) {
      if (e.code === 'F11' || e.code === 'F3' || e.code === 'F1' || e.code === 'F5' || e.code === 'Tab' || e.code === 'Slash' && !textTarget) e.preventDefault();
      if (textTarget) {
        if (e.key === 'Backspace') textTarget('\b'); else if (e.key === 'Enter') textTarget('\n'); else if (e.key === 'Escape') textTarget('\x1b');
        else if (e.key === 'ArrowLeft') textTarget('\x11'); else if (e.key === 'ArrowRight') textTarget('\x12'); else if (e.key === 'ArrowUp') textTarget('\x13'); else if (e.key === 'ArrowDown') textTarget('\x14');
        else if (e.key === 'Tab') textTarget('\t');
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) textTarget(e.key);
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { for (var i = 0; i < t.length; i++) textTarget(t[i]); }).catch(function () { }); }
        if (e.code !== 'Escape' && e.code !== 'F11') { e.preventDefault(); return; }
      }
      if (!keys[e.code]) pressed[e.code] = true;
      keys[e.code] = true;
      if (e.code === 'Space' || (e.code.indexOf('Arrow') === 0)) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.code] = false; released[e.code] = true; });
    window.addEventListener('blur', function () { for (var k in keys) keys[k] = false; mouse.buttons = 0; });
    document.addEventListener('mousemove', function (e) {
      if (mouse.locked) { mouse.dx += e.movementX; mouse.dy += e.movementY; }
      var r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.moved = true;
    });
    document.addEventListener('mousedown', function (e) {
      mouse.buttons |= (1 << e.button);
      var r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
      mouse.clicks.push({ button: e.button, x: mouse.x, y: mouse.y, down: true });
      if (e.button === 1) e.preventDefault();
      // Focus the real hidden input synchronously, inside this actual user
      // gesture, if the click landed on a text field. This is required for
      // mobile browsers to pop up the on-screen keyboard — doing it later
      // (e.g. next animation frame) often doesn't count as a user gesture.
      if (e.button === 0 && MC.activeScreen && MC.Gui) {
        var gx = mouse.x / MC.Gui.S, gy = mouse.y / MC.Gui.S;
        var s = MC.activeScreen, widgets = s.widgets || [];
        for (var i = widgets.length - 1; i >= 0; i--) {
          var w = widgets[i];
          if (w.type === 'field' && w.visible && w.enabled && gx >= w.x && gy >= w.y && gx < w.x + w.w && gy < w.y + w.h) {
            if (s.setFocus) s.setFocus(w);
            break;
          }
        }
      }
    });
    document.addEventListener('mouseup', function (e) { mouse.buttons &= ~(1 << e.button); mouse.clicks.push({ button: e.button, x: mouse.x, y: mouse.y, down: false }); });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('wheel', function (e) { mouse.wheel += e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0); if (mouse.locked) e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerlockchange', function () { mouse.locked = document.pointerLockElement === canvas; if (!mouse.locked) MC.Input.onUnlock && MC.Input.onUnlock(); });
    document.addEventListener('pointerlockerror', function () { mouse.locked = false; });
  }
  function lock() {
    if (!canvas || mouse.locked) return;
    try {
      var p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(function () { try { var q = canvas.requestPointerLock(); if (q && q.catch) q.catch(function () { }); } catch (e) { } });
    } catch (e) { try { var q2 = canvas.requestPointerLock(); if (q2 && q2.catch) q2.catch(function () { }); } catch (e2) { } }
  }
  function unlock() { if (document.exitPointerLock && mouse.locked) document.exitPointerLock(); }
  function down(action) { var code = BIND[action] || action; return !!keys[code]; }
  function wasPressed(action) { var code = BIND[action] || action; return !!pressed[code]; }
  function endFrame() { pressed = {}; released = {}; mouse.dx = 0; mouse.dy = 0; mouse.wheel = 0; mouse.clicks.length = 0; mouse.moved = false; }
  function injectMouse(dx, dy) { mouse.dx += dx; mouse.dy += dy; }
  function setTextTarget(fn) { textTarget = fn; }
  MC.Input = { init: init, lock: lock, unlock: unlock, down: down, pressed: wasPressed, keys: keys, mouse: mouse, endFrame: endFrame, injectMouse: injectMouse, setTextTarget: setTextTarget, BIND: BIND, onUnlock: null,
    focusRealInput: focusRealInput, updateRealInputValue: updateRealInputValue, blurRealInput: blurRealInput,
    get locked() { return mouse.locked; }, simulateLock: false };
})();
