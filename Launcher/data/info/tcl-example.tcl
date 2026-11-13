# Created by yonixw, Sep 2025. For extra challenges.

# + load this file with `source home:simple.tcl`

# + Record function, of position into log, go crouch for floor Y level:
proc x {{desc ""}} {
    # Copy this func to gameserver.tcl for ease of use
    set oldCwd2 [psel]
    if {[exists /sys/servers/gameserver] == 1} {
        sel /sys/servers/gameserver/player
        set p3 [.getposition]
        set q4 [.getquat]
        puts "[D] $desc [LOC] $p3 [QUAT] $q4"
    } else {
        puts "/sys/.../gamesever not found, are you in a game?"
    }
    sel $oldCwd2
}

proc turret_enable_docs {} {
    # in mission file (conquest / s&d)
    # {fight_side1 idx} {fight_side2 idx} {fight_side of turret - 0=fight both}
    #   .setfightingsides 1 2 0
    # Make them active
    #   .setdefences true
}

# + Adding turrets: NOT RELIABLE IN RUNTIME! Only in map files "*.n2"
# + Start with high id, like 20+

# + quat = Quaternions and spatial rotation
# + visualise euler/quat:
#   https://ninjacalc.mbedded.ninja/calculators/mathematics/geometry/3d-rotations

# + debug with F11 -> `sel /usr/level/entities`

# === qjz89
# + mblturret turret_small_qjz89 -> t89s
# + mblturret turret_medium_qjz89 -> t89med
# === g36
# + mblturret turret_ceiling_g36 -> t36ceil
# + mblturret turret_stand_g36 -> t36stand
# === m134
# + mblturret turret_large_m134 -> t134l
# === m307
# + mblturret turret_small_m307 -> t307s
# === m230
# + mblturret turret_mobile_m230 -> t230mobile
# + mblturret turret_medium_m230 -> t230med
# + mblturret turret_large_m230 -> t230l
# + mblturret turret_static_m230 -> t230static

proc EXAMPLE_CHANGES_DOC  {id x y z {it_lvl 4} {i 0.000000} {j 0.000000} {k 0.000000} {w 1.000000} {see_r 45.0} {shoot_r 5.0}}  {
    new mblturret "turret_stand_g36?$id"
    sel "turret_stand_g36?$id"

    .setposition $x $y $z
    .setquat $i $j $k $w
    .setentitytype 5
    .setitlevel $it_lvl

    .setgunrange $see_r $see_r
    .setattackradius $shoot_r
}

