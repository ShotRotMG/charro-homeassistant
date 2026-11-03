# -*- coding: utf-8 -*-
"""Pausing a person's access, run against the real access.py with a fake
Home Assistant auth: the read-only group goes on, their own groups come
back, admins can't be touched, and a pause undone by hand in Settings is
forgotten rather than forced back."""
import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "custom_components", "charro"))
import access  # noqa: E402

fails = 0
count = 0


def ok(c, m):
    global fails, count
    count += 1
    if not c:
        fails += 1
        print("  FAIL " + m)
    else:
        print("  ok   " + m)


class G:
    def __init__(self, gid): self.id = gid


class U:
    def __init__(self, uid, name, groups, owner=False, system=False):
        self.id, self.name, self.is_owner, self.system_generated = uid, name, owner, system
        self.groups = [G(g) for g in groups]
        self.is_active = True

    @property
    def is_admin(self): return self.is_owner or any(g.id == "system-admin" for g in self.groups)


class Auth:
    def __init__(self, users): self.users = {u.id: u for u in users}; self.calls = []
    async def async_get_user(self, uid): return self.users.get(uid)
    async def async_update_user(self, user, group_ids=None):
        self.calls.append((user.id, list(group_ids)))
        user.groups = [G(g) for g in group_ids]


class Hass:
    def __init__(self, users): self.auth = Auth(users)


class FakeStore:
    def __init__(self, data=None): self.data = data; self.saves = 0
    async def async_load(self): return self.data
    async def async_save(self, d): self.data = d; self.saves += 1


async def main():
    jordan = U("j", "Jordan", ["system-users"])
    guest = U("g", "Guest", ["system-read-only"])
    me = U("me", "Javon", ["system-admin"], owner=True)
    dad = U("d", "Dad", ["system-admin"])
    hass = Hass([jordan, guest, me, dad])
    st = FakeStore()
    acc = access.CharroAccess(hass, st)
    await acc.async_load()
    heard = []
    acc.listen(lambda uid, mode: heard.append((uid, mode)))

    print("-- pausing --")
    await acc.async_set("j", "paused")
    ok([g.id for g in jordan.groups] == ["system-read-only"], "a paused person goes read-only")
    ok(acc.mode("j") == "paused", "and reads as paused")
    ok(heard[-1] == ("j", "paused"), "open dashboards are told")
    await acc.async_set("j", "hidden")
    ok(acc.mode("j") == "hidden", "paused can change to hidden")
    ok(st.data["users"]["j"]["groups"] == ["system-users"], "keeping their real group, not read-only")

    print("-- giving it back --")
    await acc.async_set("j", "")
    ok([g.id for g in jordan.groups] == ["system-users"], "back to their own group")
    ok(acc.mode("j") == "", "and normal")
    await acc.async_set("g", "paused")
    await acc.async_set("g", "")
    ok([g.id for g in guest.groups] == ["system-read-only"], "someone read-only to begin with stays read-only")

    print("-- admins --")
    for who in ("me", "d"):
        try:
            await acc.async_set(who, "paused")
            ok(False, f"{who} should be refused")
        except access.AccessError as err:
            ok(str(err) == "admin", f"an admin ({who}) can't be paused")
    ok([g.id for g in dad.groups] == ["system-admin"], "and keeps their group")

    print("-- undone by hand in Settings --")
    await acc.async_set("j", "paused")
    jordan.groups = [G("system-users")]           # someone fixed it in Settings > People
    acc2 = access.CharroAccess(hass, st)
    await acc2.async_load()
    ok(acc2.mode("j") == "", "the pause is forgotten at the next start, not forced back")
    ok([g.id for g in jordan.groups] == ["system-users"], "and their group is left alone")

    try:
        await acc.async_set("j", "banished")
        ok(False, "unknown mode should be refused")
    except access.AccessError as err:
        ok(str(err) == "bad_mode", "an unknown setting is refused")


asyncio.run(main())
print(f"\n{fails} FAILED ({count} assertions)" if fails else f"\nall passed ({count} assertions)")
sys.exit(1 if fails else 0)
