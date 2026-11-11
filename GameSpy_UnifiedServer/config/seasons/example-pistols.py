"""Example season file: config/seasons/<season>.py

It runs ON TOP OF config/rules.py: everything defined there (K, add, keep_max,
default_columns, official_rank, ...) can be used here, and whatever you define
here replaces the rules.py version for this season only. Usually that is just
total_skill_change().

To use it, put "example-pistols" in config/seasons/current.txt.
"""


def total_skill_change(report, player, row, before):
    # Pistol season: only handgun kills give skill; winning gives a small bonus.
    return 5 * player.key(K.HANDGUN_KILLS) + (2 if player.result == "WIN" else 0)  # noqa: F821 (K comes from rules.py)
