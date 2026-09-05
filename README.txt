MINECRAFT 1.20.2 (browser recreation)
=====================================

A from-scratch recreation of Minecraft Java Edition in the browser (Three.js + WebGL2).
Every texture, sound, font glyph, HUD sprite and mob skin is generated in code at startup,
so the whole game runs straight from Minecraft.html with no downloads and no server.


HOW TO PLAY
-----------

Double-click Minecraft.html (Chrome or Edge recommended). Nothing to install.
Worlds save to your browser (autosave every minute, on pause and on quit).


CONTROLS (Java Edition defaults)
--------------------------------

Move / jump / sneak / sprint ........... W A S D / Space / Left Shift / Left Ctrl
Mine / place / pick block .............. Left / Right / Middle mouse
Hotbar ................................. 1-9, mouse wheel
Inventory / drop / swap offhand ........ E / Q / F
Chat / command ......................... T / "/"   ("/help" lists the commands)
Hide HUD / debug screen / fullscreen ... F1 / F3 / F11
Fly (creative) ......................... double-tap Space
Push-to-talk (multiplayer voice chat) .. Hold V
Pause .................................. Esc


MULTIPLAYER + VOICE CHAT
-------------------------

From the title screen, click Multiplayer to host a game or join a friend's
by room code. Everyone connects through a small relay server (see
server/README.md to run one locally or deploy it for free on Render).
Once you're in, hold V to talk - you'll see and hear your friends moving
around live in the same world, and now animals/monsters and item drops are
shared too (the host's game simulates them; everyone can fight and loot
them, with hits/pickups round-tripped through the host). See
server/README.md for exactly what "shared" covers and current limits
(e.g. hostile mobs currently only aggro on the host's own player, and TNT
explosions/falling blocks are still simulated per-client).


WHAT IS IN THE GAME
-------------------

- Title screen with a live, rotating cherry-grove panorama, splash text, Options, Language
  and Accessibility screens, Multiplayer/Realms screens, Select World / Create World
  (Game, World, More tabs).
- Infinite procedurally generated world: plains, forest, birch forest, taiga, snowy plains,
  desert, savanna, jungle, swamp, meadow, windswept hills, snowy slopes, cherry grove,
  beaches, rivers and oceans; caves, ores, trees, flowers, tall grass, cactus, sugar cane,
  pumpkins, mushrooms, snow.
- Chunked terrain with sky/block lighting, smooth lighting and ambient occlusion, fog,
  animated water and lava, biome-tinted grass, leaves and water.
- Day/night cycle with sun, moon, stars, sunsets and drifting 3D clouds.
- Survival: health, hunger, saturation, drowning, fall/fire/lava/cactus damage, XP levels,
  death and respawn, tool tiers and mining speeds, block drops, dropped items, crafting
  (2x2 and table), furnace smelting, chests, torches (real light), TNT, falling sand and
  gravel, saplings that grow.
- Creative: tabbed creative inventory (Construction, Equipment, Items, Nature, Search,
  Inventory), instant mining, flying.
- Mobs: pig, cow, sheep (shearable), chicken, zombie, skeleton (shoots arrows), creeper
  (explodes), spider. Natural day/night spawning, daylight burning, drops and XP.
- Sounds: all synthesized (block dig/step per material, UI clicks, hurt, eat, mobs,
  explosions, XP) plus generative ambient music.


Fan recreation for educational purposes. Not affiliated with Mojang or Microsoft.
