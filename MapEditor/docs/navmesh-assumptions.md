# Navigation map (navmesh) for bots: assumptions

The map editor will build a navigation map per level: where a soldier can stand, walk, crouch or go
prone, plus the jumps, drops and ladder climbs that connect those areas. A bot (any language) loads
the exported JSON and finds routes with A*.

This page lists every assumption the build makes. If a bot gets stuck somewhere, find the rule
here, change it, and rebuild. Values marked **(exe)** were read from `RisingEagle.exe` (the
dedicated servers contain the same values). Values marked **(decided)** were chosen together and
can be changed freely.

## 1. The soldier

| | Value | Source |
|---|---|---|
| Width | 0.8 m (radius 0.4) in every stance | exe, `soldiers.n2` |
| Height standing | 1.8 m | exe, `soldiers.n2` collision shapes |
| Height crouched | 1.35 m | exe, `soldiers.n2` |
| Height prone | 0.8 m (physics is a 0.4 m ball) | exe, `soldiers.n2` |
| Eye height | stand 1.68, crouch 1.08, prone 0.30 m | exe |
| Walk speed | 2.0 m/s (1.8 diagonal); crouch 1.0, prone 0.4 | exe |
| Run / sprint | 3.8 / 6.1 m/s, standing only | exe |
| Gravity | 9.8 m/s² | exe |

The physics engine is MathEngine Karma; the server simulates movement and sends positions back.

## 2. Walking

- **Steepest walkable slope: 45°** (decided). Steeper ground needs a jump.
- **Virtual step: 0.15 m** (decided). A ledge up to 0.15 m is walked over. This absorbs small
  seams where two models meet. The soldier's ball-shaped bottom (radius 0.4) meets a 0.12 m ledge
  at 45°, so this matches the slope rule. Anything higher needs a jump.
- **Headroom:** a spot is standing area if 1.8 m fits above it, crouch area if 1.35 m fits, prone
  area if 0.8 m fits.