proc t230static  {id x y z {it_lvl 4} {i 0.000000} {j 0.000000} {k 0.000000} {w 1.000000} {see_r 45.0} {shoot_r 5.0}}  {
    new mblturret "turret_static_m230?$id"
    sel "turret_static_m230?$id"
    .setviewdistance 100
    .setlocalbox 0.000209 -0.320512 0.365803 0.831338 1.138547 0.500607
    .setposition $x $y $z
    .setquat $i $j $k $w
    .setentitytype 5
    .setitlevel $it_lvl
    .setintersection true
    .addhitpoint 0.000000 1.050000 0.000000
    .setturretweapon "m230b2" ""
    .setservospeed 25.000000 5.000000
    .setscansector 360.000000 0.000000
    .setgunrange $see_r $see_r
    .setattackradius $shoot_r
    .setservosounds "weapons/turret_large_start_stop" "weapons/turret_large_search_slow" "weapons/turret_large_start_stop" "weapons/turret_large_search_fast"
    .setidlesleeptime 1.000000
    .addammo 100000
    new nshapenode base
    sel base
    .setviewdistance 100
    .setittransparency 0
    .setlocalbox 0.000209 -0.005649 0.433205 0.831338 0.823684 0.433205
    .setposition 0.000209 0.000000 -0.043088
    .seteuler -90.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:turrets/turret1base_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_static_m230.nvx2"
    .setgroupindex 0
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1base_final.dds"
    .addflipflop 1 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1baseDestroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    .setentityname "turret_static_m230"
    .setinitialhealth 2000.000000
    .setbreakable true
    .settotaldestroy false
    new nshapenode extention
    sel extention
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox 0.000000 0.000000 0.402117 0.481264 0.457710 0.402117
    .setposition -0.002934 -0.043061 0.100518
    .seteuler 0.000007 0.000000 0.000000
    .settexture "DiffMap0" "textures:turrets/turret1base_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setmesh "meshes:turrets/turret_static_m230.nvx2"
    .setgroupindex 1
    .setcastdynamicshadows true
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1base_final.dds"
    .addflipflop 1 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1baseDestroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    sel ..
    new nshapenode tank
    sel tank
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox 0.000000 -0.051334 0.423050 0.584598 0.784708 0.423125
    .setposition -0.000209 -0.042448 0.887693
    .settexture "DiffMap0" "textures:turrets/turret1_final.dds"
    .settexture "DiffMap1" "textures:turrets/turret1Destroyed_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_static_m230.nvx2"
    .setgroupindex 2
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1_final.dds"
    .addflipflop 1 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1Destroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    new nshapenode gun
    sel gun
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox 0.000000 -0.677308 0.000000 0.107063 0.781751 0.134804
    .setposition -0.002546 -0.411466 0.347749
    .seteuler 45.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:turrets/turret1_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_static_m230.nvx2"
    .setgroupindex 3
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1_final.dds"
    .addflipflop 1 "meshes:turrets/turret_static_m230.nvx2" "textures:turrets/turret1Destroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_200r"
    new nshapenode fire1
    sel fire1
    .setdynamic true
    .setittransparency 0
    .setrenderpri 100
    .setlocalbox -0.326353 0.000000 0.000000 0.327029 0.215361 0.213575
    .addanimator "scl1"
    .addanimator "rot"
    .setposition 0.006000 -1.400000 -0.025000
    .seteuler 135.000015 0.000000 90.000000
    .setscale 0.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:misc/flashes/autocanon_TP_flash.dds"
    .setint "CullMode" 1
    .setshader "colr" "shaders:flash_fire.fx"
    .setshapeintersection false
    .setmesh "meshes:misc/flashes/flash_TP_round.nvx2"
    .setgroupindex 0
    .setmaterial "default"
    new ntransformanimator scl1
    sel scl1
    .setdynamic true
    .setchannel "time"
    .setlooptype "oneshot"
    .addscalekey 0.000000 4.700000 4.700000 4.700000
    .addscalekey 0.020000 2.300000 2.300000 2.300000
    .addscalekey 0.021000 2.300000 2.300000 2.300000
    .addscalekey 0.060000 4.200000 4.200000 4.200000
    .addscalekey 0.061000 0.000000 0.000000 0.000000
    .addscalekey 0.070000 0.000000 0.000000 0.000000
    sel ..
    new ntransformanimator rot
    sel rot
    .setdynamic true
    .setchannel "time"
    .setlooptype "loop"
    .addeulerkey 0.000000 45.000000 0.000000 90.000000
    .addeulerkey 0.015000 45.000000 0.000000 90.000000
    .addeulerkey 0.015000 135.000015 0.000000 90.000000
    .addeulerkey 0.030000 135.000015 0.000000 90.000000
    .addeulerkey 0.030000 224.999985 0.000000 90.000000
    .addeulerkey 0.045000 224.999985 0.000000 90.000000
    .addeulerkey 0.045000 315.000000 0.000000 90.000000
    .addeulerkey 0.061000 315.000000 0.000000 90.000000
    .addeulerkey 0.070000 315.000000 0.000000 90.000000
    sel ..
    sel ..
    sel ..
    sel ..
    sel ..
    sel ..
}

