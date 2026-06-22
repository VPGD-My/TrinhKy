import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const NOTIFY_MAILBOX = Deno.env.get("NOTIFY_MAILBOX");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async () => {
  try {
    const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

    // Query records cập nhật trong 24h qua
    const since = new Date();
    since.setDate(since.getDate() - 1);

    const { data, error } = await sb
      .from("records")
      .select("*")
      .gte("updated_at", since.toISOString())
      .order("id");

    if (error) throw error;

    if (!data || data.length === 0) {
      return new Response(JSON.stringify({ message: "Không có data mới" }), {
        status: 200,
      });
    }

    // Gửi email qua Resend
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "onboarding@resend.dev",
        to: [NOTIFY_MAILBOX],
        subject: "[TRINHKY-BACKUP]",
        text: JSON.stringify({ records: data }),
      }),
    });

    const result = await resendResponse.json();

    return new Response(JSON.stringify({ success: true, count: data.length, result }), {
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
    });
  }
});
