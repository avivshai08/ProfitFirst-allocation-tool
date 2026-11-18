// Previous bright-function (before 2026-11-18), for rollback only. The Resend key now comes from the RESEND_API_KEY secret.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = "Bottom Line <aviv@bottomline.finance>";

function fmtMoney(n: number): string {
  return "&#8362;" + Math.round(n).toLocaleString("en-US");
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { type, to, clientName, income, results, date } = await req.json();

    let subject = "";
    let html = "";

    if (type === "confirmation") {
      subject = `אישור חלוקה - ${date}`;

      const rows = results.map((r: any) =>
        `<tr>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:right;font-size:13px;">${r.name}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:left;font-size:13px;direction:ltr;">${fmtMoney(Number(r.amount))}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:left;font-size:13px;">${Number(r.pct).toFixed(1)}%</td>
        </tr>`
      ).join("");

      const incomeFormatted = fmtMoney(Number(income));

      html = `
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
          <div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
            <div style="background:#5BC8C0;padding:18px 24px;">
              <h2 style="color:#1A1A1A;margin:0;font-size:18px;">Bottom Line - Profit First</h2>
              <p style="color:#1A1A1A;margin:4px 0 0;font-size:12px;opacity:.7;">אישור חלוקה</p>
            </div>
            <div style="padding:24px;">
              <p style="font-size:14px;color:#333;margin:0 0 6px;">שלום ${clientName},</p>
              <p style="font-size:14px;color:#333;margin:0 0 16px;">החלוקה שלך לתאריך <strong>${date}</strong> נשמרה בהצלחה.</p>
              <div style="background:#E8F8F7;border-radius:8px;padding:10px 14px;margin-bottom:16px;display:inline-block;">
                <span style="font-size:12px;color:#3A9E97;">סך הכנסות:</span>
                <span style="font-size:16px;font-weight:700;color:#1A1A1A;margin-right:8px;direction:ltr;display:inline-block;">${incomeFormatted}</span>
              </div>
              <table style="width:100%;border-collapse:collapse;margin-top:4px;">
                <thead>
                  <tr style="background:#E8F8F7;">
                    <th style="padding:8px 14px;text-align:right;color:#3A9E97;font-size:12px;font-weight:600;">חשבון</th>
                    <th style="padding:8px 14px;text-align:left;color:#3A9E97;font-size:12px;font-weight:600;">סכום</th>
                    <th style="padding:8px 14px;text-align:left;color:#3A9E97;font-size:12px;font-weight:600;">אחוז</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
              <p style="font-size:11px;color:#aaa;margin-top:24px;padding-top:16px;border-top:1px solid #eee;">
                Bottom Line - Adding Value &nbsp;|&nbsp;
                <a href="mailto:aviv@bottomline.finance" style="color:#5BC8C0;text-decoration:none;">aviv@bottomline.finance</a>
              </p>
            </div>
          </div>
        </body>
        </html>`;

    } else if (type === "reminder") {
      subject = "תזכורת - זמן לבצע חלוקה";
      html = `
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
          <div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
            <div style="background:#5BC8C0;padding:18px 24px;">
              <h2 style="color:#1A1A1A;margin:0;font-size:18px;">Bottom Line - Profit First</h2>
            </div>
            <div style="padding:24px;">
              <p style="font-size:14px;color:#333;margin:0 0 12px;">שלום ${clientName},</p>
              <p style="font-size:14px;color:#333;margin:0 0 16px;">הגיע הזמן לבצע את החלוקה שלך!</p>
              <a href="https://app.profitfirst.finance" style="display:inline-block;background:#5BC8C0;color:#1A1A1A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">כניסה לכלי</a>
              <p style="font-size:11px;color:#aaa;margin-top:24px;padding-top:16px;border-top:1px solid #eee;">
                Bottom Line - Adding Value &nbsp;|&nbsp;
                <a href="mailto:aviv@bottomline.finance" style="color:#5BC8C0;text-decoration:none;">aviv@bottomline.finance</a>
              </p>
            </div>
          </div>
        </body>
        </html>`;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: res.ok ? 200 : 400,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});