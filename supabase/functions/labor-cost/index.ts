// GET /labor-cost?date=YYYY-MM-DD
//
// Narrow, read-only endpoint for external automation to pull a single day's
// labor cost. Returns only { date, totalCost } — no names, no rates, no
// per-shift detail. Auth is a single bearer token (LABOR_READ_TOKEN secret),
// unrelated to any user login or the app's anon/service role keys.
//
// totalCost = gross wages + tips for every shift on `date`. Hours come from
// actual clocked time in `time_entries` when it exists for that shift's
// worker on that day, else the scheduled shift length — mirroring exactly
// what the Payroll tab shows a manager for that day.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shift dates/times are plain local strings with no timezone attached, so
// they need no conversion. Clock-in/out timestamps ARE real UTC instants
// though, so bucketing one into "which calendar day" needs to know the
// store's actual timezone — set to match where the store operates.
const STORE_TZ = "America/New_York";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time string compare, so a mismatched token can't be brute-forced
// via response-time differences.
function timingSafeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function toMin(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function hoursBetween(s: string, e: string) {
  let d = (toMin(e) - toMin(s)) / 60;
  if (d < 0) d += 24;
  return d;
}

// UTC epoch ms for the start/end of `dateStr` (YYYY-MM-DD) as a calendar
// day in `tz`.
function dayBoundsUTC(dateStr: string, tz: string) {
  const probe = new Date(`${dateStr}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(probe);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = asUTC - probe.getTime();
  const start = probe.getTime() - offsetMs;
  return { start, end: start + 86400000 };
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("LABOR_READ_TOKEN");
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!expected || !token || !timingSafeEqual(token, expected)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const date = new URL(req.url).searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    return json({ error: "Query param 'date' is required, format YYYY-MM-DD" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: shifts, error: shiftsErr } = await supabase
    .from("shifts")
    .select("id,user_id,start_time,end_time")
    .eq("date", date);
  if (shiftsErr) {
    console.error("labor-cost: shifts query failed", shiftsErr);
    return json({ error: "Internal error" }, 500);
  }
  if (!shifts || shifts.length === 0) {
    return json({ date, totalCost: 0 });
  }

  const userIds = Array.from(new Set(shifts.map((s) => s.user_id)));
  const shiftIds = shifts.map((s) => s.id);
  const { start: d0, end: d1 } = dayBoundsUTC(date, STORE_TZ);
  const d1Iso = new Date(d1).toISOString();

  const [{ data: rates, error: ratesErr }, { data: entries, error: entriesErr }, { data: pay, error: payErr }] =
    await Promise.all([
      supabase.from("private_pay").select("user_id,rate").in("user_id", userIds),
      supabase
        .from("time_entries")
        .select("user_id,clock_in,clock_out")
        .in("user_id", userIds)
        .lt("clock_in", d1Iso)
        .or(`clock_out.is.null,clock_out.gt.${new Date(d0).toISOString()}`),
      supabase.from("pay").select("shift_id,tips").in("shift_id", shiftIds),
    ]);
  if (ratesErr || entriesErr || payErr) {
    console.error("labor-cost: lookup query failed", ratesErr || entriesErr || payErr);
    return json({ error: "Internal error" }, 500);
  }

  const rateByUser: Record<string, number> = {};
  (rates || []).forEach((r) => { rateByUser[r.user_id] = Number(r.rate) || 0; });
  const tipsByShift: Record<string, number> = {};
  (pay || []).forEach((p) => { tipsByShift[p.shift_id] = Number(p.tips) || 0; });

  let totalCost = 0;
  for (const s of shifts) {
    const rate = rateByUser[s.user_id] || 0;
    const dayEntries = (entries || []).filter((t) => t.user_id === s.user_id);
    let hours: number;
    if (dayEntries.length) {
      const ms = dayEntries.reduce((a, t) => {
        const inMs = new Date(t.clock_in).getTime();
        const outMs = t.clock_out ? new Date(t.clock_out).getTime() : Date.now();
        return a + Math.max(0, Math.min(outMs, d1) - Math.max(inMs, d0));
      }, 0);
      hours = ms / 3600000;
    } else {
      hours = hoursBetween(s.start_time, s.end_time);
    }
    totalCost += hours * rate + (tipsByShift[s.id] || 0);
  }

  return json({ date, totalCost: Math.round(totalCost * 100) / 100 });
});
