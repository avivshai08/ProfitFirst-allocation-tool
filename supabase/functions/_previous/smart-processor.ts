// Previous smart-processor (before 2026-11-18), for rollback only. Reads with the public key,
// so it only works while 03_cutover.sql is not applied.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = "https://wmqgzcxwukyiahsxtupf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtcWd6Y3h3dWt5aWFoc3h0dXBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4Mzg5NzMsImV4cCI6MjA4OTQxNDk3M30.m0B5Qqbsn5cWggotBWLklvKVzAxWKIIMzbMsf0lK7co";
const EMAIL_FN = "https://wmqgzcxwukyiahsxtupf.supabase.co/functions/v1/bright-function";

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6
};

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const now = new Date();
    const todayDay = now.getDay();         // 0=Sun ... 6=Sat
    const todayDate = now.getDate();       // 1-31
    const results: any[] = [];

    // Load all clients with reminders enabled and an email set
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/clients?reminder_enabled=eq.true&email=neq.&select=*",
      { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
    );
    const clients = await res.json();

    for (const client of clients) {
      if (!client.email) continue;

      const freq = client.reminder_frequency || "biweekly";
      const reminderDay = client.reminder_day || "sunday";
      const reminderDates = (client.reminder_dates || "1,15").split(",").map((d: string) => parseInt(d.trim()));

      // Check if today is a reminder day for this client
      let isDue = false;
      if (freq === "weekly" || freq === "biweekly") {
        isDue = todayDay === (DAY_NAMES[reminderDay] ?? 0);
      } else if (freq === "monthly") {
        isDue = reminderDates.includes(todayDate);
      } else if (freq === "twicemonthly") {
        isDue = reminderDates.includes(todayDate);
      }

      if (!isDue) continue;

      // Check if client already made an allocation recently
      // Grace period based on frequency
      const graceDays: Record<string, number> = {
        weekly: 6, biweekly: 13, monthly: 25, twicemonthly: 12
      };
      const grace = graceDays[freq] || 13;
      const cutoff = new Date(now.getTime() - grace * 24 * 60 * 60 * 1000);

      // Check last allocation
      const allocRes = await fetch(
        SUPABASE_URL + "/rest/v1/allocations?client_id=eq." + client.id +
        "&created_at=gt." + cutoff.toISOString() + "&select=id&limit=1",
        { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
      );
      const recentAllocs = await allocRes.json();

      // Skip if they already made an allocation in the grace period
      if (recentAllocs && recentAllocs.length > 0) {
        results.push({ client: client.name, status: "skipped - recent allocation" });
        continue;
      }

      // Send reminder email
      const emailRes = await fetch(EMAIL_FN, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + SUPABASE_KEY
        },
        body: JSON.stringify({
          type: "reminder",
          to: client.email,
          clientName: client.name,
        })
      });

      const emailData = await emailRes.json();

      // Update last_reminder timestamp
      await fetch(
        SUPABASE_URL + "/rest/v1/clients?id=eq." + client.id,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ last_reminder: now.toISOString() })
        }
      );

      results.push({ client: client.name, status: emailRes.ok ? "sent" : "failed", response: emailData });
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