proc t230l  {id x y z {it_lvl 4} {i 0.000000} {j 0.000000} {k 0.000000} {w 1.000000} {see_r 50.0} {shoot_r 5.0}}  {
    new mblturret "turret_large_m230?$id"
    sel "turret_large_m230?$id"
    .setviewdistance 100
    .setlocalbox -0.001335 0.001485 0.813887 1.454335 1.454335 1.012933
    .setposition $x $y $z
    .setquat $i $j $k $w
    .setentitytype 5
    .setitlevel $it_lvl
    .setintersection true
    .addhitpoint 0.000000 1.700000 0.000000
    .setturretweapon "m230b2" "m230b2"
    .setservospeed 25.000000 5.000000
    .setscansector 360.000000 0.000000
    .setgunrange $see_r $see_r
    .setattackradius $shoot_r
    .setservosounds "weapons/turret_large_start_stop" "weapons/turret_large_search_slow" "weapons/turret_large_start_stop" "weapons/turret_large_search_fast"
    .setidlesleeptime 1.000000
    .addammo 100000
    new nshapenode base
    sel base
    .setviewdistance 100
    .setittransparency 0
    .setlocalbox -0.001335 0.001485 0.913410 1.454335 1.454335 0.913410
    .setposition 0.010712 0.007306 -0.047610
    .seteuler -90.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:turrets/turret2base_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_large_m230.nvx2"
    .setgroupindex 0
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2base_final.dds"
    .addflipflop 1 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2baseDestroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    .setentityname "turret_large_m230"
    .setinitialhealth 2000.000000
    .setbreakable true
    .settotaldestroy false
    new nshapenode tank
    sel tank
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox -0.002405 0.000632 0.449834 0.671353 0.760929 0.451664
    .setposition -0.001267 0.005076 1.813960
    .settexture "DiffMap0" "textures:turrets/turret2_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_large_m230.nvx2"
    .setgroupindex 1
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2_final.dds"
    .addflipflop 1 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2Destroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    new nshapenode gun
    sel gun
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox 0.000000 -0.061496 0.000000 0.219558 0.260541 0.199046
    .setposition 0.000066 -0.332194 0.325123
    .seteuler 45.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:turrets/turret2_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_large_m230.nvx2"
    .setgroupindex 2
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2_final.dds"
    .addflipflop 1 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2Destroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    new nshapenode fire1
    sel fire1
    .setdynamic true
    .setittransparency 0
    .setrenderpri 100
    .setlocalbox -0.326353 0.000000 0.000000 0.327029 0.215361 0.213575
    .addanimator "scl1"
    .addanimator "rot"
    .setposition -0.085000 -1.150000 0.005000
    .seteuler 224.999985 0.000000 90.000000
    .setscale 0.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:misc/flashes/autocanon_TP_flash.dds"
    .setint "CullMode" 1
    .setshader "colr" "shaders:flash_fire.fx"
    .setshapeintersection false
    .setmesh "meshes:misc/flashes/flash_TP_round.nvx2"
    .setgroupindex 0
    .setmaterial "default"
    new ntransformanimator scl1
    sel scl1
    .setdynamic true
    .setchannel "time"
    .setlooptype "oneshot"
    .addscalekey 0.000000 4.000000 4.000000 4.000000
    .addscalekey 0.020000 2.300000 2.300000 2.300000
    .addscalekey 0.021000 2.300000 2.300000 2.300000
    .addscalekey 0.060000 4.000000 4.000000 4.000000
    .addscalekey 0.061000 0.000000 0.000000 0.000000
    .addscalekey 0.070000 0.000000 0.000000 0.000000
    sel ..
    new ntransformanimator rot
    sel rot
    .setdynamic true
    .setchannel "time"
    .setlooptype "loop"
    .addeulerkey 0.000000 45.000000 0.000000 90.000000
    .addeulerkey 0.015000 45.000000 0.000000 90.000000
    .addeulerkey 0.015000 135.000015 0.000000 90.000000
    .addeulerkey 0.030000 135.000015 0.000000 90.000000
    .addeulerkey 0.030000 224.999985 0.000000 90.000000
    .addeulerkey 0.045000 224.999985 0.000000 90.000000
    .addeulerkey 0.045000 315.000000 0.000000 90.000000
    .addeulerkey 0.061000 315.000000 0.000000 90.000000
    .addeulerkey 0.070000 315.000000 0.000000 90.000000
    sel ..
    sel ..
    new nshapenode fire2
    sel fire2
    .setdynamic true
    .setittransparency 0
    .setrenderpri 100
    .setlocalbox -0.326353 0.000000 0.000000 0.327029 0.215361 0.213575
    .addanimator "scl2"
    .addanimator "rot"
    .setposition 0.095000 -1.150000 0.005000
    .seteuler 224.999985 0.000000 90.000000
    .setscale 0.000000 0.000000 0.000000
    .settexture "DiffMap0" "textures:misc/flashes/autocanon_TP_flash.dds"
    .setint "CullMode" 1
    .setshader "colr" "shaders:flash_fire.fx"
    .setshapeintersection false
    .setmesh "meshes:misc/flashes/flash_TP_round.nvx2"
    .setgroupindex 0
    .setmaterial "default"
    new ntransformanimator scl2
    sel scl2
    .setdynamic true
    .setchannel "time"
    .setlooptype "oneshot"
    .addscalekey 0.000000 4.000000 4.000000 4.000000
    .addscalekey 0.020000 2.300000 2.300000 2.300000
    .addscalekey 0.021000 2.300000 2.300000 2.300000
    .addscalekey 0.060000 4.000000 4.000000 4.000000
    .addscalekey 0.061000 0.000000 0.000000 0.000000
    .addscalekey 0.070000 0.000000 0.000000 0.000000
    sel ..
    new ntransformanimator rot
    sel rot
    .setdynamic true
    .setchannel "time"
    .setlooptype "loop"
    .addeulerkey 0.000000 45.000000 0.000000 90.000000
    .addeulerkey 0.015000 45.000000 0.000000 90.000000
    .addeulerkey 0.015000 135.000015 0.000000 90.000000
    .addeulerkey 0.030000 135.000015 0.000000 90.000000
    .addeulerkey 0.030000 224.999985 0.000000 90.000000
    .addeulerkey 0.045000 224.999985 0.000000 90.000000
    .addeulerkey 0.045000 315.000000 0.000000 90.000000
    .addeulerkey 0.061000 315.000000 0.000000 90.000000
    .addeulerkey 0.070000 315.000000 0.000000 90.000000
    sel ..
    sel ..
    new nshapenode mobile2
    sel mobile2
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox 0.089048 -0.760570 0.005050 0.038965 0.443890 0.040854
    .addanimator "rot2"
    .setposition 0.000000 0.002719 0.000000
    .settexture "DiffMap0" "textures:turrets/turret2_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_large_m230.nvx2"
    .setgroupindex 3
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2_final.dds"
    .addflipflop 1 "meshes:turrets/turret_large_m230.nvx2" "textures:turrets/turret2Destroyed_final.dds"
    .endflipflopset
    .setmaterial "Metal_heavy"
    new ntransformanimator rot2
    sel rot2
    .setdynamic true
    .setchannel "time"
    .setlooptype "oneshot"
    .addposkey 0.000000 0.000000 0.002230 0.000000
    .addposkey 0.100000 0.000000 0.100000 0.000000
    .addposkey 0.300000 0.000000 0.002230 0.000000
    sel ..
    sel ..
    new nshapenode mobile1
    sel mobile1
    .setviewdistance 100
    .setdynamic true
    .setittransparency 0
    .setlocalbox -0.081270 -0.760570 0.005049 0.038964 0.443891 0.040854
    .addanimator "rot1"
    .setposition 0.000000 0.002719 0.000000
    .settexture "DiffMap0" "textures:turrets/turret2_final.dds"
    .setint "CullMode" 2
    .setshader "colr" "shaders:default.fx"
    .setshader "flh1" "shaders:default_breakflsh1.fx"
    .setmesh "meshes:turrets/turret_large_m230.nvx2"
    .setgroupindex 4
    .setcastdynamicshadows true
    .setbatchtype 0
    .setbatchenable false
    .beginflipflopset 2
    .addflipflop 0 "meshes:turrets/turret_large_m230.nvx2"