- **Walls:** the walkable area keeps 0.4 m (the soldier's radius) away from walls, so gaps narrower
  than 0.8 m are closed.

## 3. Jumps

All jumps are planned at plain **walk speed** with **no steering in the air** (decided), even
though the game allows faster running jumps. Velocities are from the exe; distances are on flat
ground.

| Jump | Allowed from | Up speed | Highest point | Forward speed | Distance |
|---|---|---|---|---|---|
| Normal | stand | 6.0 m/s | 1.84 m | 3.0 m/s | 3.7 m |
| Normal, crouched | crouch | 6.0 m/s | 1.84 m | 1.5 m/s | 1.8 m |
| Power, standing still | stand | 11.2 m/s | 6.4 m | 0 | straight up |
| Power, walking | stand, one direction | 11.2 m/s | 6.4 m | 3.0 m/s | 6.9 m |

- No jumping from prone (exe).
- The power jump needs a full charge, which refills in about **4 s** (exe, `.setaccumulator 3 4.001`).
  A link that needs a power jump is tagged `power`, so the bot can wait for the charge.
- Jumps need standing room (a `walk` or `avoid` area) at take-off and at landing. Crouched
  jumps are not used for links.
- How links are found: from every outer polygon edge, every 1.5 m, the build looks outwards.
  - **Ledge:** walkable ground lower down, 0.8 or 1.4 m past the edge, gives a `drop` down. If it
    is at most 1.6 m lower, it also gives a `jump` back up; at most 6.0 m lower gives a `power`
    jump back up. The way out over the edge and down must be free of geometry, and so must the
    space above the landing spot.
  - **Gap:** if there is no ground just past the edge, the build looks for ground at about the
    same height 1.5 to 3.5 m away, with the line at 1.6 m and at 3.0 m above the feet free of
    geometry. That makes a `jump` (this is also how low walls and fences get jumped over).
- A jump or drop is kept only if it saves walking: when the two polygons are already joined by a
  walking route shorter than 3 × the jump's length + 8 m, there is no link. Links of the same
  kind between the same two polygons are kept at least 4 m apart.

## 4. Drops

- **No fall damage** (decided; the soldiers wear power suits). Any drop to walkable ground is a
  one-way `drop` link, whatever the height.

## 5. Ladders (climbing)

- **Any model part with `.setphmaterial 4` is a ladder** (decided, backed by the exe: touching
  material 4 sets the soldier's "climbing" flag). That covers every ladder model and also
  drainpipes and the antenna mast.
- Holding forward climbs to the top whatever the height. Each material-4 part taller than 1.5 m
  and at most 3 m wide becomes a two-way `climb` link between the walkable ground at its foot and
  the walkable surface at its top (searched within 1.8 m of its centre). Parts with no floor at
  the top (a drainpipe along a wall, for example) get no link.
- Climb speed is not known yet; the bot measures it or assumes walk speed (2.0 m/s).

## 6. What is solid

- The terrain (heightmap).
- Every object with `.setintersection true`, using its visible models (buildings have no separate
  collision models).
- **Not solid:** parts with `.setusephysique false` (tree leaves, twigs, some decorations), and
  objects with `.setintersection false`.
- **Invisible parts** (`.setactive false`, for example the map borders) **are solid**.
- **Breakable objects** (walls, fences) are solid. If one is destroyed in a match, the bot finds
  out at runtime (section 9).
- **Moving parts:** only the flag cloth and turrets that turn towards players. Ignored; turrets are
  solid in their starting pose.

## 7. Areas and costs

Each walkable polygon has a type, and the bot's A* multiplies distance by its cost:

| Area | Meaning | Cost |
|---|---|---|
| `walk` | standing fits | 1 |
| `crouch` | only crouching fits | 2 (half speed) |
| `prone` | only prone fits | 5 (one fifth of the speed) |
| `avoid` | marked by hand in the editor | 10 |

Links: `jump`, `power` (needs a charge), `drop` (one way), `climb`. Their cost is the time they
take in seconds × walk speed, so the comparison with walking is fair.

## 8. Hand edits in the editor

Saved automatically as `output\<level>\<level>.navedits.json` in the editor's folder (the
editor does not write into the game folder), so a rebuild and the next session keep them. The
game never reads them. In the editor: the **Bot navigation** panel on the right adds a marker at
the centre of the view; the gizmo moves it (boxes also scale), and Delete, Duplicate and
Ctrl+Z work as for objects.

- **Ignore box:** geometry inside is left out (for messy models the build gets wrong).
- **Block box:** nothing inside is walkable.
- **Force-walkable box:** the floor inside is walkable even if the build disagrees.
- **Avoid area:** walkable but costly (open ground under fire, for example).
- **Point of interest:** a named spot, exported as a goal (`"type": "poi"`).
- **Manual link:** a jump, power jump, drop or climb drawn by hand from A to B, one-way or two-way.

## 9. What the bot does (outside the editor)

- **Finding itself on the map:** the server's position may be measured at the feet or at the top of
  the body (not known). The bot takes the nearest polygon **below** its position within 2.5 m,
  which works either way. Once known, a fixed offset can replace this.
- **Stuck recovery:** if the bot gets no closer to its next waypoint for about 1 s, it tries, in
  order: a normal jump, a step to the side, then asking for a new route with that piece's cost
  raised. This also covers destroyed or newly blocked paths.
- **Arrival:** a waypoint counts as reached within 0.5 m on the ground.

## 10. Build settings (Recast)

| Setting | Value |
|---|---|
| Cell size (horizontal) | 0.2 m |
| Cell height | 0.05 m (so the 0.15 m step is exactly 3 cells) |
| Agent radius | 0.4 m |
| Agent heights | 1.8 / 1.35 / 0.8 m (stand / crouch / prone, built in turn and merged) |
| Max climb (step) | 0.15 m |
| Max slope | 45° |
| Smallest island kept | 4 m²; smaller connected patches (the tops of stones and tree bases, for example) are dropped |
| Tiles | 128 × 128 cells (25.6 m); built one after another in a worker thread, then merged |

Eiffel (1.5 M triangles) builds in about 22 s: 22,500 polygons and about 4,500 links.

## 11. Export format (`<level>.nav.json`, cross-language)

```json
{
  "version": 1,
  "level": "eiffel",
  "assumptions": { "radius": 0.4, "heights": [1.8, 1.35, 0.8], "maxSlope": 45, "step": 0.15 },
  "vertices": [[x, y, z], ...],
  "polygons": [{ "v": [0, 1, 2, 3], "area": "walk", "neighbours": [5, -1, 12, 7] }, ...],
  "links": [{ "type": "jump", "from": [x, y, z], "to": [x, y, z], "fromPoly": 3, "toPoly": 40,
              "twoWay": false, "cost": 5.2 }, ...],
  "goals": [{ "type": "spawn", "side": 0, "group": 0, "pos": [x, y, z] },
            { "type": "flag", "name": "...", "pos": [x, y, z] }, { "type": "poi", "name": "...", "pos": [x, y, z] }]
}
```

Positions are game coordinates in metres with Y up, the same as in the level script, rounded to
1 cm. `polygons[i].v` are indices into `vertices`; `neighbours` lists, per polygon edge (from
`v[j]` to `v[j+1]`), the polygon across that edge (−1 = wall or ledge). Hand-drawn links carry
`"manual": true`. `assumptions` repeats the numbers on this page. Eiffel's file is about 3 MB.

## Open questions (assumed for now, change when known)

- Where the server's reported position sits on the body (section 9 works around it).
- Climb speed on ladders (section 5).
- Whether every material-4 prop (some trees, for example) is really climbable.
