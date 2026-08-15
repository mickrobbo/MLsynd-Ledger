// netlify/functions/weekly-xp-topup-scheduled.js
//
// Runs automatically on a schedule (no browser session involved), so it
// uses FIREBASE_DB_SECRET — the same legacy admin-secret auth already used
// by check-lockouts-scheduled.js — which bypasses the normal read/write
// security rules entirely. That's fine here since this function only ever
// touches its own fixed logic (credit 250 XP to every approved member),
// nothing user-supplied.
//
// Deploy: drop this file in netlify/functions/ alongside the existing
// check-lockouts-scheduled.js. No new environment variables needed —
// FIREBASE_DB_SECRET should already be configured from the push
// notification setup. Netlify picks up the schedule from `config` below
// automatically on deploy; nothing else to wire up.

const DB_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const TOP_UP_AMOUNT = 250;

// ISO week key (e.g. "2026-W07") used purely as an idempotency guard — if
// this function somehow fires twice in the same week (Netlify scheduled
// functions can occasionally double-fire, and this also protects against
// an accidental manual re-trigger), the second run sees the same key
// already stored and skips rather than double-paying everyone.
function getISOWeekKey(date){
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export default async () => {
  const SECRET = process.env.FIREBASE_DB_SECRET;
  if(!SECRET){
    return new Response(JSON.stringify({ error: 'FIREBASE_DB_SECRET not configured' }), { status: 500 });
  }

  try{
    const weekKey = getISOWeekKey(new Date());

    const markerRes = await fetch(`${DB_URL}/xp/weeklyTopupLastRun.json?auth=${SECRET}`);
    const lastRun = await markerRes.json();
    if(lastRun === weekKey){
      return new Response(JSON.stringify({ skipped: true, reason: 'already run this week', weekKey }), { status: 200 });
    }

    // "Everyone" here means every approved member with a real linked
    // account (i.e. present in /users with status 'approved') — matches
    // how every other XP-awarding action in this app already scopes
    // "everyone" (e.g. the dues-XP backpay explicitly skips anyone not
    // yet linked, since there's no wallet to credit without a real uid).
    const usersRes = await fetch(`${DB_URL}/users.json?auth=${SECRET}`);
    const users = (await usersRes.json()) || {};

    let creditedCount = 0;
    const creditedUids = [];
    for(const [uid, u] of Object.entries(users)){
      if(!u || u.status !== 'approved') continue;
      try{
        const balRes = await fetch(`${DB_URL}/xp/${uid}/balance.json?auth=${SECRET}`);
        const current = (await balRes.json()) || 0;
        const next = current + TOP_UP_AMOUNT;
        await fetch(`${DB_URL}/xp/${uid}/balance.json?auth=${SECRET}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next)
        });
        await fetch(`${DB_URL}/xp/${uid}/log.json?auth=${SECRET}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: TOP_UP_AMOUNT, reason: 'Weekly XP top-up', balanceAfter: next, ts: Date.now() })
        });
        creditedCount++;
        creditedUids.push(uid);
      }catch(e){ /* skip this one, keep going for everyone else */ }
    }

    await fetch(`${DB_URL}/xp/weeklyTopupLastRun.json?auth=${SECRET}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(weekKey)
    });

    return new Response(JSON.stringify({ ok: true, creditedCount, weekKey, creditedUids }), { status: 200 });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = {
  // Sunday 20:00 UTC = Monday 06:00 AEST (UTC+10, no daylight saving
  // adjustment — matches "AEST" literally as requested). Netlify cron is
  // always in UTC, so if a different Monday hour is wanted, shift this
  // and recompute the UTC equivalent from there.
  schedule: '0 20 * * 0'
};
